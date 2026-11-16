import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { all, closeDb, exec, get, now, openDb, run } from '../db';
import { config, ensureDataDirs } from '../config';
import { badRequest } from './http';

export const BACKUP_APP = 'remo-ai-learning-platform';
export const BACKUP_FORMAT = 1;

const COUNT_TABLES = [
  'conversations', 'messages', 'documents', 'knowledge_items', 'plans', 'tasks', 'study_logs', 'reviews',
  'research_projects', 'research_sources', 'research_reports', 'content_topics', 'content_refs',
];

export function dataCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) out[t] = get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
  return out;
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((n, f) => {
    const st = fs.statSync(path.join(dir, f));
    return n + (st.isFile() ? st.size : 0);
  }, 0);
}

export function dataInfo() {
  openDb();
  return {
    data_dir: config.dataDir,
    db_bytes: fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath).size : 0,
    uploads_bytes: dirSize(config.uploadDir),
    uploads_count: fs.existsSync(config.uploadDir) ? fs.readdirSync(config.uploadDir).length : 0,
    counts: dataCounts(),
  };
}

/**
 * 生成完整备份包（zip）：数据库一致性快照 + 全部上传文件 + manifest。
 * 备份里不包含任何 API Key —— 恢复到新机器后需要在设置页重新填写。
 */
export function createBackup(): { zip: Uint8Array; filename: string; manifest: Record<string, unknown> } {
  openDb();
  ensureDataDirs();
  const tmp = path.join(config.dataDir, `.export-${Date.now()}.sqlite`);
  try {
    exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(tmp);
    copy.exec("UPDATE providers SET api_key_enc = ''");
    copy.close();

    const manifest = {
      app: BACKUP_APP, format: BACKUP_FORMAT, created_at: now(), counts: dataCounts(),
      migrations: all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name').map((r) => r.name),
      note: '备份不包含 API Key。恢复后请在「设置 → 模型」重新填写。',
    };
    const files: Zippable = {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'remo.sqlite': [new Uint8Array(fs.readFileSync(tmp)), { level: 6 }],
    };
    if (fs.existsSync(config.uploadDir)) {
      for (const f of fs.readdirSync(config.uploadDir)) {
        const full = path.join(config.uploadDir, f);
        // 上传文件多为 PDF / 图片，本身已压缩，直接存储
        if (fs.statSync(full).isFile()) files[`uploads/${f}`] = [new Uint8Array(fs.readFileSync(full)), { level: 0 }];
      }
    }
    const stamp = now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return { zip: zipSync(files), filename: `remo-backup-${stamp}.zip`, manifest };
  } finally {
    for (const f of [tmp, `${tmp}-journal`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

/**
 * 从备份包恢复。恢复前把当前数据库和上传目录改名保留（*.before-restore-时间戳），
 * 所以这个操作可以手动回退。
 */
export function restoreBackup(buf: Uint8Array) {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf);
  } catch {
    throw badRequest('无法读取这个文件，它不是有效的备份包（zip）。');
  }
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(strFromU8(entries['manifest.json']));
  } catch {
    throw badRequest('备份包里没有 manifest.json，这不是本平台导出的备份。');
  }
  if (manifest.app !== BACKUP_APP || !entries['remo.sqlite']) throw badRequest('这不是 Remo AI Learning Platform 的备份包。');
  if (Number(manifest.format) > BACKUP_FORMAT) throw badRequest('这个备份来自更新版本的平台，请先升级程序再恢复。');

  ensureDataDirs();
  const stamp = Date.now();
  const staged = path.join(config.dataDir, `.restore-${stamp}.sqlite`);
  fs.writeFileSync(staged, entries['remo.sqlite']);
  try {
    const probe = new DatabaseSync(staged);
    probe.prepare('SELECT COUNT(*) FROM schema_migrations').get();
    probe.close();
  } catch {
    fs.unlinkSync(staged);
    throw badRequest('备份包中的数据库文件已损坏，无法恢复。');
  }

  // 同一台机器上恢复时，保留当前已填写的 API Key（备份里没有）
  openDb();
  const keys = all<{ id: string; api_key_enc: string }>("SELECT id, api_key_enc FROM providers WHERE api_key_enc != ''");
  closeDb();

  const keep = (p: string) => { if (fs.existsSync(p)) fs.renameSync(p, `${p}.before-restore-${stamp}`); };
  keep(config.dbPath);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(config.dbPath + ext); } catch { /* ignore */ } }
  keep(config.uploadDir);
  fs.renameSync(staged, config.dbPath);
  fs.mkdirSync(config.uploadDir, { recursive: true });
  let files = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (!name.startsWith('uploads/') || name.endsWith('/')) continue;
    const base = path.basename(name); // 只取文件名，防止路径穿越
    if (!base || base.startsWith('.')) continue;
    fs.writeFileSync(path.join(config.uploadDir, base), data);
    files++;
  }

  openDb(); // 重新打开并执行尚未应用的迁移（兼容旧版本备份）
  for (const k of keys) run("UPDATE providers SET api_key_enc = ? WHERE id = ? AND api_key_enc = ''", k.api_key_enc, k.id);
  return { restored_at: now(), files, counts: dataCounts(), backup_created_at: manifest.created_at, kept_suffix: `.before-restore-${stamp}` };
}
