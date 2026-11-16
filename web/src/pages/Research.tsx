import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, BookmarkPlus, Check, ClipboardPaste, ExternalLink, FileText, Globe, Pencil, Plus, ScanSearch, ShieldCheck, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { chars, timeAgo } from '../lib/format';
import { useAction, useApp, useData } from '../lib/store';
import { AiNotice, DomainSelect, DomainTag, Empty, Field, Loading, Markdown, Modal, PageHead, Spinner, Tabs, confirmDelete } from '../components/ui';

const STATUS = [['collecting', '收集资料'], ['analyzing', '分析'], ['writing', '撰写'], ['done', '完成']] as const;
const KIND: Record<string, string> = { claim: '陈述', viewpoint: '观点', event: '事件', note: '笔记' };
const VERDICT: Record<string, string> = { unverified: '未核实', supported: '来源支持', disputed: '存在分歧', refuted: '来源否定' };
const SOURCE_KIND: Record<string, string> = { web: '网页', document: '上传资料', book: '书籍', paper: '论文', note: '笔记' };

export function Research() {
  const navigate = useNavigate();
  const { fail } = useApp();
  const list = useData(() => api.get<any[]>('/research'), []);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ title: '', question: '', domain_id: '' });
  const create = async () => {
    try { navigate(`/research/${(await api.post('/research', f)).id}`); } catch (err) { fail(err); }
  };
  return (
    <div className="page">
      <PageHead
        eyebrow="Research Lab" title="研究实验室"
        desc="围绕一个问题系统地收集来源、整理发现、核查事实，最后形成一份带可追溯引用的报告。AI 只依据你收集的来源进行分析。"
        actions={<button className="btn primary" onClick={() => setCreating(true)}><Plus />新建研究项目</button>}
      />
      {list.loading && !list.data && <Loading />}
      {list.data && !list.data.length && (
        <div className="card"><Empty title="还没有研究项目">
          适合用在需要认真弄清楚的问题上：一段艺术史、一项技术的来龙去脉、一期内容背后的事实依据。<br />
          <button className="btn primary" onClick={() => setCreating(true)}><Plus />新建研究项目</button>
        </Empty></div>
      )}
      <div className="grid-cards">
        {list.data?.map((p) => (
          <Link key={p.id} to={`/research/${p.id}`} className="card hover pad stack">
            <div className="row between"><span className={`tag ${p.status === 'done' ? 'ok' : 'outline'}`}>{STATUS.find((s) => s[0] === p.status)?.[1]}</span><DomainTag id={p.domain_id} /></div>
            <h3 className="serif" style={{ fontSize: 17, lineHeight: 1.4 }}>{p.title}</h3>
            {p.question && <p className="small muted clamp-2">{p.question}</p>}
            <div className="xs faint" style={{ marginTop: 'auto' }}>{p.source_count} 个来源 · {p.finding_count} 条发现 · {p.report_count} 份报告 · {timeAgo(p.updated_at)}</div>
          </Link>
        ))}
      </div>
      {creating && (
        <Modal title="新建研究项目" onClose={() => setCreating(false)} footer={<>
          <button className="btn" onClick={() => setCreating(false)}>取消</button>
          <button className="btn primary" onClick={create} disabled={!f.title.trim()}>创建</button>
        </>}>
          <div className="modal-body">
            <Field label="研究主题"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="例如：印象派为何在当时被排斥" /></Field>
            <Field label="想回答的问题" hint="问题越具体，后面的分析越有针对性"><textarea className="textarea" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} /></Field>
            <Field label="所属方向"><DomainSelect value={f.domain_id} onChange={(v) => setF({ ...f, domain_id: v })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── 添加来源 ─────────────────────────────────────────────────
function SourceModal({ projectId, mode, source, onClose, onSaved }: {
  projectId: string; mode: 'paste' | 'fetch' | 'document'; source?: any; onClose: () => void; onSaved: (p: any) => void;
}) {
  const { fail, toast } = useApp();
  const [f, setF] = useState({ title: source?.title || '', url: source?.url || '', author: source?.author || '', published_at: source?.published_at || '', kind: source?.kind || 'web', content: source?.content || '', note: source?.note || '' });
  const [busy, setBusy] = useState(false);
  const docs = useData(() => (mode === 'document' ? api.get<any[]>('/documents?kind=document') : Promise.resolve([])), [mode]);
  const input = useRef<HTMLInputElement>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try { onSaved(await fn()); onClose(); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const addDoc = (document_id: string) => act(() => api.post(`/research/${projectId}/sources`, { document_id }));
  const uploadDoc = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await api.upload('/documents', { file });
      if (r.document.status !== 'ready') { toast(r.document.error || '没有提取到文字', 'error'); return; }
      onSaved(await api.post(`/research/${projectId}/sources`, { document_id: r.document.id }));
      onClose();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  if (mode === 'fetch') {
    return (
      <Modal title="抓取网页作为来源" onClose={onClose} footer={<>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy || !f.url.trim()} onClick={() => act(() => api.post(`/research/${projectId}/sources/fetch`, { url: f.url, title: f.title }))}>{busy ? <Spinner /> : <Globe />}抓取并保存</button>
      </>}>
        <div className="modal-body">
          <Field label="网页链接"><input className="input" value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…" /></Field>
          <Field label="标题（可选）" hint="留空则使用网页标题"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <p className="hint">平台会把网页正文保存一份快照，之后的引用校验都以这份快照为准。需要登录或由脚本渲染的页面可能抓不到，请改用「粘贴文本」。</p>
        </div>
      </Modal>
    );
  }
  if (mode === 'document') {
    return (
      <Modal title="用上传的资料作为来源" onClose={onClose}>
        <div className="modal-body" style={{ paddingBottom: 24 }}>
          <input ref={input} type="file" hidden accept=".pdf,.docx,.txt,.md,.markdown,.html" onChange={(e) => uploadDoc(e.target.files?.[0])} />
          <button className="btn block" disabled={busy} onClick={() => input.current?.click()}>{busy ? <Spinner /> : <Upload />}上传新文件（PDF / DOCX / TXT）</button>
          <div className="side-title" style={{ marginTop: 8 }}>已有资料</div>
          <div className="list" style={{ maxHeight: 300, overflowY: 'auto' }}>
            {docs.data && !docs.data.length && <Empty compact title="还没有上传过资料" />}
            {docs.data?.filter((d) => d.status === 'ready').map((d) => (
              <button key={d.id} className="list-row" disabled={busy} onClick={() => addDoc(d.id)}>
                <FileText className="type-icon" /><div className="grow"><div className="truncate">{d.title}</div><div className="xs faint">{chars(d.chars)}</div></div><Plus size={15} className="faint" />
              </button>
            ))}
          </div>
        </div>
      </Modal>
    );
  }
  const save = () => act(() => (source ? api.patch(`/research/sources/${source.id}`, f) : api.post(`/research/${projectId}/sources`, f)));
  return (
    <Modal title={source ? `编辑来源 S${source.seq}` : '添加来源'} wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy || !f.title.trim()} onClick={save}>保存</button>
    </>}>
      <div className="modal-body">
        <div className="form-grid">
          <Field label="标题" className="full"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="文章、书籍章节或网页的标题" /></Field>
          <Field label="链接"><input className="input" value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…（能回到原处的地址）" /></Field>
          <Field label="类型">
            <select className="select" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
              {Object.entries(SOURCE_KIND).filter(([k]) => k !== 'document' || f.kind === 'document').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="作者 / 机构"><input className="input" value={f.author} onChange={(e) => set('author', e.target.value)} /></Field>
          <Field label="发表时间"><input className="input" value={f.published_at} onChange={(e) => set('published_at', e.target.value)} placeholder="例如 2019 或 2024-03-01" /></Field>
          <Field label="原文内容" className="full" hint="粘贴需要引用的原文。AI 的分析和事实核查只能引用这里的内容，引文会逐字比对。">
            <textarea className="textarea" style={{ minHeight: 180 }} value={f.content} onChange={(e) => set('content', e.target.value)} />
          </Field>
          <Field label="我的备注" className="full"><textarea className="textarea" style={{ minHeight: 60 }} value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="这个来源可靠吗？立场是什么？" /></Field>
        </div>
      </div>
    </Modal>
  );
}

function FindingModal({ project, finding, preset, onClose, onSaved }: { project: any; finding?: any; preset?: Partial<any>; onClose: () => void; onSaved: (p: any) => void }) {
  const { fail } = useApp();
  const [f, setF] = useState({
    kind: finding?.kind || preset?.kind || 'claim', title: finding?.title || preset?.title || '', content: finding?.content || preset?.content || '',
    event_date: finding?.event_date || '', holder: finding?.holder || '', verdict: finding?.verdict || 'unverified',
  });
  const [evidence, setEvidence] = useState<{ source_id: string; quote: string }[]>((finding?.evidence || []).map((e: any) => ({ source_id: e.source_id, quote: e.quote })));
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    try {
      const body = { ...f, evidence: evidence.filter((e) => e.source_id) };
      onSaved(finding ? await api.patch(`/research/findings/${finding.id}`, body) : await api.post(`/research/${project.id}/findings`, body));
      onClose();
    } catch (err) { fail(err); }
  };
  return (
    <Modal title={finding ? '编辑' : '记录一条发现'} wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={save}>保存</button>
    </>}>
      <div className="modal-body">
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          {Object.entries(KIND).map(([k, v]) => <button key={k} className={f.kind === k ? 'active' : ''} onClick={() => set('kind', k)}>{v}</button>)}
        </div>
        <Field label={f.kind === 'claim' ? '待核查的陈述' : f.kind === 'viewpoint' ? '观点' : f.kind === 'event' ? '事件' : '标题'}>
          <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder={f.kind === 'claim' ? '一句可以判断真假的话' : ''} />
        </Field>
        <div className="form-grid">
          {f.kind === 'event' && <Field label="时间"><input className="input" value={f.event_date} onChange={(e) => set('event_date', e.target.value)} placeholder="1874 或 1874-04-15" /></Field>}
          {f.kind === 'viewpoint' && <Field label="谁的观点"><input className="input" value={f.holder} onChange={(e) => set('holder', e.target.value)} placeholder="人物、学派或机构" /></Field>}
          {f.kind === 'claim' && (
            <Field label="核查结论">
              <select className="select" value={f.verdict} onChange={(e) => set('verdict', e.target.value)}>
                {Object.entries(VERDICT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
          )}
          <Field label="说明" className="full"><textarea className="textarea" value={f.content} onChange={(e) => set('content', e.target.value)} /></Field>
        </div>
        <div className="stack sm">
          <div className="label">证据（来源 + 原文引文）</div>
          {evidence.map((e, i) => (
            <div key={i} className="row top">
              <select className="select" style={{ width: 150, flex: 'none' }} value={e.source_id} onChange={(ev) => setEvidence(evidence.map((x, j) => (j === i ? { ...x, source_id: ev.target.value } : x)))}>
                <option value="">选择来源</option>
                {project.sources.map((s: any) => <option key={s.id} value={s.id}>S{s.seq} {s.title.slice(0, 14)}</option>)}
              </select>
              <input className="input" value={e.quote} placeholder="从该来源逐字摘录的原文" onChange={(ev) => setEvidence(evidence.map((x, j) => (j === i ? { ...x, quote: ev.target.value } : x)))} />
              <button className="btn ghost icon" aria-label="移除" onClick={() => setEvidence(evidence.filter((_, j) => j !== i))}><X /></button>
            </div>
          ))}
          <div><button className="btn sm" disabled={!project.sources.length} onClick={() => setEvidence([...evidence, { source_id: '', quote: '' }])}><Plus />添加证据</button></div>
          <p className="hint">保存时会检查每段引文是否逐字出现在所选来源的原文里，并标出通过或未通过。</p>
        </div>
      </div>
    </Modal>
  );
}

function CitationCheck({ check, truncated }: { check: any; truncated?: number[] }) {
  if (!check) return null;
  return (
    <div className="stack sm">
      <div className="row wrap small">
        <ShieldCheck size={15} className="faint" />
        {check.cited?.length ? <span>引用了 {check.cited.map((n: number) => <span key={n} className="seq-badge" style={{ marginRight: 4 }}>S{n}</span>)}</span> : <span className="muted">正文没有标注来源</span>}
        {check.unused?.length > 0 && <span className="faint">未用到：{check.unused.map((n: number) => `S${n}`).join('、')}</span>}
      </div>
      {check.invalid?.length > 0 && (
        <div className="banner danger small"><AlertTriangle /><div>出现了不存在的来源编号 {check.invalid.map((n: number) => `S${n}`).join('、')}。带这些编号的语句没有可追溯的依据，请不要直接采信。</div></div>
      )}
      {(truncated?.length || check.truncated?.length) ? <div className="xs faint">来源 {(truncated || check.truncated).map((n: number) => `S${n}`).join('、')} 篇幅较长，生成时只载入了开头部分。</div> : null}
    </div>
  );
}

type Tab = 'sources' | 'findings' | 'analysis' | 'reports';

export function ResearchDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { models, toast, fail } = useApp();
  const { data: p, setData, loading, error } = useData(() => api.get(`/research/${id}`), [id]);
  const tasks = useData(() => api.get<{ id: string; name: string }[]>('/research-tasks'), []);
  const { busy, run } = useAction();
  const [tab, setTab] = useState<Tab>('sources');
  const [modal, setModal] = useState<null | { kind: 'paste' | 'fetch' | 'document' | 'finding' | 'view'; data?: any; preset?: any }>(null);
  const [filter, setFilter] = useState('all');
  const [focus, setFocus] = useState('');
  const [analysis, setAnalysis] = useState<any | null>(null);
  const [checks, setChecks] = useState<Record<string, any>>({});
  const [openReport, setOpenReport] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', question: '' });

  useEffect(() => { if (p) { setDraft({ title: p.title, question: p.question }); setOpenReport((r) => r || p.reports[0]?.id || ''); } /* eslint-disable-next-line */ }, [p?.id]);

  if (loading && !p) return <div className="page"><Loading /></div>;
  if (error || !p) return <div className="page"><Empty title="找不到这个研究项目"><Link className="link" to="/research">返回研究实验室</Link></Empty></div>;

  const patch = (body: Record<string, unknown>) => run('save', async () => { setData(await api.patch(`/research/${id}`, body)); });
  const removeProject = async () => {
    if (!window.confirm(`确定删除研究项目「${p.title}」吗？其中的来源、发现和报告会一并删除（已存入知识库的内容不受影响）。`)) return;
    try { await api.del(`/research/${id}`); navigate('/research'); } catch (err) { fail(err); }
  };
  const delSource = async (s: any) => { if (!confirmDelete(`来源 S${s.seq}「${s.title}」`)) return; try { setData(await api.del(`/research/sources/${s.id}`)); } catch (err) { fail(err); } };
  const delFinding = async (f: any) => { if (!confirmDelete('这条记录')) return; try { setData(await api.del(`/research/findings/${f.id}`)); } catch (err) { fail(err); } };
  const viewSource = async (s: any) => { try { setModal({ kind: 'view', data: await api.get(`/research/sources/${s.id}`) }); } catch (err) { fail(err); } };
  const editSource = async (s: any) => { try { setModal({ kind: 'paste', data: await api.get(`/research/sources/${s.id}`) }); } catch (err) { fail(err); } };
  const factcheck = (f: any) => run(`fc-${f.id}`, async () => {
    const r = await api.post(`/research/findings/${f.id}/factcheck`, {});
    setData(r.project);
    setChecks((c) => ({ ...c, [f.id]: r.result }));
  });
  const analyze = (task: string) => run(`an-${task}`, async () => { setAnalysis(await api.post(`/research/${id}/analyze`, { task, focus })); });
  const report = () => run('report', async () => {
    const r = await api.post(`/research/${id}/report`, {});
    setData(r.project);
    setOpenReport(r.report_id);
    toast('报告已生成');
  });
  const saveKnowledge = (body: Record<string, unknown>) => run('kn', async () => {
    const r = await api.post(`/research/${id}/save-to-knowledge`, body);
    toast(r.existed ? '这份报告已在知识库中' : '已存入知识库');
    setData(await api.get(`/research/${id}`));
  });
  const delReport = async (r: any) => { if (!confirmDelete(`报告「${r.title}」`)) return; try { setData(await api.del(`/research/reports/${r.id}`)); setOpenReport(''); } catch (err) { fail(err); } };

  const findings = p.findings.filter((f: any) => filter === 'all' || f.kind === filter);
  const statusIndex = STATUS.findIndex((s) => s[0] === p.status);
  const hasText = p.sources.some((s: any) => s.chars > 0);
  const current = p.reports.find((r: any) => r.id === openReport);

  return (
    <div className="page">
      <Link className="back-link" to="/research">← 研究实验室</Link>
      <header className="page-head" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="eyebrow">Research Project</div>
          {editing ? (
            <div className="stack sm">
              <input className="input title-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="研究主题" />
              <textarea className="textarea" style={{ minHeight: 64 }} value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} placeholder="想回答的问题" />
              <div className="row">
                <button className="btn primary sm" disabled={!draft.title.trim()} onClick={async () => { await patch(draft); setEditing(false); }}>保存</button>
                <button className="btn sm" onClick={() => setEditing(false)}>取消</button>
              </div>
            </div>
          ) : <>
            <h1 className="page-title">{p.title}</h1>
            <p className="page-desc">{p.question || <span className="faint">还没有写下想回答的问题</span>}{' '}
              <button className="link small" onClick={() => setEditing(true)}><Pencil size={12} /> 编辑</button></p>
          </>}
        </div>
        <div className="steps" role="group" aria-label="研究阶段">
          {STATUS.map(([k, label], i) => <button key={k} className={i === statusIndex ? 'active' : i < statusIndex ? 'past' : ''} onClick={() => patch({ status: k })}>{label}</button>)}
        </div>
      </header>

      <Tabs
        value={tab} onChange={setTab}
        items={[
          { id: 'sources', label: '来源', count: p.sources.length }, { id: 'findings', label: '发现与核查', count: p.findings.length },
          { id: 'analysis', label: 'AI 分析' }, { id: 'reports', label: '研究报告', count: p.reports.length },
        ]}
      />

      {tab === 'sources' && (
        <div className="stack">
          <div className="row wrap">
            <button className="btn" onClick={() => setModal({ kind: 'paste' })}><ClipboardPaste />粘贴文本</button>
            <button className="btn" onClick={() => setModal({ kind: 'fetch' })}><Globe />抓取网页</button>
            <button className="btn" onClick={() => setModal({ kind: 'document' })}><FileText />使用上传的资料</button>
          </div>
          <div className="card">
            {!p.sources.length && <Empty title="先收集来源">每个来源会得到一个编号（S1、S2…）。之后 AI 的分析、事实核查和报告都只能引用这些来源，并且标明编号，方便回到原文核对。</Empty>}
            {p.sources.map((s: any) => (
              <div key={s.id} className="source-card">
                <span className="seq-badge" style={{ marginTop: 3 }}>S{s.seq}</span>
                <div className="grow">
                  <div className="row wrap" style={{ gap: 8 }}>
                    <b>{s.title}</b><span className="tag">{SOURCE_KIND[s.kind] || s.kind}</span>
                    {!s.chars && <span className="tag warn">没有原文</span>}
                  </div>
                  <div className="k-meta" style={{ marginTop: 4 }}>
                    {s.author && <span>{s.author}</span>}{s.published_at && <span>{s.published_at}</span>}
                    {s.url && <a className="link row" style={{ gap: 3 }} href={s.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={12} />{s.url.replace(/^https?:\/\//, '').slice(0, 48)}</a>}
                    <span>{chars(s.chars)}</span><span>收录于 {timeAgo(s.accessed_at)}</span>
                  </div>
                  {s.excerpt && <p className="small muted clamp-2" style={{ marginTop: 6 }}>{s.excerpt}</p>}
                  {s.note && <p className="small" style={{ marginTop: 6 }}>备注：{s.note}</p>}
                </div>
                <div className="row" style={{ gap: 2 }}>
                  <button className="btn ghost sm" onClick={() => viewSource(s)}>原文</button>
                  <button className="btn ghost icon sm" aria-label="编辑" onClick={() => editSource(s)}><Pencil /></button>
                  <button className="btn ghost icon sm" aria-label="删除" onClick={() => delSource(s)}><Trash2 /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'findings' && (
        <div className="stack">
          <div className="row between wrap">
            <div className="seg">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
              {Object.entries(KIND).map(([k, v]) => <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{k === 'event' ? '时间线' : v}</button>)}
            </div>
            <button className="btn primary" onClick={() => setModal({ kind: 'finding', preset: { kind: filter === 'all' ? 'claim' : filter } })}><Plus />记录发现</button>
          </div>
          <AiNotice compact />
          {!findings.length && <div className="card"><Empty title="还没有记录">读来源时，把值得核查的说法记为「陈述」，把不同立场记为「观点」，把带时间的事记为「事件」。陈述可以让 AI 对照来源做事实核查。</Empty></div>}
          {filter === 'event' ? (
            <div className="card pad"><div className="timeline">
              {findings.map((f: any) => (
                <div key={f.id} className="timeline-item">
                  <div className="row between top">
                    <div><div className="timeline-date">{f.event_date || '时间未填'}</div><div>{f.title}</div>{f.content && <div className="small muted">{f.content}</div>}</div>
                    <div className="row" style={{ gap: 2 }}>
                      <button className="btn ghost icon sm" aria-label="编辑" onClick={() => setModal({ kind: 'finding', data: f })}><Pencil /></button>
                      <button className="btn ghost icon sm" aria-label="删除" onClick={() => delFinding(f)}><Trash2 /></button>
                    </div>
                  </div>
                  {f.evidence.map((e: any, i: number) => <div key={i} className={`evidence ${e.verified ? 'verified' : 'unverified'}`}><span className="seq-badge">S{e.seq}</span> <span className="q">{e.quote || '（未摘录引文）'}</span></div>)}
                </div>
              ))}
            </div></div>
          ) : findings.map((f: any) => (
            <div key={f.id} className="card pad">
              <div className="row between top">
                <div className="grow">
                  <div className="row wrap" style={{ gap: 8, marginBottom: 4 }}>
                    <span className="tag outline">{KIND[f.kind]}</span>
                    {f.kind === 'claim' && <span className={`tag verdict-${f.verdict}`}>{VERDICT[f.verdict]}</span>}
                    {f.holder && <span className="small muted">{f.holder}</span>}
                    {f.event_date && <span className="small muted">{f.event_date}</span>}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 15.5 }}>{f.title}</div>
                  {f.content && <div className="small muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{f.content}</div>}
                </div>
                <div className="row" style={{ gap: 2 }}>
                  {f.kind === 'claim' && (
                    <button className="btn sm" disabled={busy === `fc-${f.id}` || !models.configured || !hasText} onClick={() => factcheck(f)} title={!hasText ? '需要先有带原文的来源' : ''}>
                      {busy === `fc-${f.id}` ? <Spinner /> : <ScanSearch />}对照来源核查
                    </button>
                  )}
                  <button className="btn ghost icon sm" aria-label="编辑" onClick={() => setModal({ kind: 'finding', data: f })}><Pencil /></button>
                  <button className="btn ghost icon sm" aria-label="删除" onClick={() => delFinding(f)}><Trash2 /></button>
                </div>
              </div>
              {checks[f.id] && (
                <div className={`banner small ${checks[f.id].downgraded ? 'warn' : ''}`} style={{ marginTop: 10 }}>
                  <ScanSearch />
                  <div>
                    {checks[f.id].reasoning}
                    {checks[f.id].downgraded && <><br /><b>模型给出的引文都没有在来源原文中找到，结论已自动改为「未核实」。</b></>}
                    {checks[f.id].truncated_sources?.length > 0 && <><br />来源 {checks[f.id].truncated_sources.map((n: number) => `S${n}`).join('、')} 较长，核查时只载入了开头部分。</>}
                  </div>
                </div>
              )}
              {f.evidence.map((e: any, i: number) => (
                <div key={i} className={`evidence ${e.verified ? 'verified' : 'unverified'}`}>
                  <div className="row wrap xs" style={{ gap: 6, marginBottom: 2 }}>
                    <span className="seq-badge">S{e.seq}</span>
                    {e.verified ? <span className="row" style={{ gap: 3, color: 'var(--ok)' }}><Check size={12} />引文已在原文中找到</span> : <span className="row" style={{ gap: 3, color: 'var(--danger)' }}><X size={12} />{e.quote ? '原文中找不到这段引文' : '没有摘录引文'}</span>}
                  </div>
                  {e.quote && <div className="q">「{e.quote}」</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === 'analysis' && (
        <div className="stack lg">
          <AiNotice />
          {!hasText && <div className="banner"><AlertTriangle /><div>这个项目还没有带原文的来源。请先到「来源」里添加资料——AI 只会依据你收集的来源进行分析，不会凭记忆补充。</div></div>}
          <div className="card pad stack">
            <Field label="特别关注（可选）"><input className="input" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="例如：重点看经济因素" /></Field>
            <div className="row wrap">
              {tasks.data?.map((t) => (
                <button key={t.id} className="btn" disabled={!!busy || !models.configured || !hasText} onClick={() => analyze(t.id)}>{busy === `an-${t.id}` ? <Spinner /> : <Sparkles />}{t.name}</button>
              ))}
            </div>
            <p className="hint">分析结果不会自动保存。满意的话可以存为研究笔记或存入知识库。</p>
          </div>
          {analysis && (
            <div className="card pad stack">
              <div className="row between wrap">
                <h2 style={{ fontSize: 17 }}>{analysis.task}</h2>
                <div className="row">
                  <button className="btn sm" onClick={() => setModal({ kind: 'finding', preset: { kind: 'note', title: `${analysis.task}（AI 分析）`, content: analysis.content } })}><Plus />存为研究笔记</button>
                  <button className="btn sm" disabled={busy === 'kn'} onClick={() => saveKnowledge({ title: `${p.title} · ${analysis.task}`, content: analysis.content })}><BookmarkPlus />存入知识库</button>
                </div>
              </div>
              <CitationCheck check={analysis.citation_check} truncated={analysis.truncated_sources} />
              <hr className="rule" style={{ margin: 0 }} />
              <Markdown>{analysis.content}</Markdown>
            </div>
          )}
        </div>
      )}

      {tab === 'reports' && (
        <div className="stack lg">
          <AiNotice />
          <div className="row wrap">
            <button className="btn primary" disabled={busy === 'report' || !models.configured || !hasText} onClick={report}>{busy === 'report' ? <Spinner /> : <Sparkles />}{busy === 'report' ? '正在撰写报告…' : '生成研究报告'}</button>
            <span className="hint">依据 {p.sources.filter((s: any) => s.chars > 0).length} 个来源和 {p.findings.length} 条发现。来源列表由系统根据编号自动附上，不由模型生成。</span>
          </div>
          {!p.reports.length && <div className="card"><Empty title="还没有报告">来源和发现整理得差不多时，生成一份结构化报告。报告里每个事实都应带有来源编号，系统会校验编号是否真实存在。</Empty></div>}
          {p.reports.length > 1 && (
            <div className="row wrap" style={{ gap: 6 }}>
              {p.reports.map((r: any) => <button key={r.id} className={`tag ${openReport === r.id ? 'active' : ''}`} onClick={() => setOpenReport(r.id)}>{r.title.slice(0, 20)} · {timeAgo(r.created_at)}</button>)}
            </div>
          )}
          {current && (
            <article className="card pad stack">
              <div className="row between wrap">
                <span className="xs faint">生成于 {timeAgo(current.created_at)}</span>
                <div className="row">
                  {current.knowledge_id
                    ? <Link className="btn sm" to={`/knowledge/${current.knowledge_id}`}><Check />已在知识库</Link>
                    : <button className="btn sm" disabled={busy === 'kn'} onClick={() => saveKnowledge({ report_id: current.id })}><BookmarkPlus />存入知识库</button>}
                  <button className="btn ghost icon sm" aria-label="删除" onClick={() => delReport(current)}><Trash2 /></button>
                </div>
              </div>
              <CitationCheck check={current.citation_check} />
              <hr className="rule" style={{ margin: 0 }} />
              <Markdown>{current.content}</Markdown>
            </article>
          )}
        </div>
      )}

      <div style={{ marginTop: 32 }}><button className="btn ghost danger sm" onClick={removeProject}><Trash2 />删除这个研究项目</button></div>

      {modal && ['paste', 'fetch', 'document'].includes(modal.kind) && (
        <SourceModal projectId={id} mode={modal.kind as 'paste'} source={modal.data} onClose={() => setModal(null)} onSaved={setData} />
      )}
      {modal?.kind === 'finding' && <FindingModal project={p} finding={modal.data} preset={modal.preset} onClose={() => setModal(null)} onSaved={setData} />}
      {modal?.kind === 'view' && (
        <Modal title={`S${modal.data.seq} · ${modal.data.title}`} wide onClose={() => setModal(null)}>
          <div className="modal-body" style={{ paddingBottom: 24 }}>
            {modal.data.url && <a className="link small" href={modal.data.url} target="_blank" rel="noreferrer noopener">{modal.data.url}</a>}
            <div className="plain-text" style={{ maxHeight: '60vh', overflowY: 'auto' }}>{modal.data.content || '（这个来源没有保存原文）'}</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
