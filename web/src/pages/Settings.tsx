import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Download, KeyRound, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Upload, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { bytes, clock } from '../lib/format';
import { useApp, useData, type Theme } from '../lib/store';
import { AiNotice, Empty, Field, Loading, Modal, PageHead, Spinner, Tabs, confirmDelete } from '../components/ui';

const PURPOSE: Record<string, string> = {
  chat: '对话', summarize: '提炼摘要', plan: '学习计划', review: '阶段总结', research: '研究分析', factcheck: '事实核查',
  report: '研究报告', studio: '内容创作', test: '连通测试',
};
const COLORS = ['azurite', 'ochre', 'carmine', 'indigo', 'malachite', 'gamboge'];

function ProviderModal({ provider, onClose, onSaved }: { provider?: any; onClose: () => void; onSaved: () => void }) {
  const { fail, toast } = useApp();
  const presets = useData(() => api.get<any[]>('/ai/presets'), []);
  const [preset, setPreset] = useState('');
  const [f, setF] = useState({
    name: provider?.name || '', kind: provider?.kind || 'anthropic', base_url: provider?.base_url || '', api_key: '',
    models: (provider?.models || []).map((m: any) => m.id).join('\n'), max_tokens: provider?.max_tokens ? String(provider.max_tokens) : '',
  });
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState('');
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const current = presets.data?.find((p) => p.key === preset);

  useEffect(() => {
    if (provider || !presets.data || preset) return;
    pick(presets.data[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.data]);

  const pick = (key: string) => {
    const p = presets.data?.find((x) => x.key === key);
    if (!p) return;
    setPreset(key);
    setFound(null);
    setF((s) => ({ ...s, name: p.key === 'custom' ? '' : p.name, kind: p.kind, base_url: p.baseUrl, models: p.models.map((m: any) => m.id).join('\n') }));
  };
  const modelIds = () => f.models.split(/[\n,]/).map((s: string) => s.trim()).filter(Boolean);
  const discover = async () => {
    setBusy('discover');
    try {
      const r = await api.post('/ai/discover', provider ? { id: provider.id, api_key: f.api_key } : { kind: f.kind, base_url: f.base_url, api_key: f.api_key });
      setFound(r.models);
      if (!r.models.length) toast('服务商没有返回可用模型', 'error');
    } catch (err) { fail(err); } finally { setBusy(''); }
  };
  const toggleModel = (id: string) => {
    const ids = modelIds();
    set('models', (ids.includes(id) ? ids.filter((x: string) => x !== id) : [...ids, id]).join('\n'));
  };
  const save = async () => {
    setBusy('save');
    try {
      const labels = new Map((current?.models || provider?.models || []).map((m: any) => [m.id, m.label]));
      const body: Record<string, unknown> = {
        name: f.name, kind: f.kind, base_url: f.base_url, max_tokens: f.max_tokens || null,
        models: modelIds().map((id: string) => ({ id, label: labels.get(id) })),
      };
      if (f.api_key.trim() || !provider) body.api_key = f.api_key.trim();
      if (provider) await api.patch(`/ai/providers/${provider.id}`, body); else await api.post('/ai/providers', body);
      toast('已保存');
      onSaved();
    } catch (err) { fail(err); } finally { setBusy(''); }
  };

  return (
    <Modal title={provider ? `编辑 ${provider.name}` : '添加模型服务'} wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={!!busy || !f.name.trim() || !modelIds().length}>{busy === 'save' ? <Spinner /> : null}保存</button>
    </>}>
      <div className="modal-body">
        {!provider && (
          <Field label="服务商">
            <select className="select" value={preset} onChange={(e) => pick(e.target.value)}>
              {presets.data?.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <div className="form-grid">
          <Field label="显示名称"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="接口协议">
            <select className="select" value={f.kind} onChange={(e) => set('kind', e.target.value)} disabled={!!provider || (!!preset && preset !== 'custom')}>
              <option value="anthropic">Anthropic Messages</option>
              <option value="openai">OpenAI 兼容（Chat Completions）</option>
            </select>
          </Field>
          <Field label="Base URL" className="full" hint={f.kind === 'anthropic' ? '留空使用官方地址 https://api.anthropic.com' : '以 /v1 结尾的接口根地址，不包含 /chat/completions'}>
            <input className="input" value={f.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder={f.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://…/v1'} />
          </Field>
          <Field label="API Key" className="full" hint={<>密钥只保存在服务端，加密后写入数据库，不会回传到浏览器。{provider?.has_key ? `当前：${provider.key_hint}，留空表示不修改。` : ''}</>}>
            <input className="input" type="password" autoComplete="off" value={f.api_key} onChange={(e) => set('api_key', e.target.value)} placeholder={provider?.has_key ? '留空表示不修改' : current?.keyHint || ''} />
          </Field>
          <Field label="模型 ID" className="full" hint="每行一个。第一个会作为这个服务的默认模型。模型 ID 以服务商文档为准。">
            <textarea className="textarea mono" style={{ minHeight: 84 }} value={f.models} onChange={(e) => set('models', e.target.value)} placeholder="每行一个模型 ID" />
          </Field>
          <div className="full stack sm">
            <div><button className="btn sm" onClick={discover} disabled={!!busy}>{busy === 'discover' ? <Spinner /> : <RefreshCw />}从服务商获取模型列表</button></div>
            {found && found.length > 0 && (
              <div className="row wrap" style={{ gap: 6, maxHeight: 132, overflowY: 'auto' }}>
                {found.map((id) => <button key={id} className={`tag ${modelIds().includes(id) ? 'active' : 'outline'}`} onClick={() => toggleModel(id)}>{id}</button>)}
              </div>
            )}
          </div>
          <Field label="最大输出 token（可选）" hint={f.kind === 'anthropic' ? '留空使用默认值' : '留空则不传，由服务商决定'}>
            <input className="input" type="number" min={0} value={f.max_tokens} onChange={(e) => set('max_tokens', e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ModelsTab() {
  const { models, refresh, fail, toast } = useApp();
  const providers = useData(() => api.get<any[]>('/ai/providers'), []);
  const [modal, setModal] = useState<null | { provider?: any }>(null);
  const [testing, setTesting] = useState('');
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const reload = () => { providers.reload(); refresh(); };

  const test = async (p: any) => {
    setTesting(p.id);
    try {
      const r = await api.post(`/ai/providers/${p.id}/test`, {});
      setResults((s) => ({ ...s, [p.id]: { ok: true, text: `连接正常 · ${r.model} · ${r.duration_ms} ms · 回复「${r.reply}」` } }));
    } catch (err) {
      setResults((s) => ({ ...s, [p.id]: { ok: false, text: (err as Error).message } }));
    } finally { setTesting(''); }
  };
  const remove = async (p: any) => {
    if (!confirmDelete(`模型服务「${p.name}」`)) return;
    try { await api.del(`/ai/providers/${p.id}`); reload(); } catch (err) { fail(err); }
  };
  const toggle = async (p: any) => { try { await api.patch(`/ai/providers/${p.id}`, { enabled: !p.enabled }); reload(); } catch (err) { fail(err); } };
  const setDefault = async (ref: string) => { try { await api.put('/ai/default', { model_ref: ref }); refresh(); toast('默认模型已更新'); } catch (err) { fail(err); } };

  return (
    <div className="stack lg">
      <AiNotice />
      {models.configured && (
        <div className="card pad">
          <Field label="默认模型" hint="新对话以及总结、规划、研究、创作等功能使用这个模型。对话中可以随时切换。">
            <select className="select" style={{ maxWidth: 440 }} value={models.default || ''} onChange={(e) => setDefault(e.target.value)}>
              {models.options.map((o) => <option key={o.ref} value={o.ref}>{o.label} · {o.providerName}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div className="row between">
        <h2 style={{ fontSize: 17 }}>模型服务</h2>
        <button className="btn primary" onClick={() => setModal({})}><Plus />添加模型服务</button>
      </div>
      <div className="card">
        {providers.loading && !providers.data && <Loading />}
        {providers.data && !providers.data.length && (
          <Empty title="还没有添加模型服务">
            支持 Anthropic Claude，以及任何 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、Kimi、智谱、硅基流动、OpenRouter、本机 Ollama 等）。<br />
            <button className="btn primary" onClick={() => setModal({})}><Plus />添加第一个模型服务</button>
          </Empty>
        )}
        {providers.data?.map((p) => (
          <div key={p.id} className="provider stack sm">
            <div className="row between wrap">
              <div className="row wrap">
                <b style={{ fontSize: 15.5 }}>{p.name}</b>
                <span className="tag outline">{p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}</span>
                {p.source === 'env' && <span className="tag">来自 .env</span>}
                {p.usable ? <span className="tag ok"><Check />可用</span> : <span className="tag warn">{!p.enabled ? '已停用' : !p.models.length ? '缺少模型' : '缺少 API Key'}</span>}
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn sm" onClick={() => test(p)} disabled={testing === p.id}>{testing === p.id ? <Spinner /> : <Zap />}测试连接</button>
                {p.source === 'db' && <>
                  <button className="btn sm" onClick={() => toggle(p)}>{p.enabled ? '停用' : '启用'}</button>
                  <button className="btn ghost icon sm" aria-label="编辑" onClick={() => setModal({ provider: p })}><Pencil /></button>
                  <button className="btn ghost icon sm" aria-label="删除" onClick={() => remove(p)}><Trash2 /></button>
                </>}
              </div>
            </div>
            <div className="xs faint row wrap">
              {p.base_url && <span>{p.base_url}</span>}
              <span className="row" style={{ gap: 4 }}><KeyRound size={12} />{p.has_key ? p.key_hint : '未填写'}</span>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {p.models.map((m: any) => <span key={m.id} className="tag">{m.label || m.id}</span>)}
            </div>
            {results[p.id] && <div className={`banner small ${results[p.id].ok ? 'ok' : 'danger'}`}><Zap /><div>{results[p.id].text}</div></div>}
          </div>
        ))}
      </div>
      <p className="hint row top" style={{ gap: 6 }}><ShieldCheck size={15} style={{ flex: 'none', marginTop: 1 }} />
        所有模型调用都从服务端发出。API Key 用 AES-256-GCM 加密后保存在本机数据库，页面上只显示掩码；备份文件里不包含密钥。
      </p>
      {modal && <ProviderModal provider={modal.provider} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
    </div>
  );
}

function CallsTab() {
  const { data, loading } = useData(() => api.get('/ai/calls?limit=200'), []);
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const s = data.stats;
  return (
    <div className="stack lg">
      <div className="card pad row wrap" style={{ gap: 40 }}>
        <div><div className="stat-value">{s.total}</div><div className="stat-label">近 30 天调用</div></div>
        <div><div className="stat-value">{s.total ? Math.round(((s.ok || 0) / s.total) * 100) : 0}<small>%</small></div><div className="stat-label">成功率</div></div>
        <div><div className="stat-value">{(s.input_tokens || 0).toLocaleString()}</div><div className="stat-label">输入 token</div></div>
        <div><div className="stat-value">{(s.output_tokens || 0).toLocaleString()}</div><div className="stat-label">输出 token</div></div>
      </div>
      {data.by_model.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>模型</th><th>服务</th><th>调用次数</th><th>输入 token</th><th>输出 token</th></tr></thead>
            <tbody>{data.by_model.map((m: any) => (
              <tr key={m.provider_name + m.model}><td>{m.model}</td><td className="muted">{m.provider_name}</td><td className="num">{m.calls}</td><td className="num">{m.input_tokens.toLocaleString()}</td><td className="num">{m.output_tokens.toLocaleString()}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="card table-wrap">
        {!data.calls.length ? <Empty compact title="还没有调用记录">每一次模型调用（包括失败的）都会记录在这里。</Empty> : (
          <table className="table">
            <thead><tr><th>时间</th><th>用途</th><th>模型</th><th>输入 / 输出</th><th>耗时</th><th>结果</th></tr></thead>
            <tbody>{data.calls.map((c: any) => (
              <tr key={c.id}>
                <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{clock(c.created_at)}</td>
                <td>{PURPOSE[c.purpose] || c.purpose}</td>
                <td>{c.model}<div className="xs faint">{c.provider_name}</div></td>
                <td className="num">{c.input_tokens ?? '—'} / {c.output_tokens ?? '—'}</td>
                <td className="num">{c.duration_ms != null ? `${(c.duration_ms / 1000).toFixed(1)} s` : '—'}</td>
                <td>{c.status === 'ok' ? <span className="tag ok">成功</span> : c.status === 'aborted' ? <span className="tag">已停止</span> : <span className="tag danger" title={c.error}>失败</span>}
                  {c.status === 'error' && <div className="xs faint" style={{ maxWidth: 260 }}>{c.error}</div>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const COUNT_LABEL: Record<string, string> = {
  knowledge_items: '知识条目', documents: '上传资料', conversations: '对话', messages: '消息', plans: '学习计划', tasks: '任务', study_logs: '学习记录',
  reviews: '阶段总结', research_projects: '研究项目', research_sources: '研究来源', research_reports: '研究报告', content_topics: '选题', content_refs: '视觉参考',
};

function DataTab() {
  const { toast, fail, refresh } = useApp();
  const info = useData(() => api.get('/backup/info'), []);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const restore = async (file?: File) => {
    if (!file) return;
    if (!window.confirm(`将用备份「${file.name}」替换当前的全部数据。\n\n当前数据会改名保留在数据目录里（.before-restore 后缀），可以手动找回。确定继续吗？`)) return;
    setBusy(true);
    try {
      const r = await api.upload('/backup/import', { file, confirm: 'yes' });
      toast(`恢复完成：${r.counts.knowledge_items} 条知识、${r.counts.documents} 份资料`);
      info.reload();
      refresh();
    } catch (err) { fail(err); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const d = info.data;
  return (
    <div className="stack lg">
      <div className="card pad stack">
        <h2 style={{ fontSize: 17 }}>备份与迁移</h2>
        <p className="muted small">完整备份是一个 zip 文件，包含数据库和所有上传的文件，不包含 API Key。把它存到云盘或另一台电脑，就可以在任何一台装好本平台的机器上恢复。</p>
        <div className="row wrap">
          <a className="btn primary" href="/api/backup/export" download><Download />下载完整备份</a>
          <input ref={input} type="file" hidden accept=".zip" onChange={(e) => restore(e.target.files?.[0])} />
          <button className="btn" onClick={() => input.current?.click()} disabled={busy}>{busy ? <Spinner /> : <Upload />}从备份恢复…</button>
          <a className="btn" href="/api/knowledge/export" download><Download />导出知识库（Markdown）</a>
        </div>
        <p className="hint">命令行也可以：<code>npm run backup</code> 生成备份到 backups/ 目录；<code>npm run restore -- 备份文件.zip</code> 恢复。知识库的 Markdown 导出是通用格式，可以直接导入 Obsidian 等工具。</p>
      </div>
      {info.loading && !d && <Loading />}
      {d && (
        <div className="card pad stack">
          <h2 style={{ fontSize: 17 }}>数据存放在哪里</h2>
          <dl className="kv">
            <dt>数据目录</dt><dd><code>{d.data_dir}</code></dd>
            <dt>数据库</dt><dd>{bytes(d.db_bytes)}（SQLite，单个文件）</dd>
            <dt>上传文件</dt><dd>{d.uploads_count} 个，共 {bytes(d.uploads_bytes)}</dd>
            <dt>访问方式</dt><dd>{d.host === '127.0.0.1' || d.host === 'localhost' ? '仅本机可访问' : `监听 ${d.host}`} · 访问密码{d.password_protected ? '已启用' : '未启用'}</dd>
            <dt>单文件上限</dt><dd>{d.max_upload_mb} MB</dd>
          </dl>
          <div className="row wrap" style={{ gap: 6 }}>
            {Object.entries(d.counts as Record<string, number>).filter(([, n]) => n > 0).map(([k, n]) => <span key={k} className="tag">{COUNT_LABEL[k] || k} {n}</span>)}
          </div>
          <p className="hint">数据只存在这个目录里。如果平台运行在临时的云端环境（例如开发用的云端会话），目录会随环境回收而消失，请定期下载备份；部署在自己的电脑或带持久磁盘的服务器上则会一直保留。可以在 .env 里用 DATA_DIR 把它指到任意位置。</p>
        </div>
      )}
    </div>
  );
}

function DomainsTab() {
  const { domains, refresh, fail } = useApp();
  const save = async (id: string, patch: Record<string, unknown>) => { try { await api.patch(`/domains/${id}`, patch); refresh(); } catch (err) { fail(err); } };
  const add = async () => {
    const name = window.prompt('新学习方向的名称')?.trim();
    if (!name) return;
    try { await api.post('/domains', { name, color: COLORS[domains.length % COLORS.length] }); refresh(); } catch (err) { fail(err); }
  };
  const remove = async (d: any) => {
    if (!window.confirm(`确定删除方向「${d.name}」吗？相关的计划、记录和知识不会被删除，只是不再归属于这个方向。`)) return;
    try { await api.del(`/domains/${d.id}`); refresh(); } catch (err) { fail(err); }
  };
  return (
    <div className="stack lg">
      <div className="card">
        {domains.map((d) => (
          <div key={d.id} className="provider row wrap" data-color={d.color}>
            <i className="dot" style={{ width: 12, height: 12 }} />
            <input className="input" style={{ maxWidth: 220 }} defaultValue={d.name} aria-label="方向名称" onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== d.name) save(d.id, { name: v }); }} />
            <input className="input grow" style={{ minWidth: 160 }} defaultValue={d.description} placeholder="一句话说明" aria-label="说明" onBlur={(e) => { if (e.target.value !== d.description) save(d.id, { description: e.target.value }); }} />
            <div className="swatches">
              {COLORS.map((c) => <button key={c} className={`swatch ${d.color === c ? 'active' : ''}`} data-color={c} aria-label={`颜色 ${c}`} onClick={() => save(d.id, { color: c })} />)}
            </div>
            <button className="btn ghost icon sm" aria-label="删除" onClick={() => remove(d)}><Trash2 /></button>
          </div>
        ))}
      </div>
      <div><button className="btn" onClick={add}><Plus />添加学习方向</button></div>
      <p className="hint">六种颜色取自传统矿物颜料（石青、赭石、胭脂、靛蓝、石绿、藤黄），已针对色觉差异做过区分度校验。</p>
    </div>
  );
}

type Tab = 'models' | 'calls' | 'data' | 'domains' | 'appearance';

export function Settings() {
  const { theme, setTheme } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'models';
  return (
    <div className="page">
      <PageHead eyebrow="Settings" title="设置" desc="模型接入、调用记录、数据备份与外观。" />
      <Tabs
        value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })}
        items={[{ id: 'models', label: '模型' }, { id: 'calls', label: '调用记录' }, { id: 'data', label: '数据与备份' }, { id: 'domains', label: '学习方向' }, { id: 'appearance', label: '外观' }]}
      />
      {tab === 'models' && <ModelsTab />}
      {tab === 'calls' && <CallsTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'domains' && <DomainsTab />}
      {tab === 'appearance' && (
        <div className="card pad stack">
          <div className="label">主题</div>
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            {([['auto', '跟随系统'], ['light', '纸（浅色）'], ['dark', '墨（深色）']] as [Theme, string][]).map(([k, label]) => (
              <button key={k} className={theme === k ? 'active' : ''} onClick={() => setTheme(k)}>{label}</button>
            ))}
          </div>
          <p className="hint">内容创作中心（叠绘工作室）有独立的深色画室风格，不随主题变化。</p>
        </div>
      )}
    </div>
  );
}
