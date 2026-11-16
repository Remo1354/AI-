import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析：不覆盖已存在的环境变量，避免引入额外依赖。 */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};
const list = (v: string | undefined) =>
  (v || '').split(',').map((s) => s.trim()).filter(Boolean);

function build() {
  const dataDir = path.resolve(ROOT, process.env.DATA_DIR || './data');
  return {
    env: process.env.NODE_ENV || 'development',
    host: process.env.HOST || '127.0.0.1',
    port: num(process.env.PORT, 8787),
    dataDir,
    dbPath: path.join(dataDir, 'remo.sqlite'),
    uploadDir: path.join(dataDir, 'uploads'),
    webDist: path.join(ROOT, 'dist', 'web'),
    appPassword: process.env.APP_PASSWORD || '',
    appSecret: process.env.APP_SECRET || '',
    maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 40) * 1024 * 1024,
    ai: {
      maxTokens: num(process.env.AI_MAX_TOKENS, 32000),
      contextChars: num(process.env.AI_CONTEXT_CHARS, 60000),
      anthropicKey: process.env.ANTHROPIC_API_KEY || '',
      anthropicModels: list(process.env.ANTHROPIC_MODELS),
      openaiKey: process.env.OPENAI_API_KEY || '',
      openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      openaiModels: list(process.env.OPENAI_MODELS),
    },
  };
}

export let config = build();

/** 测试用：修改环境变量后重新读取配置。 */
export function reloadConfig() {
  config = build();
  return config;
}

export function ensureDataDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
}
