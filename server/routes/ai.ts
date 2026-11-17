import { Hono } from 'hono';
import { all, get, insert, newId, now, run, setSetting } from '../db';
import { encrypt, maskKey } from '../lib/crypto';
import { badRequest, notFound, readJson, requireText } from '../lib/http';
import { MODES } from '../ai/prompts';
import {
  PRESETS, createAdapter, defaultModelRef, getProvider, isUsable, listModelOptions, listProviders, makeRef,
} from '../ai/registry';
import { complete } from '../ai/service';
import type { ModelInfo, ProviderKind, ProviderRecord } from '../ai/types';

export const aiRoutes = new Hono();

/** 下发给前端的模型来源：永远不包含明文密钥。 */
function publicProvider(p: ProviderRecord) {
  return {
    id: p.id, name: p.name, kind: p.kind, base_url: p.baseUrl, models: p.models, max_tokens: p.maxTokens ?? null,
    enabled: p.enabled, source: p.source, has_key: !!p.apiKey, key_hint: maskKey(p.apiKey), usable: isUsable(p),
  };
}

function cleanModels(input: unknown): ModelInfo[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\n,]/) : [];
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of raw) {
    const id = String(typeof m === 'object' && m ? (m as ModelInfo).id : m).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof m === 'object' && m && (m as ModelInfo).label ? String((m as ModelInfo).label).trim() : undefined;
    out.push(label ? { id, label } : { id });
  }
  return out.slice(0, 60);
}

const kindOf = (v: unknown): ProviderKind => (v === 'anthropic' ? 'anthropic' : 'openai');

aiRoutes.get('/ai/modes', (c) =>
  c.json(MODES.map(({ id, name, description, starters }) => ({ id, name, description, starters }))));

aiRoutes.get('/ai/presets', (c) => c.json(PRESETS));

aiRoutes.get('/ai/providers', (c) => c.json(listProviders().map(publicProvider)));

aiRoutes.get('/ai/models', (c) => {
  const options = listModelOptions();
  return c.json({ configured: options.length > 0, default: defaultModelRef(), options });
});

aiRoutes.put('/ai/default', async (c) => {
  const { model_ref } = await readJson(c);
  if (!listModelOptions().some((o) => o.ref === model_ref)) throw badRequest('这个模型不可用');
  setSetting('default_model', model_ref);
  return c.json({ default: model_ref });
});

aiRoutes.post('/ai/providers', async (c) => {
  const b = await readJson(c);
  const kind = kindOf(b.kind);
  const name = requireText(b.name, '名称', 60);
  const baseUrl = String(b.base_url || '').trim();
  if (kind === 'openai' && !/^https?:\/\//.test(baseUrl)) throw badRequest('请填写以 http:// 或 https:// 开头的 Base URL');
  const id = newId('prov');
  insert('providers', {
    id, name, kind, base_url: baseUrl, api_key_enc: encrypt(String(b.api_key || '').trim()),
    models: JSON.stringify(cleanModels(b.models)), max_tokens: Number(b.max_tokens) > 0 ? Number(b.max_tokens) : null,
    enabled: 1, created_at: now(), updated_at: now(),
  });
  return c.json(publicProvider(getProvider(id)!), 201);
});

aiRoutes.patch('/ai/providers/:id', async (c) => {
  const id = c.req.param('id');
  if (id.startsWith('env-')) throw badRequest('来自环境变量的模型来源请在 .env 文件中修改');
  if (!get('SELECT id FROM providers WHERE id = ?', id)) throw notFound('模型来源');
  const b = await readJson(c);
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now()];
  if (b.name !== undefined) { sets.push('name = ?'); vals.push(requireText(b.name, '名称', 60)); }
  if (b.base_url !== undefined) { sets.push('base_url = ?'); vals.push(String(b.base_url).trim()); }
  if (b.models !== undefined) { sets.push('models = ?'); vals.push(JSON.stringify(cleanModels(b.models))); }
  if (b.enabled !== undefined) { sets.push('enabled = ?'); vals.push(b.enabled ? 1 : 0); }
  if (b.max_tokens !== undefined) { sets.push('max_tokens = ?'); vals.push(Number(b.max_tokens) > 0 ? Number(b.max_tokens) : null); }
  // api_key 只有在明确提供非空值时才覆盖；传空串表示清除
  if (typeof b.api_key === 'string') { sets.push('api_key_enc = ?'); vals.push(encrypt(b.api_key.trim())); }
  run(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  return c.json(publicProvider(getProvider(id)!));
});

aiRoutes.delete('/ai/providers/:id', (c) => {
  const id = c.req.param('id');
  if (id.startsWith('env-')) throw badRequest('来自环境变量的模型来源请在 .env 文件中移除');
  run('DELETE FROM providers WHERE id = ?', id);
  return c.json({ ok: true });
});

/** 真实发起一次最小调用，验证 Key、地址和模型都可用。 */
aiRoutes.post('/ai/providers/:id/test', async (c) => {
  const p = getProvider(c.req.param('id'));
  if (!p) throw notFound('模型来源');
  const b = await readJson(c);
  const model = String(b.model || p.models[0]?.id || '').trim();
  if (!model) throw badRequest('请先添加至少一个模型 ID');
  const started = Date.now();
  const res = await complete({
    resolved: { provider: p, model, ref: makeRef(p.id, model), adapter: createAdapter(p) },
    messages: [{ role: 'user', content: '这是一次连通性测试，请只回复：OK' }],
    purpose: 'test', maxTokens: p.kind === 'anthropic' ? 1024 : undefined,
  });
  return c.json({ ok: true, model, reply: res.text.trim().slice(0, 80), duration_ms: Date.now() - started });
});

/** 向服务商查询模型列表。可用于尚未保存的配置（传 kind/base_url/api_key）或已保存的来源（传 id）。 */
aiRoutes.post('/ai/discover', async (c) => {
  const b = await readJson(c);
  let target: Pick<ProviderRecord, 'kind' | 'apiKey' | 'baseUrl' | 'maxTokens'>;
  if (b.id) {
    const p = getProvider(String(b.id));
    if (!p) throw notFound('模型来源');
    target = { ...p, apiKey: typeof b.api_key === 'string' && b.api_key.trim() ? b.api_key.trim() : p.apiKey };
  } else {
    target = { kind: kindOf(b.kind), apiKey: String(b.api_key || '').trim(), baseUrl: String(b.base_url || '').trim(), maxTokens: null };
  }
  if (target.kind === 'openai' && !/^https?:\/\//.test(target.baseUrl)) throw badRequest('请先填写 Base URL');
  const models = await createAdapter(target).listModels();
  return c.json({ models });
});

aiRoutes.get('/ai/calls', (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  const calls = all('SELECT * FROM ai_calls ORDER BY created_at DESC LIMIT ?', limit);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const stats = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM ai_calls WHERE created_at >= ?`, since);
  const byModel = all(
    `SELECT provider_name, model, COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
       FROM ai_calls WHERE created_at >= ? GROUP BY provider_name, model ORDER BY calls DESC`, since);
  return c.json({ calls, stats, by_model: byModel });
});
