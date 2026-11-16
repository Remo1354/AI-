import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Download, FileText, FlaskConical, Link2, MessageSquareText, NotebookPen, Pencil, Pin, Plus, Quote, Search, Sparkles, Trash2, Upload, X,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import { bytes, chars, timeAgo } from '../lib/format';
import { useAction, useApp, useData } from '../lib/store';
import { AiNotice, DomainSelect, DomainTag, Empty, Field, Loading, Markdown, Modal, PageHead, Snippet, Spinner, Tabs, confirmDelete } from '../components/ui';

const TYPES: Record<string, { label: string; icon: typeof FileText }> = {
  note: { label: '笔记', icon: NotebookPen },
  document: { label: '资料', icon: FileText },
  excerpt: { label: '对话摘录', icon: Quote },
  research: { label: '研究成果', icon: FlaskConical },
  summary: { label: '总结', icon: NotebookPen },
};
const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.srt';

function NoteModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const { categories, fail } = useApp();
  const [f, setF] = useState({ title: '', content: '', category_id: '', domain_id: '', tags: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const item = await api.post('/knowledge', { ...f, tags: f.tags.split(/[,，\s]+/).filter(Boolean) });
      onSaved(item.id);
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="新建笔记" wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy || !f.title.trim()} onClick={save}>保存</button>
    </>}>
      <div className="modal-body">
        <Field label="标题"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="这条知识讲的是什么" /></Field>
        <Field label="内容" hint="支持 Markdown"><textarea className="textarea" style={{ minHeight: 200 }} value={f.content} onChange={(e) => set('content', e.target.value)} /></Field>
        <div className="form-grid">
          <Field label="分类">
            <select className="select" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
              <option value="">未分类</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="学习方向"><DomainSelect value={f.domain_id} onChange={(v) => set('domain_id', v)} /></Field>
          <Field label="标签" hint="用空格或逗号分隔" className="full"><input className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { categories, toast } = useApp();
  const [category, setCategory] = useState('');
  const [domainId, setDomainId] = useState('');
  const [over, setOver] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; note: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const handle = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const file of Array.from(files)) {
      try {
        const r = await api.upload('/documents', { file, to_knowledge: '1', category_id: category, domain_id: domainId });
        const d = r.document;
        const note = d.status === 'ready'
          ? `${r.duplicate ? '已存在，未重复保存 · ' : ''}提取到 ${chars(d.chars)}${d.pages ? ` · ${d.pages} 页` : ''}`
          : d.error || '没有提取到文字';
        setResults((s) => [...s, { name: file.name, ok: d.status === 'ready', note }]);
      } catch (err) {
        setResults((s) => [...s, { name: file.name, ok: false, note: (err as Error).message }]);
      }
    }
    setBusy(false);
    onDone();
    toast('上传处理完成');
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files); };

  return (
    <Modal title="上传学习资料" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>完成</button>}>
      <div className="modal-body">
        <div className="form-grid">
          <Field label="分类">
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">未分类</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="学习方向"><DomainSelect value={domainId} onChange={setDomainId} /></Field>
        </div>
        <input ref={input} type="file" hidden multiple accept={ACCEPT} onChange={(e) => { handle(e.target.files); e.target.value = ''; }} />
        <div
          className={`dropzone ${over ? 'over' : ''}`} role="button" tabIndex={0}
          onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter') input.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
        >
          {busy ? <Spinner /> : <Upload />}
          <div>{busy ? '正在上传并提取文字…' : '点击选择文件，或把文件拖到这里'}</div>
          <div className="xs">PDF、DOCX、TXT、Markdown 等文本文件。文字会自动提取并建立全文索引。</div>
        </div>
        {results.map((r, i) => (
          <div key={i} className={`banner ${r.ok ? 'ok' : 'danger'} small`}>
            <FileText /><div><b>{r.name}</b><br />{r.note}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function Knowledge() {
  const { categories, refresh, fail } = useApp();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const tag = params.get('tag') || '';
  const type = params.get('type') || '';
  const domainId = params.get('domain') || '';
  const [input, setInput] = useState(q);
  const [modal, setModal] = useState<'note' | 'upload' | null>(null);

  const list = useData(() => api.get(`/knowledge${qs({ q, category_id: category, tag, type, domain_id: domainId })}`), [q, category, tag, type, domainId]);
  const tags = useData(() => api.get<{ name: string; count: number }[]>('/tags'), []);

  // 从别处带着 ?doc= 过来：跳到这份资料对应的知识条目
  useEffect(() => {
    const doc = params.get('doc');
    if (!doc) return;
    api.get(`/documents/${doc}`).then(async (d) => {
      if (d.knowledge?.[0]) return navigate(`/knowledge/${d.knowledge[0].id}`, { replace: true });
      const item = await api.post('/knowledge', { title: d.title, document_id: d.id }).catch(() => null);
      if (item) navigate(`/knowledge/${item.id}`, { replace: true });
    }).catch(() => setParams({}, { replace: true }));
  }, [params, navigate, setParams]);

  useEffect(() => { setInput(q); }, [q]);
  useEffect(() => {
    const t = setTimeout(() => { if (input.trim() !== q) update({ q: input.trim() }); }, 280);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };
  const addCategory = async () => {
    const name = window.prompt('新分类的名称')?.trim();
    if (!name) return;
    try { await api.post('/categories', { name }); refresh(); } catch (err) { fail(err); }
  };
  const editCategory = async (c: { id: string; name: string }) => {
    const name = window.prompt('分类名称（清空并确定可删除该分类，条目会变为未分类）', c.name);
    if (name === null) return;
    try {
      if (!name.trim()) { await api.del(`/categories/${c.id}`); if (category === c.id) update({ category: '' }); }
      else await api.patch(`/categories/${c.id}`, { name: name.trim() });
      refresh(); list.reload();
    } catch (err) { fail(err); }
  };

  const items: any[] = list.data?.items || [];
  const filtered = !!(q || category || tag || type || domainId);

  return (
    <div className="page">
      <PageHead
        eyebrow="Knowledge Base" title="知识库"
        desc="笔记、资料、对话摘录和研究成果都沉淀在这里，可以全文检索、互相关联。"
        actions={<>
          <a className="btn" href="/api/knowledge/export" download><Download />导出 Markdown</a>
          <button className="btn" onClick={() => setModal('upload')}><Upload />上传资料</button>
          <button className="btn primary" onClick={() => setModal('note')}><Plus />新建笔记</button>
        </>}
      />
      <div className="split side-left">
        <aside>
          <div className="side-block">
            <div className="side-title">分类</div>
            <div className="side-nav">
              <button className={!category ? 'active' : ''} onClick={() => update({ category: '' })}>全部<span className="count">{list.data && !filtered ? items.length : ''}</span></button>
              {categories.map((c) => (
                <button key={c.id} className={category === c.id ? 'active' : ''} onClick={() => update({ category: c.id })} onDoubleClick={() => editCategory(c)} title="双击可重命名或删除">
                  <span className="truncate">{c.name}</span><span className="count">{c.count || ''}</span>
                </button>
              ))}
              <button onClick={addCategory} className="faint"><span className="row" style={{ gap: 6 }}><Plus size={14} />新建分类</span></button>
            </div>
          </div>
          <div className="side-block">
            <div className="side-title">类型</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {Object.entries(TYPES).filter(([k]) => k !== 'summary').map(([k, t]) => (
                <button key={k} className={`tag ${type === k ? 'active' : ''}`} onClick={() => update({ type: type === k ? '' : k })}>{t.label}</button>
              ))}
            </div>
          </div>
          {!!tags.data?.length && (
            <div className="side-block">
              <div className="side-title">标签</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {tags.data.slice(0, 30).map((t) => (
                  <button key={t.name} className={`tag ${tag === t.name ? 'active' : ''}`} onClick={() => update({ tag: tag === t.name ? '' : t.name })}>#{t.name}<span className="faint">{t.count}</span></button>
                ))}
              </div>
            </div>
          )}
        </aside>

        <div className="stack">
          <div className="search-box">
            <Search />
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="全文搜索：标题、正文、摘要，以及上传资料的内容" aria-label="搜索知识库" />
          </div>
          {filtered && (
            <div className="row wrap small muted">
              <span>{list.loading ? '搜索中…' : `找到 ${items.length} 条`}</span>
              {domainId && <DomainTag id={domainId} />}
              <button className="link" onClick={() => { setInput(''); setParams({}, { replace: true }); }}>清除筛选</button>
            </div>
          )}
          <div className="card">
            {list.loading && !list.data && <Loading />}
            {list.data && !items.length && (filtered
              ? <Empty title="没有匹配的内容">换一个关键词，或清除筛选条件。</Empty>
              : <Empty title="知识库还是空的">从一条笔记或一份资料开始。和 AI 助手对话时，也可以把有价值的回答一键存进来。</Empty>)}
            {items.map((it) => {
              const T = TYPES[it.type] || TYPES.note;
              return (
                <Link key={it.id} to={`/knowledge/${it.id}`} className="k-item">
                  <h3><T.icon className="type-icon" /><span className="truncate">{it.title}</span>{it.pinned && <Pin size={13} className="faint" />}</h3>
                  <p className="clamp-2">{it.snippet ? <Snippet text={it.snippet} /> : it.summary || it.content || (it.type === 'document' ? '上传的资料，尚未生成摘要' : '')}</p>
                  <div className="k-meta">
                    <span>{T.label}</span>
                    <DomainTag id={it.domain_id} />
                    {it.tags.map((t: string) => <span key={t} className="tag">#{t}</span>)}
                    <span>{timeAgo(it.updated_at)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {modal === 'note' && <NoteModal onClose={() => setModal(null)} onSaved={(id) => { refresh(); navigate(`/knowledge/${id}`); }} />}
      {modal === 'upload' && <UploadModal onClose={() => setModal(null)} onDone={() => { list.reload(); tags.reload(); refresh(); }} />}
    </div>
  );
}

function LinkPicker({ itemId, onClose, onLinked }: { itemId: string; onClose: () => void; onLinked: (d: any) => void }) {
  const { fail } = useApp();
  const [q, setQ] = useState('');
  const [relation, setRelation] = useState('相关');
  const results = useData(() => api.get(`/knowledge${qs({ q })}`), [q]);
  const link = async (to: string) => {
    try { onLinked(await api.post(`/knowledge/${itemId}/links`, { to_id: to, relation })); onClose(); } catch (err) { fail(err); }
  };
  return (
    <Modal title="关联到另一条知识" onClose={onClose}>
      <div className="modal-body" style={{ paddingBottom: 24 }}>
        <div className="form-grid">
          <Field label="搜索"><input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入标题或关键词" /></Field>
          <Field label="关系">
            <select className="select" value={relation} onChange={(e) => setRelation(e.target.value)}>
              {['相关', '延伸', '前置知识', '例证', '对比', '反驳'].map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <div className="list" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {(results.data?.items || []).filter((i: any) => i.id !== itemId).slice(0, 30).map((i: any) => (
            <button key={i.id} className="list-row" onClick={() => link(i.id)}>
              <div className="grow"><div className="truncate">{i.title}</div><div className="xs faint">{TYPES[i.type]?.label}</div></div>
              <Link2 size={15} className="faint" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function KnowledgeDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { categories, models, toast, fail, refresh } = useApp();
  const { data: item, setData, loading, error } = useData(() => api.get(`/knowledge/${id}`), [id]);
  const suggestions = useData(() => api.get<any[]>(`/knowledge/${id}/suggestions`), [id]);
  const { busy, run } = useAction();
  const [tab, setTab] = useState<'content' | 'digest' | 'source' | 'links'>('content');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', content: '', tags: '' });
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!item) return;
    setDraft({ title: item.title, content: item.content, tags: item.tags.join(' ') });
    setTab(item.type === 'document' && !item.content ? (item.summary ? 'digest' : 'source') : 'content');
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  if (loading && !item) return <div className="page"><Loading /></div>;
  if (error || !item) return <div className="page"><Empty title="找不到这条知识"><Link className="link" to="/knowledge">返回知识库</Link></Empty></div>;

  const patch = (body: Record<string, unknown>) => run('save', async () => { setData(await api.patch(`/knowledge/${id}`, body)); refresh(); });
  const saveEdit = async () => {
    await patch({ title: draft.title, content: draft.content, tags: draft.tags.split(/[,，\s]+/).filter(Boolean) });
    setEditing(false);
    toast('已保存');
  };
  const summarize = () => run('ai', async () => { setData(await api.post(`/knowledge/${id}/summarize`)); setTab('digest'); toast('已生成摘要和知识点'); });
  const remove = async () => {
    if (!confirmDelete(`「${item.title}」`)) return;
    try { await api.del(`/knowledge/${id}`); refresh(); navigate('/knowledge'); } catch (err) { fail(err); }
  };
  const ask = async () => {
    try {
      const conv = await api.post('/conversations', { title: `关于「${item.title.slice(0, 24)}」`, domain_id: item.domain_id, document_ids: item.document ? [item.document.id] : [] });
      const draftText = item.document ? '请先概括这份资料的核心内容，然后告诉我应该重点掌握哪些部分。' : `请基于下面这条笔记帮我深入理解，并指出可以进一步学习的方向：\n\n${item.title}\n${item.content || item.summary}`;
      navigate(`/assistant/${conv.id}`, { state: { draft: draftText, send: false } });
    } catch (err) { fail(err); }
  };
  const unlink = async (linkId: string) => {
    try { await api.del(`/knowledge/links/${linkId}`); setData(await api.get(`/knowledge/${id}`)); suggestions.reload(); } catch (err) { fail(err); }
  };
  const linkTo = async (to: string) => {
    try { setData(await api.post(`/knowledge/${id}/links`, { to_id: to })); suggestions.reload(); } catch (err) { fail(err); }
  };

  const T = TYPES[item.type] || TYPES.note;
  const tabs = [
    { id: 'content' as const, label: '正文' },
    { id: 'digest' as const, label: '摘要与知识点', count: item.key_points.length || undefined },
    ...(item.document ? [{ id: 'source' as const, label: '资料原文' }] : []),
    { id: 'links' as const, label: '关联', count: item.links.length || undefined },
  ];

  return (
    <div className="page">
      <Link className="back-link" to="/knowledge">← 知识库</Link>
      <div className="split">
        <article className="stack lg" style={{ gap: 20 }}>
          <header>
            <div className="eyebrow row" style={{ gap: 6 }}><T.icon size={13} />{T.label}</div>
            {editing
              ? <input className="input title-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="标题" />
              : <h1 className="page-title">{item.title}</h1>}
            <div className="k-meta">
              <DomainTag id={item.domain_id} />
              {item.tags.map((t: string) => <Link key={t} className="tag" to={`/knowledge?tag=${encodeURIComponent(t)}`}>#{t}</Link>)}
              <span>更新于 {timeAgo(item.updated_at)}</span>
            </div>
          </header>

          <Tabs items={tabs} value={tab} onChange={setTab} />

          {tab === 'content' && (editing ? (
            <div className="stack">
              <textarea className="textarea tall" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="支持 Markdown" aria-label="正文" />
              <Field label="标签" hint="用空格或逗号分隔"><input className="input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} /></Field>
              <div className="row">
                <button className="btn primary" onClick={saveEdit} disabled={busy === 'save' || !draft.title.trim()}>保存</button>
                <button className="btn" onClick={() => { setEditing(false); setDraft({ title: item.title, content: item.content, tags: item.tags.join(' ') }); }}>取消</button>
              </div>
            </div>
          ) : item.content ? <Markdown>{item.content}</Markdown> : (
            <Empty compact title={item.document ? '这是一份上传的资料' : '还没有正文'}>
              {item.document ? '原文在「资料原文」里。可以在这里写下自己的笔记，或让 AI 提炼摘要。' : '点击右侧的「编辑」开始写。'}
            </Empty>
          ))}

          {tab === 'digest' && (
            <div className="stack lg">
              {!item.summary && !item.key_points.length && (
                <Empty compact title="还没有摘要">让 AI 阅读{item.document ? '资料全文' : '正文'}，提炼出摘要、知识点和标签。结果会保存下来并进入全文索引。</Empty>
              )}
              {item.summary && <div><div className="side-title">摘要</div><p style={{ lineHeight: 1.85 }}>{item.summary}</p></div>}
              {item.key_points.length > 0 && (
                <div>
                  <div className="side-title">知识点</div>
                  {item.key_points.map((p: string, i: number) => <div key={i} className="point"><i>{i + 1}</i><span>{p}</span></div>)}
                </div>
              )}
              <AiNotice compact />
              <div><button className="btn" onClick={summarize} disabled={busy === 'ai' || !models.configured}>{busy === 'ai' ? <Spinner /> : <Sparkles />}{item.summary ? '重新提炼' : 'AI 提炼摘要与知识点'}</button></div>
            </div>
          )}

          {tab === 'source' && item.document && (
            <div className="stack">
              <div className="row wrap small muted">
                <span>{item.document.filename}</span><span>{bytes(item.document.size)}</span>
                {item.document.pages && <span>{item.document.pages} 页</span>}<span>{chars(item.document.chars)}</span>
                <a className="link" href={`/api/documents/${item.document.id}/file`}>下载原文件</a>
              </div>
              {item.document.status !== 'ready'
                ? <div className="banner warn"><X /><div>{item.document.error || '这份文件没有可用的文字内容。'}</div></div>
                : <div className="card pad plain-text">{item.document.text}</div>}
              {item.document.text_truncated && <p className="xs faint">原文较长，这里只显示开头部分。全文已建立索引，可以搜索，也可以让 AI 基于全文回答。</p>}
            </div>
          )}

          {tab === 'links' && (
            <div className="stack lg">
              <div className="card">
                {!item.links.length && <Empty compact title="还没有关联">把相关的知识连起来，复习时可以顺着线索走。</Empty>}
                <div className="list divided">
                  {item.links.map((l: any) => (
                    <div key={l.id + l.direction} className="list-row hoverable" style={{ padding: '12px 16px' }}>
                      <span className="tag outline">{l.direction === 'in' ? `被引用 · ${l.relation}` : l.relation}</span>
                      <Link to={`/knowledge/${l.item_id}`} className="grow truncate">{l.title}</Link>
                      <div className="actions"><button className="btn ghost icon sm" onClick={() => unlink(l.id)} aria-label="取消关联"><X /></button></div>
                    </div>
                  ))}
                </div>
              </div>
              <div><button className="btn" onClick={() => setPicking(true)}><Link2 />添加关联</button></div>
              {!!suggestions.data?.length && (
                <div>
                  <div className="side-title">可能相关（按内容相似度）</div>
                  <div className="list">
                    {suggestions.data.map((s) => (
                      <div key={s.id} className="list-row hoverable">
                        <Link to={`/knowledge/${s.id}`} className="grow truncate">{s.title}</Link>
                        <button className="btn sm" onClick={() => linkTo(s.id)}><Plus />关联</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </article>

        <aside className="stack lg">
          <div className="stack sm">
            {!editing && <button className="btn block" onClick={() => { setEditing(true); setTab('content'); }}><Pencil />编辑</button>}
            <button className="btn block" onClick={ask}><MessageSquareText />就此内容问 AI</button>
            <button className="btn block" onClick={summarize} disabled={busy === 'ai' || !models.configured}>{busy === 'ai' ? <Spinner /> : <Sparkles />}AI 提炼</button>
            <button className="btn block" onClick={() => patch({ pinned: !item.pinned })}><Pin />{item.pinned ? '取消置顶' : '置顶'}</button>
          </div>
          <div className="stack">
            <Field label="分类">
              <select className="select" value={item.category_id || ''} onChange={(e) => patch({ category_id: e.target.value })}>
                <option value="">未分类</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="学习方向"><DomainSelect value={item.domain_id} onChange={(v) => patch({ domain_id: v })} /></Field>
          </div>
          {(item.source_kind === 'conversation' || item.source_kind === 'research' || item.source_url || item.plans.length > 0) && (
            <div>
              <div className="side-title">来源与引用</div>
              <div className="stack sm small">
                {item.source_kind === 'conversation' && item.source_id && <Link className="link" to={`/assistant/${item.source_id}`}>来自一次 AI 对话 →</Link>}
                {item.source_kind === 'research' && item.source_id && <Link className="link" to={`/research/${item.source_id}`}>来自研究项目 →</Link>}
                {item.source_url && <a className="link truncate" href={item.source_url} target="_blank" rel="noreferrer noopener">{item.source_url}</a>}
                {item.plans.map((p: any) => <Link key={p.id} className="link" to={`/learning/plans/${p.id}`}>学习计划：{p.title}</Link>)}
              </div>
            </div>
          )}
          <button className="btn ghost danger sm" onClick={remove} style={{ alignSelf: 'flex-start' }}><Trash2 />删除这条知识</button>
        </aside>
      </div>
      {picking && <LinkPicker itemId={id} onClose={() => setPicking(false)} onLinked={(d) => { setData(d); suggestions.reload(); }} />}
    </div>
  );
}
