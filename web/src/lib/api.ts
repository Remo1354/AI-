/** 前端与后端之间唯一的通道。前端不持有任何 API Key，也不直接访问模型服务。 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  get aiNotConfigured() {
    return this.code === 'ai_not_configured';
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    if (res.status === 401 && data?.error?.code === 'unauthorized') onUnauthorized?.();
    throw new ApiError(res.status, data?.error?.code || 'http_error', data?.error?.message || `请求失败（${res.status}）`);
  }
  return data as T;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', '无法连接到服务。请确认平台正在运行。');
  }
  return parse<T>(res);
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T = any>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
  async upload<T = any>(url: string, fields: Record<string, string | Blob | undefined | null>): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') form.append(k, v);
    let res: Response;
    try {
      res = await fetch(`/api${url}`, { method: 'POST', body: form, credentials: 'same-origin' });
    } catch {
      throw new ApiError(0, 'network', '上传失败：无法连接到服务。');
    }
    return parse<T>(res);
  },
};

export const qs = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

export interface ChatHandlers {
  onMeta?: (meta: any) => void;
  onDelta: (text: string) => void;
  onThinking?: () => void;
  onDone: (message: any) => void;
  onError: (err: { code: string; message: string; message_record?: any }) => void;
}

/** 发送消息并读取 SSE 流。返回前即开始回调；用 signal 中止即可停止生成。 */
export async function streamChat(conversationId: string, body: Record<string, unknown>, handlers: ChatHandlers, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, credentials: 'same-origin',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    return handlers.onError({ code: 'network', message: '无法连接到服务。请确认平台正在运行。' });
  }
  if (!res.ok || !res.body) {
    try { await parse(res); } catch (err) {
      const e = err as ApiError;
      return handlers.onError({ code: e.code, message: e.message });
    }
    return handlers.onError({ code: 'http_error', message: '服务没有返回内容' });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  const handle = (block: string) => {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    if (!event || !data) return;
    let json: any;
    try { json = JSON.parse(data); } catch { return; }
    if (event === 'meta') handlers.onMeta?.(json);
    else if (event === 'delta') handlers.onDelta(json.text);
    else if (event === 'thinking') handlers.onThinking?.();
    else if (event === 'done') { finished = true; handlers.onDone(json.message); }
    else if (event === 'error') { finished = true; handlers.onError(json); }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        handle(buffer.slice(0, i));
        buffer = buffer.slice(i + 2);
      }
    }
    if (buffer.trim()) handle(buffer);
    if (!finished && !signal.aborted) handlers.onError({ code: 'network', message: '连接中断，回复可能不完整。' });
  } catch (err) {
    if ((err as Error).name !== 'AbortError' && !signal.aborted) handlers.onError({ code: 'network', message: '连接中断，回复可能不完整。' });
  }
}
