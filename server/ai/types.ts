/**
 * 统一模型适配接口。
 * 业务代码只依赖这里的类型；接入新的模型服务 = 新增一个实现 ModelAdapter 的文件，
 * 然后在 registry.ts 里登记 kind。
 */
/** 随消息发送的图片：base64 数据，不含 data: 前缀。 */
export interface ImagePart {
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 只有 user 消息可以带图；模型需要支持图片输入 */
  images?: ImagePart[];
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking' }
  | { type: 'end'; inputTokens?: number; outputTokens?: number; stopReason?: string };

export interface ModelAdapter {
  stream(req: ChatRequest): AsyncGenerator<ChatEvent>;
  /** 向服务商查询可用模型 ID（用于设置页的「获取模型列表」）。 */
  listModels(): Promise<string[]>;
}

export type ProviderKind = 'anthropic' | 'openai';

export interface ModelInfo {
  id: string;
  label?: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: ModelInfo[];
  maxTokens?: number | null;
  enabled: boolean;
  source: 'db' | 'env';
}

export type AiErrorCode =
  | 'not_configured' | 'auth' | 'model_not_found' | 'rate_limit' | 'bad_request'
  | 'network' | 'provider' | 'aborted' | 'invalid_output';

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

export const NOT_CONFIGURED_MESSAGE =
  '还没有配置可用的 AI 模型。请到「设置 → 模型」添加一个模型服务并填写 API Key。';
