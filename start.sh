#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22 || major===22 && minor>=12 ? 0 : 1)'; then
  printf 'Node.js 22.12 or later is required.\n' >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  npm ci
fi
exec npm start
