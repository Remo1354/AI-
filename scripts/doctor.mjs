#!/usr/bin/env node
// 环境自检：跨平台，不依赖任何 npm 包（在 npm install 之前也能运行）。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
let failed = 0;
let warned = 0;

const ok = (m) => { if (!quiet) console.log(`  ✓ ${m}`); };
const warn = (m, hint) => { warned++; console.log(`  ! ${m}${hint ? `\n      → ${hint}` : ''}`); };
const fail = (m, hint) => { failed++; console.log(`  ✗ ${m}${hint ? `\n      → ${hint}` : ''}`); };
const sh = (cmd) => { try { return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

function readEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

console.log(`\nRemo AI Learning Platform · 环境检查（${os.platform()} ${os.arch()}）\n`);

// 1. Node.js
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 13)) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node} 版本过低，需要 22.13 或更高`, 'Windows: winget install OpenJS.NodeJS.LTS    macOS/Linux: https://nodejs.org 或 nvm install 22');

// 2. npm
const npmV = sh('npm --version');
if (npmV) ok(`npm ${npmV}`); else fail('找不到 npm', '重新安装 Node.js（安装包自带 npm）');

// 3. 内置 SQLite 与中文全文检索
try {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  const { DatabaseSync } = await import('node:sqlite');
  process.emitWarning = emit;
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram'); INSERT INTO t VALUES ('印象派的色彩理论');");
  const hit = db.prepare(`SELECT COUNT(*) AS n FROM t WHERE t MATCH '"印象派"'`).get();
  const version = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close();
  if (hit.n === 1) ok(`内置 SQLite ${version}，中文全文检索可用`);
  else fail('SQLite 全文检索自检未通过');
} catch (err) {
  fail(`内置 SQLite 不可用：${err.message}`, '请升级到 Node.js 22.13 以上的官方发行版');
}

// 4. 依赖
const deps = ['hono', '@anthropic-ai/sdk', 'unpdf', 'mammoth', 'react', 'vite', 'tsx'];
const missing = deps.filter((d) => !fs.existsSync(path.join(ROOT, 'node_modules', d)));
if (!missing.length) ok('依赖已安装');
else fail(`依赖未安装（缺少 ${missing.join(', ')}）`, '运行 scripts/bootstrap.sh（Windows: scripts\\bootstrap.ps1）或 npm install');

// 5. 配置与数据目录
const env = readEnv();
if (fs.existsSync(path.join(ROOT, '.env'))) ok('.env 已存在');
else warn('.env 不存在，将使用默认配置', '运行 bootstrap 脚本会自动从 .env.example 复制一份');

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || env.DATA_DIR || './data');
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, `.write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  const db = path.join(dataDir, 'remo.sqlite');
  ok(`数据目录可写：${dataDir}${fs.existsSync(db) ? `（数据库 ${(fs.statSync(db).size / 1048576).toFixed(1)} MB）` : '（尚无数据库，首次启动时创建）'}`);
} catch (err) {
  fail(`数据目录不可写：${dataDir}（${err.message}）`, '在 .env 中把 DATA_DIR 改到一个有写权限的位置');
}

// 6. 前端构建
if (fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) ok('前端已构建（dist/web）');
else warn('前端尚未构建', 'start 脚本会在启动前自动构建；也可以手动运行 npm run build');

// 7. 端口
const port = Number(process.env.PORT || env.PORT || 8787);
await new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => { warn(`端口 ${port} 正在被占用（如果是本平台已在运行，可以忽略）`, '或在 .env 中修改 PORT'); resolve(); });
  srv.once('listening', () => srv.close(() => { ok(`端口 ${port} 可用`); resolve(); }));
  srv.listen(port, '127.0.0.1');
});

// 8. 安全配置
const host = process.env.HOST || env.HOST || '127.0.0.1';
const password = process.env.APP_PASSWORD || env.APP_PASSWORD || '';
if (!['127.0.0.1', 'localhost'].includes(host) && !password) {
  fail(`HOST=${host} 允许非本机访问，但没有设置 APP_PASSWORD`, '在 .env 中设置 APP_PASSWORD，否则任何能访问该地址的人都能使用你的数据和 API Key');
} else ok(host === '127.0.0.1' || host === 'localhost' ? '仅本机可访问' : '已启用访问密码');

// 9. Git 与远程备份
if (sh('git rev-parse --is-inside-work-tree') === 'true') {
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  const remote = sh('git remote get-url origin');
  const dirty = sh('git status --porcelain');
  ok(`Git 分支 ${branch}${remote ? `，远程 ${remote.replace(/\/\/[^@/]+@/, '//')}` : ''}`);
  if (!remote) warn('没有配置远程仓库，代码只存在于本机', 'git remote add origin <你的仓库地址>');
  if (dirty) warn(`有 ${dirty.split('\n').length} 个文件尚未提交`, 'git add -A && git commit -m "..." && git push');
  if (sh('git check-ignore data') === null) fail('data/ 没有被 .gitignore 忽略，个人数据可能被提交', '检查 .gitignore');
} else {
  warn('当前目录不是 Git 仓库', 'git init 并关联远程仓库，代码才有版本记录和远程备份');
}

// 10. 云端临时环境提醒
const ephemeral = !!(process.env.CLAUDE_CODE_REMOTE || process.env.CODESPACES || process.env.GITPOD_WORKSPACE_ID);
if (ephemeral) {
  console.log('\n  ※ 检测到云端开发环境：这里的磁盘是临时的。');
  console.log('    · 代码：只有 git push 到远程仓库的内容会保留。');
  console.log('    · 数据：data/ 目录不会保留。需要保留时运行 npm run backup 并下载 backups/ 里的备份包。');
}

console.log('');
if (failed) {
  console.log(`检查未通过：${failed} 个问题需要先解决${warned ? `，另有 ${warned} 个提醒` : ''}。\n`);
  process.exit(1);
}
console.log(warned ? `可以运行，有 ${warned} 个提醒。\n` : '一切就绪。\n');
