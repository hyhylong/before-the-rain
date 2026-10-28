# AWS 新加坡部署

部署包含前端、Express API、原创角色、中文语音及剧情视频。使用 AWS Lightsail 容器服务的公开 HTTPS 地址，满足远程浏览器请求麦克风所需的安全上下文；浏览器识别服务和用户授权仍由设备决定。

## 本次发布

- 演示地址：[Before the Rain](https://before-the-rain.nk7ygsy23jcxm.ap-southeast-1.cs.amazonlightsail.com/)。
- 2026-10-28 实际发布到新加坡 `ap-southeast-1`，服务为 `before-the-rain`，当前部署版本 2 已为 `ACTIVE`。
- 当前运行镜像标签为 `ea88e140c99a-20261028T123245Z`。公开提交仅整理交付记录与文档，应用代码与已发布版本一致。
- 已配置服务端 DeepSeek `deepseek-flash`，从公网 HTTPS 请求 `/api/health` 返回 `ok: true` 和 `liveAvailable: true`；完整与流式实际对话均通过，未配置独立 STT/TTS 服务。
- 公开源码：[hyhylong/before-the-rain](https://github.com/hyhylong/before-the-rain)。

## 账号与工具

- AWS CLI、Docker、Git、Node.js 22.12+。
- 使用已登录的 AWS profile 或临时凭证。可用 `aws sts get-caller-identity --region ap-southeast-1` 检查账号；不要将访问密钥放入仓库。
- 部署身份需要操作 ECR 仓库、仓库读取策略和 Lightsail 容器服务。Lightsail 创建其镜像拉取角色，仓库策略只授权该服务读取镜像；应用本身不接收 AWS 管理凭证。
- 默认地区为新加坡 `ap-southeast-1`，服务名为 `before-the-rain`。

## 部署

先提交本次发布的源码，再运行：

```bash
./scripts/deploy-aws.sh
```

有命名 profile 时：

```bash
AWS_PROFILE=your-profile ./scripts/deploy-aws.sh
```

脚本验证账号，创建或复用私有 ECR 仓库及本项目的 Lightsail 容器服务，以提交 SHA 和 UTC 时间生成镜像标签，构建并推送 `linux/amd64` 镜像，再创建容器部署。镜像使用官方 ECR Public Node 22 基础镜像，可通过 `NODE_IMAGE` 覆盖。

服务配置为 nano 规格、0.25 vCPU、512 MB、单节点、端口 8080，健康检查路径为 `/api/health`。发布过程最后检查公开 HTTPS 健康接口，并显示演示地址；部署信息写入被 Git 忽略的 `.deployment/aws.json`，不包含密钥。

可以用 `APP_NAME`、`ECR_REPOSITORY` 或 `AWS_REGION` 覆盖默认值。ECR 登录信息只保存在临时 Docker 配置目录，脚本退出后清理。脚本不会将本机 `.env`、认证目录、会话数据或录屏打进镜像。

默认 Mock 模式无需模型或语音供应商凭证。需要 DeepSeek 文本对话时，先在被 Git 忽略的 `.env` 中填写 `SCENE_API_KEY`、`SCENE_API_BASE_URL=https://api.deepseek.com`、`SCENE_MODEL=deepseek-flash`、`SCENE_THINKING=disabled`，或设置同名环境变量，再发布。没有真实密钥时不会启用实时模型。

脚本仅允许上述文本设置及 `SCENE_TIMEOUT_MS` 进入 Lightsail 的服务端容器环境；不会透传本机 AWS/GitHub 等其他凭证。包含环境变量的临时部署请求位于本机私有临时目录，退出后清理，公开部署元数据不含密钥，Docker 镜像也不包含 `.env`。拥有该服务管理权限的 AWS 身份可以读取容器环境，因此服务管理权限应仅授予可信身份。语音与媒体供应商仍单独配置，不要将凭证写进 Dockerfile 或 GitHub 仓库。

## 本地验证镜像

```bash
docker build --platform linux/amd64 -t before-the-rain:local .
docker run --rm --name before-the-rain-local -p 4178:8080 before-the-rain:local
```

浏览器打开 `http://localhost:4178`。镜像以非 root 用户运行，包含生产构建和所有运行时素材；视频支持 Range 请求，VAD 模型与 WASM 同源加载。

## 存储与费用

Lightsail 容器使用临时磁盘。一次会话内保持状态，实例重启、替换或重新部署后，服务端恢复记录和媒体缓存可能丢失；单节点配置也不承诺磁盘持久性。作业演示可导出浏览器会话。需要跨实例或跨部署恢复时，应将服务端会话和媒体迁移到外部持久存储。

2026-10-28 查询新加坡地区 API 返回 nano 单节点月度标价为 7 美元，另有 ECR 存储等费用；实际按 AWS 账单与账号优惠结算。评审结束后可删除服务停止后续运行费用。

## 清理

评审结束后，先删除容器服务：

```bash
aws lightsail delete-container-service --region ap-southeast-1 --service-name before-the-rain
```

通过 `aws lightsail get-container-services --region ap-southeast-1` 确认服务已删除，且不再需要发布镜像后，删除本项目 ECR 仓库：

```bash
aws ecr delete-repository --region ap-southeast-1 --repository-name before-the-rain --force
```

使用了自定义名称时替换上述名称；已有其他项目共用的仓库不应删除。

## 作业提交

提交 GitHub 仓库地址、脚本输出的 HTTPS 演示地址，以及仓库中的 `artifacts/demo.mp4`。录屏为 4 分 35 秒，涵盖连续文字互动、角色状态与剧情视频、说话中打断、断线反馈和重试。`README.md` 包含本地一条命令启动、架构、协议、第三方来源、取舍、已知限制与后续计划；AI 参与和实际验证边界见 `AI_USAGE.md`。

源码仓库已公开，评审无需账号即可查看；主分支提供最终源码与文档。公网演示默认保留 Mock 剧情和本地中文声音，设置中的“实时连接”使用服务端 DeepSeek。
