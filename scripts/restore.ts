// 命令行恢复：npm run restore -- <备份文件.zip> [--yes]
// 会替换当前全部数据；原数据改名保留为 *.before-restore-<时间戳>。恢复前请先停止正在运行的服务。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';

process.emitWarning = () => {};
const { config } = await import('../server/config');
const { restoreBackup } = await import('../server/lib/backup');
const { closeDb } = await import('../server/db');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file || !fs.existsSync(file)) {
  console.error('用法：npm run restore -- <备份文件.zip> [--yes]');
  process.exit(1);
}

const running = await new Promise<boolean>((resolve) => {
  const s = net.connect({ port: config.port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
if (running) {
  console.error(`端口 ${config.port} 上有服务正在运行。请先停止平台（在它的终端按 Ctrl+C），再执行恢复；或者直接在网页「设置 → 数据」里恢复。`);
  process.exit(1);
}

if (!args.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`将用 ${path.basename(file)} 替换 ${config.dataDir} 中的全部数据（原数据会改名保留）。输入 yes 继续：`);
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('已取消。');
    process.exit(0);
  }
}

try {
  const result = restoreBackup(new Uint8Array(fs.readFileSync(file)));
  closeDb();
  console.log(`\n恢复完成。备份时间 ${result.backup_created_at}，恢复了 ${result.files} 个上传文件。`);
  console.log(`知识条目 ${result.counts.knowledge_items} · 资料 ${result.counts.documents} · 对话 ${result.counts.conversations}`);
  console.log(`原数据保留为 ${config.dataDir} 下带 ${result.kept_suffix} 后缀的文件，确认无误后可以删除。`);
  console.log('API Key 不在备份中：启动后请到「设置 → 模型」确认或重新填写。\n');
} catch (err) {
  console.error(`恢复失败：${(err as Error).message}`);
  process.exit(1);
}
