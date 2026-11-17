#!/usr/bin/env bash
# 云端 / macOS / Linux 一键初始化：检查环境 → 准备 .env → 安装依赖 → 自检 → 构建前端。
# 可重复执行。新的云端会话里运行一次即可恢复到可开发、可运行的状态。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Remo AI Workspace · 初始化 =="

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没有找到 Node.js。需要 22.13 或更高版本。"
  echo "  安装方式（任选其一）："
  echo "    nvm:     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
  echo "    macOS:   brew install node@22"
  echo "    官网:    https://nodejs.org"
  exit 1
fi

NODE_OK=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>22||(a===22&&b>=13)?"yes":"no")')
if [ "$NODE_OK" != "yes" ]; then
  echo "✗ 当前 Node.js $(node -v) 版本过低，需要 22.13 或更高（平台使用 Node 内置的 SQLite）。"
  echo "  升级： nvm install 22   或从 https://nodejs.org 下载"
  exit 1
fi
echo "✓ Node.js $(node -v)"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ 已从 .env.example 创建 .env（默认仅本机访问，无需修改即可运行）"
else
  echo "✓ .env 已存在，保持不变"
fi

echo "→ 安装依赖…"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

echo "→ 构建前端…"
npm run build --silent

node scripts/doctor.mjs

cat <<'EOF'
下一步：
  启动平台     ./scripts/start.sh            然后打开 http://127.0.0.1:8787
  开发模式     ./scripts/start.sh --dev      前端热更新，访问 http://127.0.0.1:5173
  运行测试     npm run check
  备份数据     npm run backup
继续开发前请先读 CLAUDE.md 和 progress.md。
EOF
