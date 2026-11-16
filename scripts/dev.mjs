#!/usr/bin/env node
// 开发模式：同时启动后端（tsx watch，改动自动重启）和前端（Vite，热更新）。跨平台，不依赖 shell。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (p) => path.join(ROOT, 'node_modules', p);

const procs = [
  spawn(process.execPath, [bin('tsx/dist/cli.mjs'), 'watch', '--clear-screen=false', 'server/index.ts'], { cwd: ROOT, stdio: 'inherit' }),
  spawn(process.execPath, [bin('vite/bin/vite.js')], { cwd: ROOT, stdio: 'inherit' }),
];

let closing = false;
const stop = (code = 0) => {
  if (closing) return;
  closing = true;
  for (const p of procs) if (!p.killed) p.kill();
  setTimeout(() => process.exit(code), 300);
};
for (const p of procs) p.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
