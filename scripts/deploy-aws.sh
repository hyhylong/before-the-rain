#!/usr/bin/env bash
set -euo pipefail

export AWS_PAGER=''
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-1}}"
APP_NAME="${APP_NAME:-before-the-rain}"
ECR_REPOSITORY="${ECR_REPOSITORY:-${APP_NAME}}"
NODE_IMAGE="${NODE_IMAGE:-public.ecr.aws/docker/library/node:22-bookworm-slim}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { printf '%s\n' "$*" >&2; exit 1; }
for dependency in aws docker git node; do
  command -v "$dependency" >/dev/null 2>&1 || fail "Missing command: $dependency"
done
[[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,61}[a-z0-9]$ ]] || fail 'APP_NAME must be 4-63 lowercase letters, digits or hyphens, starting with a letter and ending with a letter or digit.'
[[ -f Dockerfile ]] || fail 'This checkout must contain the production Dockerfile.'
[[ -z "$(git status --porcelain)" ]] || fail 'Commit the changes being submitted before deployment.'
docker info >/dev/null

printf 'Checking AWS identity in %s...\n' "$AWS_REGION"
ACCOUNT_ID="$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)"
[[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail 'AWS did not return a valid account ID.'
IMAGE_TAG="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
[[ "$AWS_REGION" == cn-* ]] && REGISTRY="${REGISTRY}.cn"
IMAGE_URI="${REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"

# Registry tokens and API responses remain outside the checkout and are removed on exit.
DEPLOY_TEMP="$(mktemp -d)"
export DOCKER_CONFIG="${DEPLOY_TEMP}/docker"
mkdir -p "$DOCKER_CONFIG"
cleanup() {
  docker logout "$REGISTRY" >/dev/null 2>&1 || true
  node --input-type=module - "$DEPLOY_TEMP" <<'JS' || true
import { unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
for (const name of ['service.json', 'service-error', 'summary.json', 'created-service.json', 'updated-service.json', 'ecr-error', 'existing-policy.json', 'policy-error', 'pull-policy.json', 'applied-policy.json', 'deployment.json', 'deployment-result.json', 'docker/config.json', 'docker/.token_seed']) {
  try { unlinkSync(join(root, name)); } catch (error) { if (error.code !== 'ENOENT') console.error(`Could not remove temporary ${name}: ${error.code}`); }
}
for (const directory of ['docker', '']) {
  try { rmdirSync(join(root, directory)); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) console.error(`Could not remove temporary directory: ${error.code}`); }
}
JS
}
trap cleanup EXIT

read_service() {
  if aws lightsail get-container-services --region "$AWS_REGION" --service-name "$APP_NAME" --output json >"${DEPLOY_TEMP}/service.json" 2>"${DEPLOY_TEMP}/service-error"; then
    :
  else
    local service_error
    service_error="$(<"${DEPLOY_TEMP}/service-error")"
    case "$service_error" in
      *NotFoundException*) node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({containerServices: []}))' "${DEPLOY_TEMP}/service.json" ;;
      *) fail "$service_error" ;;
    esac
  fi
  node --input-type=module - "${DEPLOY_TEMP}/service.json" "${DEPLOY_TEMP}/summary.json" "$APP_NAME" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output, name] = process.argv.slice(2);
const service = JSON.parse(readFileSync(input, 'utf8')).containerServices?.[0];
if (service && !service.tags?.some((tag) => tag.key === 'Project' && tag.value === name)) throw new Error(`Refusing to modify ${name}: its Project tag does not match.`);
const image = (deployment) => deployment?.containers?.mira?.image;
writeFileSync(output, JSON.stringify({ exists: !!service, disabled: !!service?.isDisabled, state: service?.state, roleActive: !!service?.privateRegistryAccess?.ecrImagePullerRole?.isActive, principalArn: service?.privateRegistryAccess?.ecrImagePullerRole?.principalArn || '', url: service?.url || '', currentVersion: service?.currentDeployment?.version, currentState: service?.currentDeployment?.state, currentImage: image(service?.currentDeployment), nextVersion: service?.nextDeployment?.version, nextState: service?.nextDeployment?.state, nextImage: image(service?.nextDeployment) }));
JS
}

service_field() {
  node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (value !== undefined && value !== null) console.log(value);' "${DEPLOY_TEMP}/summary.json" "$1"
}

read_service
if [[ "$(service_field exists)" != true ]]; then
  printf 'Creating Lightsail container service %s (nano, one node)...\n' "$APP_NAME"
  aws lightsail create-container-service --region "$AWS_REGION" --service-name "$APP_NAME" --power nano --scale 1 --tags "key=Project,value=$APP_NAME" --private-registry-access '{"ecrImagePullerRole":{"isActive":true}}' --output json >"${DEPLOY_TEMP}/created-service.json"
