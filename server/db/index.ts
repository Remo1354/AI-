import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDirs } from '../config';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

type Param = string | number | bigint | null | Uint8Array;
let db: DatabaseSync | null = null;

function norm(v: unknown): Param {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

export function openDb() {
  if (db) return db;
  ensureDataDirs();
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function closeDb() {
  if (db) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ignore */ }
    db.close();
    db = null;
  }
}

function migrate(d: DatabaseSync) {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (d.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    d.exec('BEGIN');
    try {
      d.exec(sql);
      d.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, now());
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw new Error(`数据库迁移失败 ${file}: ${(err as Error).message}`);
    }
  }
}

export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return openDb().prepare(sql).all(...params.map(norm)) as T[];
}
export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return openDb().prepare(sql).get(...params.map(norm)) as T | undefined;
}
export function run(sql: string, ...params: unknown[]) {
  return openDb().prepare(sql).run(...params.map(norm));
}
export function exec(sql: string) {
  openDb().exec(sql);
}

let depth = 0;
export function tx<T>(fn: () => T): T {
  const d = openDb();
  if (depth > 0) return fn();
  d.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export const now = () => new Date().toISOString();

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export function newId(prefix = ''): string {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 32];
  return prefix ? `${prefix}_${s}` : s;
}

/** INSERT 一行，自动忽略 undefined 字段。 */
export function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  run(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => row[k]),
  );
}

/** 只更新 allowed 中出现且 patch 里提供了的字段。返回是否有更新。 */
export function update(
  table: string,
  id: string,
  patch: Record<string, unknown>,
  allowed: readonly string[],
  extra: Record<string, unknown> = {},
) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k]);
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return false;
  run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  return true;
}

export function getSetting<T = unknown>(key: string, fallback: T): T {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}
export function setSetting(key: string, value: unknown) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}
