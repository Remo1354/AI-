#!/usr/bin/env bash
# 启动平台。
#   ./scripts/start.sh          正式运行：单进程提供 API + 页面（http://127.0.0.1:8787）
#   ./scripts/start.sh --dev    开发模式：后端自动重启 + 前端热更新（http://127.0.0.1:5173）
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ] || [ ! -f .env ]; then
  echo "首次运行，先执行初始化…"
  ./scripts/bootstrap.sh
fi

node scripts/doctor.mjs --quiet || { echo "环境检查未通过，请先解决上面的问题。"; exit 1; }

if [ "${1:-}" = "--dev" ]; then
  exec node scripts/dev.mjs
fi
exec node scripts/run-prod.mjs