elif [[ "$(service_field roleActive)" != true || "$(service_field disabled)" == true ]]; then
  printf 'Enabling private ECR access for the existing project service...\n'
  aws lightsail update-container-service --region "$AWS_REGION" --service-name "$APP_NAME" --no-is-disabled --private-registry-access '{"ecrImagePullerRole":{"isActive":true}}' --output json >"${DEPLOY_TEMP}/updated-service.json"
else
  printf 'Using the existing project service without changing its power or node count.\n'
fi

PRINCIPAL_ARN=''
for ((attempt = 0; attempt < 120; attempt++)); do
  read_service
  PRINCIPAL_ARN="$(service_field principalArn)"
  [[ "$PRINCIPAL_ARN" == arn:* && "$(service_field roleActive)" == true ]] && break
  [[ "$(service_field state)" != DELETING ]] || fail 'The project service is being deleted.'
  sleep 5
done
[[ "$PRINCIPAL_ARN" == arn:* && "$(service_field roleActive)" == true ]] || fail 'Lightsail did not activate its ECR image-puller role within ten minutes.'

if REPOSITORY_ARN="$(aws ecr describe-repositories --region "$AWS_REGION" --repository-names "$ECR_REPOSITORY" --query 'repositories[0].repositoryArn' --output text 2>"${DEPLOY_TEMP}/ecr-error")"; then
  printf 'Using ECR repository %s.\n' "$ECR_REPOSITORY"
else
  ECR_ERROR="$(<"${DEPLOY_TEMP}/ecr-error")"
  case "$ECR_ERROR" in
    *RepositoryNotFoundException*) REPOSITORY_ARN="$(aws ecr create-repository --region "$AWS_REGION" --repository-name "$ECR_REPOSITORY" --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true --tags "Key=Project,Value=$APP_NAME" --query 'repository.repositoryArn' --output text)" ;;
    *) fail "$ECR_ERROR" ;;
  esac
fi

printf 'Building %s for linux/amd64...\n' "$IMAGE_URI"
if docker buildx version >/dev/null 2>&1; then
  docker buildx build --platform linux/amd64 --load --provenance=false --build-arg "NODE_IMAGE=$NODE_IMAGE" --tag "$IMAGE_URI" .
else
  DOCKER_BUILDKIT=0 docker build --platform linux/amd64 --build-arg "NODE_IMAGE=$NODE_IMAGE" --tag "$IMAGE_URI" .
fi
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker push "$IMAGE_URI"

if aws ecr get-repository-policy --region "$AWS_REGION" --repository-name "$ECR_REPOSITORY" --output json >"${DEPLOY_TEMP}/existing-policy.json" 2>"${DEPLOY_TEMP}/policy-error"; then
  :
else
  POLICY_ERROR="$(<"${DEPLOY_TEMP}/policy-error")"
  case "$POLICY_ERROR" in
    *RepositoryPolicyNotFoundException*) node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({}))' "${DEPLOY_TEMP}/existing-policy.json" ;;
    *) fail "$POLICY_ERROR" ;;
  esac
