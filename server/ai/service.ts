import { insert, newId, now } from '../db';
import { resolveModel, type Resolved } from './registry';
import { AiError, type ChatEvent, type ChatMessage } from './types';

export interface CallOptions {
  modelRef?: string | null;
  system?: string;
  messages: ChatMessage[];
  purpose: string;          // chat | summarize | plan | research | studio | test …
  refId?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  resolved?: Resolved;      // 测试连接时直接传入临时适配器
}

function logCall(r: Resolved, o: CallOptions, started: number, status: string, usage: { in?: number; out?: number }, error?: string) {
  try {
    insert('ai_calls', {
      id: newId('call'), provider_id: r.provider.id, provider_name: r.provider.name, model: r.model,
      purpose: o.purpose, ref_id: o.refId ?? null, status, error: error ?? null,
      input_tokens: usage.in ?? null, output_tokens: usage.out ?? null,
      duration_ms: Date.now() - started, created_at: now(),
    });
  } catch { /* 记录失败不影响主流程 */ }
}

/** 流式调用。所有 AI 请求都从这里经过，统一记录调用日志。 */
export async function* streamChat(o: CallOptions): AsyncGenerator<ChatEvent & { modelRef?: string }> {
  const r = o.resolved ?? resolveModel(o.modelRef);
  const started = Date.now();
  const usage: { in?: number; out?: number } = {};
  let logged = false;
  const log = (status: string, error?: string) => {
    if (logged) return;
    logged = true;
    logCall(r, o, started, status, usage, error);
  };
  try {
    for await (const ev of r.adapter.stream({
      model: r.model, system: o.system, messages: o.messages, maxTokens: o.maxTokens, signal: o.signal,
    })) {
      if (ev.type === 'end') {
        usage.in = ev.inputTokens;
        usage.out = ev.outputTokens;
        log('ok');
        yield { ...ev, modelRef: r.ref };
      } else {
        yield ev;
      }
    }
    log('ok');
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError('provider', (err as Error).message || '调用模型失败');
    log(e.code === 'aborted' ? 'aborted' : 'error', e.message);
    throw e;
  } finally {
    // 调用方提前中断（例如用户点了停止）时生成器被 return，不会进入 catch
    log('aborted');
  }
}

export interface Completion { text: string; modelRef: string; stopReason?: string; inputTokens?: number; outputTokens?: number }

export async function complete(o: CallOptions): Promise<Completion> {
  let text = '';
  let end: Partial<Completion> = {};
  for await (const ev of streamChat(o)) {
    if (ev.type === 'text') text += ev.text;
    else if (ev.type === 'end') {
      end = { modelRef: ev.modelRef, stopReason: ev.stopReason, inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
    }
  }
  if (end.stopReason === 'refusal') {
    throw new AiError('provider', '模型出于安全策略拒绝了这次请求，可以换一种问法或换一个模型再试。', 422);
  }
  if (!text.trim()) throw new AiError('invalid_output', '模型没有返回内容，请重试或换一个模型。', 502);
  return { text, modelRef: end.modelRef || '', ...end };
}

/** 从模型输出中稳健地取出 JSON：容忍 ```json 围栏和前后说明文字。 */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const s = c.trim();
    const start = Math.min(...['{', '['].map((ch) => { const i = s.indexOf(ch); return i < 0 ? Infinity : i; }));
    if (!Number.isFinite(start)) continue;
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (end <= start) continue;
    try { return JSON.parse(s.slice(start, end + 1)) as T; } catch { /* try next */ }
  }
  throw new AiError('invalid_output', '模型返回的内容不是有效的结构化数据，请重试。', 502);
}

export async function completeJson<T = unknown>(o: CallOptions): Promise<{ data: T; modelRef: string }> {
  const res = await complete(o);
  return { data: extractJson<T>(res.text), modelRef: res.modelRef };
}
