// node:sqlite 在 Node 22 中仍标记为实验特性，屏蔽这一条提示，其余警告照常输出。
const originalEmit = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (text && text.includes('SQLite is an experimental feature')) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

export {};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`需要 Node.js 22.13 或更高版本（当前 ${process.versions.node}）。请运行 scripts/bootstrap 检查环境。`);
  process.exit(1);
}

const { serve } = await import('@hono/node-server');
const { config } = await import('./config');
const { createApp } = await import('./app');
const { closeDb } = await import('./db');
const { listModelOptions } = await import('./ai/registry');
const { startAutoBackup } = await import('./lib/backup');

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (!loopback && !config.appPassword && !config.allowInsecure) {
  console.error(`\n拒绝启动：HOST=${config.host} 会让其他设备访问到这个服务，但没有设置访问密码。`);
  console.error('请在 .env（或部署环境变量）里设置 APP_PASSWORD 后重试。');
  console.error('只有在可信的内网里确实不需要密码时，才设置 ALLOW_NO_PASSWORD=1 跳过这项检查。\n');
  process.exit(1);
}

const app = createApp();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  const models = listModelOptions().length;
  console.log('');
  console.log('  Remo AI Workspace');
  console.log(`  ➜ 服务地址   http://${shown}:${info.port}`);
  console.log(`  ➜ 数据目录   ${config.dataDir}`);
  console.log(`  ➜ AI 模型    ${models ? `已配置 ${models} 个` : '尚未配置（打开「设置 → 模型」添加）'}`);
  console.log(`  ➜ 访问密码   ${config.appPassword ? '已启用' : '未启用'}`);
  if (!loopback && !config.appPassword) {
    console.log('  ⚠ 当前允许非本机访问且没有访问密码（ALLOW_NO_PASSWORD=1）：任何能访问这个地址的人都能使用你的数据和 API Key。');
  }
  if (config.autoBackupHours > 0) console.log(`  ➜ 自动备份   每 ${config.autoBackupHours} 小时，保留 ${config.autoBackupKeep} 份`);
  if (config.env !== 'production') console.log('  ➜ 开发模式：前端请访问 http://127.0.0.1:5173');
  console.log('');
});

startAutoBackup();

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用。请关闭占用它的程序，或在 .env 中把 PORT 改成其他值。`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

const shutdown = () => {
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
