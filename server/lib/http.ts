import type { Context } from 'hono';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = '内容') => new HttpError(404, 'not_found', `${what}不存在或已被删除`);
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

export async function readJson(c: Context): Promise<Record<string, any>> {
  try {
    const data = await c.req.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function requireText(value: unknown, label: string, max = 500): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw badRequest(`请填写${label}`);
  if (s.length > max) throw badRequest(`${label}过长（最多 ${max} 字）`);
  return s;
}

/** 从 body 里挑出允许的字段，字符串化并裁剪，undefined 保持 undefined。 */
export function pick(body: Record<string, any>, fields: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = body[f];
    if (v === undefined) continue;
    if (v === null) out[f] = null;
    else if (typeof v === 'object') out[f] = JSON.stringify(v);
    else out[f] = v;
  }
  return out;
}

export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 本地日期 YYYY-MM-DD（服务端时区）。前端通常会显式传 date。 */
export function today(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
