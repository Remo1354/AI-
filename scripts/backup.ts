// 命令行备份：npm run backup [-- 输出目录]
// 生成一个 zip（数据库快照 + 上传文件 + manifest），不包含 API Key。服务运行中也可以安全执行。
import fs from 'node:fs';
import path from 'node:path';

process.emitWarning = () => {};
const { ROOT } = await import('../server/config');
const { createBackup } = await import('../server/lib/backup');
const { closeDb } = await import('../server/db');

const outDir = path.resolve(ROOT, process.argv[2] || 'backups');
fs.mkdirSync(outDir, { recursive: true });
const { zip, filename, manifest } = createBackup();
const file = path.join(outDir, filename);
fs.writeFileSync(file, zip);
closeDb();

const counts = manifest.counts as Record<string, number>;
console.log(`\n备份完成：${file}`);
console.log(`大小 ${(zip.length / 1048576).toFixed(2)} MB · 知识条目 ${counts.knowledge_items} · 资料 ${counts.documents} · 对话 ${counts.conversations} · 学习记录 ${counts.study_logs}`);
console.log('备份不包含 API Key。把这个文件保存到云盘或另一台电脑，即可在任何地方恢复：npm run restore -- <备份文件>\n');
