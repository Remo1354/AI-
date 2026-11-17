#!/usr/bin/env node
// 正式运行：一个进程同时提供 API 和已构建的前端页面。前端缺失或过期时先自动构建。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (p) => path.join(ROOT, 'node_modules', p);

if (!fs.existsSync(bin('tsx/dist/cli.mjs'))) {
  console.error('依赖尚未安装。请先运行 scripts/bootstrap.sh（Windows: scripts\\bootstrap.ps1）。');
  process.exit(1);
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

const index = path.join(ROOT, 'dist', 'web', 'index.html');
const stale = !fs.existsSync(index) || newestMtime(path.join(ROOT, 'web')) > fs.statSync(index).mtimeMs;
if (stale && !process.argv.includes('--no-build')) {
  console.log('正在构建前端页面…');
  const built = spawnSync(process.execPath, [bin('vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('前端构建失败，请查看上面的错误信息。');
    process.exit(built.status ?? 1);
  }
}

const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
