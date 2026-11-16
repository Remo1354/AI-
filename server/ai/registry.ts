import { all, get, getSetting } from '../db';
import { config } from '../config';
import { decrypt } from '../lib/crypto';
import { parseJson } from '../lib/http';
import { createAnthropicAdapter, ANTHROPIC_DEFAULT_BASE } from './adapters/anthropic';
import { createOpenAICompatibleAdapter } from './adapters/openai-compatible';
import { AiError, NOT_CONFIGURED_MESSAGE, type ModelAdapter, type ModelInfo, type ProviderKind, type ProviderRecord } from './types';

/** 设置页「添加模型服务」时可选的预设。模型 ID 以各服务商文档为准，可随时用「获取模型列表」刷新。 */
export const PRESETS: {
  key: string; name: string; kind: ProviderKind; baseUrl: string; models: ModelInfo[]; keyHint: string; needsKey: boolean;
}[] = [
  {
    key: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: ANTHROPIC_DEFAULT_BASE, needsKey: true,
    keyHint: 'sk-ant-…',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
  },
  { key: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', models: [], keyHint: 'sk-…', needsKey: true },
  {
    key: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, keyHint: 'sk-…',
    models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  },
  {
    key: 'dashscope', name: '通义千问（百炼）', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true, keyHint: 'sk-…',
    models: [{ id: 'qwen-plus' }, { id: 'qwen-max' }],
  },
  { key: 'moonshot', name: 'Kimi（Moonshot）', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', models: [], keyHint: 'sk-…', needsKey: true },
  { key: 'zhipu', name: '智谱 GLM', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [], keyHint: '', needsKey: true },
  { key: 'siliconflow', name: '硅基流动', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', models: [], keyHint: 'sk-…', needsKey: true },
  { key: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: [], keyHint: 'sk-or-…', needsKey: true },
  { key: 'gemini', name: 'Google Gemini（OpenAI 兼容）', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: [], keyHint: '', needsKey: true },
  { key: 'ollama', name: 'Ollama（本机模型）', kind: 'openai', baseUrl: 'http://localhost:11434/v1', models: [], keyHint: '无需填写', needsKey: false },
  { key: 'custom', name: '自定义（OpenAI 兼容）', kind: 'openai', baseUrl: '', models: [], keyHint: '', needsKey: false },
];

interface ProviderRow {
  id: string; name: string; kind: ProviderKind; base_url: string; api_key_enc: string;
  models: string; max_tokens: number | null; enabled: number;
}

function fromRow(r: ProviderRow): ProviderRecord {
  return {
    id: r.id, name: r.name, kind: r.kind, baseUrl: r.base_url, apiKey: decrypt(r.api_key_enc),
    models: parseJson<ModelInfo[]>(r.models, []), maxTokens: r.max_tokens, enabled: !!r.enabled, source: 'db',
  };
}

function envProviders(): ProviderRecord[] {
  const out: ProviderRecord[] = [];
  const { ai } = config;
  if (ai.anthropicKey) {
    const preset = PRESETS[0];
    out.push({
      id: 'env-anthropic', name: 'Anthropic（环境变量）', kind: 'anthropic', baseUrl: ANTHROPIC_DEFAULT_BASE,
      apiKey: ai.anthropicKey, enabled: true, source: 'env', maxTokens: null,
      models: ai.anthropicModels.length ? ai.anthropicModels.map((id) => ({ id })) : preset.models,
    });
  }
  if (ai.openaiKey && ai.openaiModels.length) {
    out.push({
      id: 'env-openai', name: 'OpenAI 兼容（环境变量）', kind: 'openai', baseUrl: ai.openaiBaseUrl,
      apiKey: ai.openaiKey, enabled: true, source: 'env', maxTokens: null,
      models: ai.openaiModels.map((id) => ({ id })),
    });
  }
  return out;
}

export function listProviders(): ProviderRecord[] {
  const rows = all<ProviderRow>('SELECT * FROM providers ORDER BY created_at');
  return [...rows.map(fromRow), ...envProviders()];
}

export function getProvider(id: string): ProviderRecord | undefined {
  if (id.startsWith('env-')) return envProviders().find((p) => p.id === id);
  const row = get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
  return row ? fromRow(row) : undefined;
}

/** 模型是否可直接调用：Ollama 这类本机服务不需要 Key。 */
export function isUsable(p: ProviderRecord): boolean {
  if (!p.enabled || !p.models.length) return false;
  if (p.kind === 'anthropic') return !!p.apiKey;
  return !!p.baseUrl;
}

export function createAdapter(p: Pick<ProviderRecord, 'kind' | 'apiKey' | 'baseUrl' | 'maxTokens'>): ModelAdapter {
  if (p.kind === 'anthropic') {
    return createAnthropicAdapter({ apiKey: p.apiKey, baseUrl: p.baseUrl, maxTokens: p.maxTokens || config.ai.maxTokens });
  }
  return createOpenAICompatibleAdapter({ apiKey: p.apiKey, baseUrl: p.baseUrl, maxTokens: p.maxTokens });
}

export const makeRef = (providerId: string, model: string) => `${providerId}::${model}`;
export function splitRef(ref: string): { providerId: string; model: string } | null {
  const i = ref.indexOf('::');
  return i > 0 ? { providerId: ref.slice(0, i), model: ref.slice(i + 2) } : null;
}

export interface ModelOption { ref: string; providerId: string; providerName: string; model: string; label: string }

export function listModelOptions(): ModelOption[] {
  return listProviders().filter(isUsable).flatMap((p) =>
    p.models.map((m) => ({
      ref: makeRef(p.id, m.id), providerId: p.id, providerName: p.name, model: m.id, label: m.label || m.id,
    })),
  );
}

export function defaultModelRef(): string | null {
  const options = listModelOptions();
  if (!options.length) return null;
  const saved = getSetting<string | null>('default_model', null);
  return saved && options.some((o) => o.ref === saved) ? saved : options[0].ref;
}

export interface Resolved { provider: ProviderRecord; model: string; ref: string; adapter: ModelAdapter }

/** 把 modelRef 解析成可调用的适配器；找不到时回退到默认模型，仍没有则抛出 not_configured。 */
export function resolveModel(ref?: string | null): Resolved {
  const options = listModelOptions();
  if (!options.length) throw new AiError('not_configured', NOT_CONFIGURED_MESSAGE, 409);
  const chosen = (ref && options.find((o) => o.ref === ref)) || options.find((o) => o.ref === defaultModelRef())!;
  const provider = getProvider(chosen.providerId)!;
  return { provider, model: chosen.model, ref: chosen.ref, adapter: createAdapter(provider) };
}
