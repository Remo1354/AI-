import Anthropic from '@anthropic-ai/sdk';
import { AiError, type ChatRequest, type ChatEvent, type ModelAdapter } from '../types';

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';

function mapError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new AiError('aborted', '已停止生成', 499);
  if (err instanceof Anthropic.AuthenticationError) return new AiError('auth', 'Anthropic API Key 无效或已失效，请在设置中检查。', 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new AiError('auth', `当前 API Key 没有权限使用该模型：${err.message}`, 403);
  if (err instanceof Anthropic.NotFoundError) return new AiError('model_not_found', '模型不存在或当前账号无权使用，请检查模型 ID。', 404);
  if (err instanceof Anthropic.RateLimitError) return new AiError('rate_limit', '请求过于频繁或额度不足，请稍后再试。', 429);
  if (err instanceof Anthropic.BadRequestError) return new AiError('bad_request', `请求被模型服务拒绝：${err.message}`, 400);
  if (err instanceof Anthropic.APIConnectionError) return new AiError('network', '无法连接到 Anthropic 服务，请检查网络或 Base URL。', 502);
  if (err instanceof Anthropic.APIError) return new AiError('provider', `Anthropic 服务出错（${err.status ?? '未知'}）：${err.message}`, 502);
  return new AiError('provider', (err as Error)?.message || '调用模型失败', 502);
}

export function createAnthropicAdapter(opts: { apiKey: string; baseUrl?: string; maxTokens: number }): ModelAdapter {
  // 显式传入 apiKey 与 baseURL，避免 SDK 读取到运行环境里无关的同名环境变量。
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl || ANTHROPIC_DEFAULT_BASE,
    maxRetries: 2,
  });

  return {
    async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      try {
        // 带图的消息：图片块在前、文字在后
        const messages: Anthropic.MessageParam[] = req.messages.map((m) =>
          m.images?.length
            ? {
                role: m.role,
                content: [
                  ...m.images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime, data: img.data } })),
                  { type: 'text' as const, text: m.content },
                ],
              }
            : { role: m.role, content: m.content });
        // 不传 thinking / temperature：新模型默认自适应思考，且会拒绝采样参数。
        const stream = client.messages.stream(
          {
            model: req.model,
            max_tokens: req.maxTokens ?? opts.maxTokens,
            ...(req.system ? { system: req.system } : {}),
            messages,
          },
          { signal: req.signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
            yield { type: 'thinking' };
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text };
          }
        }
        const final = await stream.finalMessage();
        yield {
          type: 'end',
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          stopReason: final.stop_reason ?? undefined,
        };
      } catch (err) {
        throw mapError(err);
      }
    },

    async listModels() {
      try {
        const ids: string[] = [];
        for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
        return ids;
      } catch (err) {
        throw mapError(err);
      }
    },
  };
}