fi
node --input-type=module - "${DEPLOY_TEMP}/existing-policy.json" "${DEPLOY_TEMP}/pull-policy.json" "$PRINCIPAL_ARN" "$APP_NAME" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output, principalArn, name] = process.argv.slice(2);
const response = JSON.parse(readFileSync(input, 'utf8'));
const policy = response.policyText ? JSON.parse(response.policyText) : { Version: '2012-10-17' };
const statements = Array.isArray(policy.Statement) ? policy.Statement : policy.Statement ? [policy.Statement] : [];
const sid = `LightsailImagePuller${name.replaceAll('-', '')}`;
policy.Statement = statements.filter((statement) => statement.Sid !== sid);
policy.Statement.push({ Sid: sid, Effect: 'Allow', Principal: { AWS: principalArn }, Action: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'] });
writeFileSync(output, JSON.stringify(policy));
JS
aws ecr set-repository-policy --region "$AWS_REGION" --repository-name "$ECR_REPOSITORY" --policy-text "file://${DEPLOY_TEMP}/pull-policy.json" --output json >"${DEPLOY_TEMP}/applied-policy.json"

node --input-type=module - "${DEPLOY_TEMP}/deployment.json" "$APP_NAME" "$IMAGE_URI" <<'JS'
import { existsSync, writeFileSync } from 'node:fs';
const [output, serviceName, image] = process.argv.slice(2);
if (existsSync('.env')) process.loadEnvFile('.env');
const textEnvironment = {};
for (const name of ['SCENE_API_KEY', 'SCENE_API_BASE_URL', 'SCENE_MODEL', 'SCENE_THINKING', 'SCENE_TIMEOUT_MS']) {
  if (process.env[name]) textEnvironment[name] = process.env[name];
}
writeFileSync(output, JSON.stringify({ serviceName, containers: { mira: { image, environment: { ...textEnvironment, NODE_ENV: 'production', PORT: '8080', SCENE_DATA_DIR: '/app/.data/sessions' }, ports: { '8080': 'HTTP' } } }, publicEndpoint: { containerName: 'mira', containerPort: 8080, healthCheck: { healthyThreshold: 2, unhealthyThreshold: 5, timeoutSeconds: 5, intervalSeconds: 10, path: '/api/health', successCodes: '200' } } }));
JS
printf 'Deploying the image to Lightsail...\n'
aws lightsail create-container-service-deployment --region "$AWS_REGION" --cli-input-json "file://${DEPLOY_TEMP}/deployment.json" --output json >"${DEPLOY_TEMP}/deployment-result.json"
DEPLOYMENT_VERSION="$(node --input-type=module - "${DEPLOY_TEMP}/deployment-result.json" "$IMAGE_URI" <<'JS'
import { readFileSync } from 'node:fs';
const service = JSON.parse(readFileSync(process.argv[2], 'utf8')).containerService;
const deployments = [service?.currentDeployment, service?.nextDeployment].filter((deployment) => deployment?.containers?.mira?.image === process.argv[3]);
const version = Math.max(...deployments.map((deployment) => deployment.version));
if (!Number.isInteger(version) || version < 1) throw new Error('Lightsail did not return the new deployment version.');
console.log(version);
JS
)"

write_metadata() {
  node --input-type=module - "${DEPLOY_TEMP}/summary.json" "$AWS_REGION" "$APP_NAME" "$ECR_REPOSITORY" "$REPOSITORY_ARN" "$IMAGE_URI" "$DEPLOYMENT_VERSION" <<'JS'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [input, region, serviceName, repositoryName, repositoryArn, imageUri, version] = process.argv.slice(2);
const summary = JSON.parse(readFileSync(input, 'utf8'));
if (!summary.url.startsWith('https://')) throw new Error('Lightsail did not return an HTTPS endpoint.');
mkdirSync('.deployment', { recursive: true });
writeFileSync('.deployment/aws.json', `${JSON.stringify({ provider: 'lightsail', region, serviceName, repositoryName, repositoryArn, imageUri, deploymentVersion: Number(version), serviceUrl: summary.url, deployedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
JS
}

read_service
write_metadata
DEPLOYMENT_ACTIVE=false
for ((attempt = 0; attempt < 90; attempt++)); do
  read_service
  CURRENT_VERSION="$(service_field currentVersion)"
  NEXT_VERSION="$(service_field nextVersion)"
  if [[ "$CURRENT_VERSION" == "$DEPLOYMENT_VERSION" && "$(service_field currentState)" == ACTIVE && "$(service_field currentImage)" == "$IMAGE_URI" ]]; then
    DEPLOYMENT_ACTIVE=true
    break
  fi
  if [[ "$NEXT_VERSION" == "$DEPLOYMENT_VERSION" && "$(service_field nextState)" == FAILED ]] || [[ "$CURRENT_VERSION" == "$DEPLOYMENT_VERSION" && "$(service_field currentState)" == FAILED ]]; then
    fail 'The Lightsail deployment failed. Inspect its container logs and .deployment/aws.json.'
  fi
  if (( ${CURRENT_VERSION:-0} > DEPLOYMENT_VERSION || ${NEXT_VERSION:-0} > DEPLOYMENT_VERSION )); then
    fail 'A newer deployment replaced this operation; inspect .deployment/aws.json before retrying.'
  fi
  sleep 10
done
[[ "$DEPLOYMENT_ACTIVE" == true ]] || fail 'The deployment did not become ACTIVE within fifteen minutes; inspect .deployment/aws.json and the service logs.'
write_metadata
SERVICE_URL="$(service_field url)"
node --input-type=module - "$SERVICE_URL" <<'JS'
const url = new URL('/api/health', process.argv[2]);
let lastError;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok || (await response.json()).ok !== true) throw new Error(`Health check HTTP ${response.status}`);
    console.log(`HTTPS health check passed: ${url.origin}`);
    process.exit(0);
  } catch (error) { lastError = error; }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
throw new Error(`Public health check failed: ${lastError?.message}. Deployment metadata is in .deployment/aws.json.`);
JS
printf '\nDemo: %s\nDeployment metadata: %s/.deployment/aws.json\n' "$SERVICE_URL" "$ROOT_DIR"
