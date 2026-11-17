import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDataDirs } from '../config';

let cachedKey: Buffer | null = null;

/** 主密钥：优先 APP_SECRET；否则在数据目录生成并持久化一个随机密钥。 */
function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  let secret = config.appSecret;
  if (!secret) {
    ensureDataDirs();
    const file = path.join(config.dataDir, 'secret.key');
    if (fs.existsSync(file)) {
      secret = fs.readFileSync(file, 'utf8').trim();
    } else {
      secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
    }
  }
  cachedKey = crypto.createHash('sha256').update(secret).digest();
  return cachedKey;
}

export function resetKeyCache() {
  cachedKey = null;
}

export function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** 解密失败（例如换了主密钥）时返回空串，由上层提示重新填写。 */
export function decrypt(enc: string): string {
  if (!enc) return '';
  try {
    const [v, iv, tag, data] = enc.split(':');
    if (v !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── 可选的访问密码：无状态签名 Cookie ─────────────────────────
const SESSION_DAYS = 30;

function sign(payload: string) {
  return crypto.createHmac('sha256', masterKey()).update(`session:${config.appPassword}:${payload}`).digest('base64url');
}

export function issueSession(): string {
  const exp = String(Date.now() + SESSION_DAYS * 86400_000);
  return `${exp}.${sign(exp)}`;
}

export function verifySession(token: string | undefined): boolean {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function passwordMatches(input: string): boolean {
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(config.appPassword).digest();
  return crypto.timingSafeEqual(a, b);
}
