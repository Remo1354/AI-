import { AiError, type ChatRequest, type ChatEvent, type ModelAdapter } from '../types';

/**
 * OpenAI Chat Completions 兼容协议。
 * 覆盖 OpenAI、DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、Ollama 等服务。
 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

async function failure(res: Response): Promise<AiError> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || j?.error || text;
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch { detail = text; }
  } catch { /* ignore */ }
  detail = detail.slice(0, 300);
  const s = res.status;
  if (s === 401 || s === 403) return new AiError('auth', `API Key 无效或没有权限（${s}）。${detail}`, s);
  if (s === 404) return new AiError('model_not_found', `接口或模型不存在（404），请检查 Base URL 和模型 ID。${detail}`, 404);
  if (s === 429) return new AiError('rate_limit', `请求过于频繁或额度不足（429）。${detail}`, 429);
  if (s === 400 || s === 422) return new AiError('bad_request', `请求被模型服务拒绝（${s}）：${detail}`, 400);
  return new AiError('provider', `模型服务出错（${s}）：${detail}`, 502);
}

export function createOpenAICompatibleAdapter(opts: {
  apiKey: string;
  baseUrl: string;
  maxTokens?: number | null;
}): ModelAdapter {
  const base = normalizeBaseUrl(opts.baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new AiError('aborted', '已停止生成', 499);
      throw new AiError('network', `无法连接到模型服务（${base}）。请检查网络和 Base URL。`, 502);
    }
  }

  return {
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      const body: Record<string, unknown> = {
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          ...req.messages,
        ],
      };
      const maxTokens = req.maxTokens ?? opts.maxTokens;
      if (maxTokens) body.max_tokens = maxTokens;

      let res = await post(body, req.signal);
      if (res.status === 400 || res.status === 422) {
        // 个别兼容服务不认识 stream_options，去掉后重试一次。
        const { stream_options: _omit, ...rest } = body;
        const retry = await post(rest, req.signal);
        if (retry.ok) res = retry;
        else throw await failure(retry);
      }
      if (!res.ok) throw await failure(res);
      if (!res.body) throw new AiError('provider', '模型服务没有返回内容', 502);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let stopReason: string | undefined;
      let thinkingAnnounced = false;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let json: any;
            try { json = JSON.parse(data); } catch { continue; }
            if (json.error) {
              throw new AiError('provider', `模型服务出错：${json.error.message || JSON.stringify(json.error)}`.slice(0, 300), 502);
            }
            if (json.usage) {
              inputTokens = json.usage.prompt_tokens ?? inputTokens;
              outputTokens = json.usage.completion_tokens ?? outputTokens;
            }
            const choice = json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if ((delta.reasoning_content || delta.reasoning) && !thinkingAnnounced) {
              thinkingAnnounced = true;
              yield { type: 'thinking' };
            }
            if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
            if (choice.finish_reason) stopReason = choice.finish_reason;
          }
        }
      } catch (err) {
        if (err instanceof AiError) throw err;
        if ((err as Error).name === 'AbortError') throw new AiError('aborted', '已停止生成', 499);
        throw new AiError('network', `与模型服务的连接中断：${(err as Error).message}`, 502);
      }
      yield { type: 'end', inputTokens, outputTokens, stopReason: stopReason === 'length' ? 'max_tokens' : stopReason };
    },

    async listModels() {
      let res: Response;
      try {
        res = await fetch(`${base}/models`, { headers });
      } catch {
        throw new AiError('network', `无法连接到模型服务（${base}）。请检查网络和 Base URL。`, 502);
      }
      if (!res.ok) throw await failure(res);
      const json: any = await res.json().catch(() => ({}));
      const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      return list.map((m: any) => String(m.id || m.name || '')).filter(Boolean).sort();
    },
  };
}
