import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, FlaskConical, Image as ImageIcon, Link2, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { dayLabel, localDate, parseDate, timeAgo } from '../lib/format';
import { useAction, useApp, useData } from '../lib/store';
import { AiNotice, Empty, Field, Loading, Markdown, Modal, Spinner, Tabs, confirmDelete } from '../components/ui';

const STATUS: [string, string][] = [['idea', '灵感'], ['research', '研究'], ['script', '脚本'], ['production', '制作'], ['scheduled', '待发布'], ['published', '已发布']];
const STATUS_LABEL = Object.fromEntries(STATUS);
const METRICS: [string, string][] = [['views', '播放 / 阅读'], ['likes', '点赞'], ['saves', '收藏'], ['comments', '评论'], ['shares', '转发'], ['followers', '涨粉']];
const PLATFORMS = ['小红书', 'B 站', '抖音', '微信公众号', '微博', 'YouTube', 'Instagram'];
const FORMATS = ['视频', '图文', '过程分享', '教程', '作品展示', '直播'];

// ── 视觉参考 ─────────────────────────────────────────────────
function RefModal({ item, topicId, topics, onClose, onSaved }: { item?: any; topicId?: string; topics: any[]; onClose: () => void; onSaved: () => void }) {
  const { fail } = useApp();
  const [f, setF] = useState({ title: item?.title || '', note: item?.note || '', tags: item?.tags || '', url: item?.url || '', topic_id: item?.topic_id || topicId || '', palette: (item?.palette || []).join(' ') });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      if (item) await api.patch(`/studio/refs/${item.id}`, { ...f, palette: f.palette.split(/[\s,，]+/) });
      else if (files.length) for (const file of files) await api.upload('/studio/refs', { file, title: files.length === 1 ? f.title : '', note: f.note, tags: f.tags, topic_id: f.topic_id, palette: f.palette });
      else await api.post('/studio/refs', { ...f, palette: f.palette.split(/[\s,，]+/) });
      onSaved();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={item ? '编辑视觉参考' : '添加视觉参考'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn accent" onClick={save} disabled={busy || (!item && !files.length && !f.url.trim())}>{busy ? <Spinner /> : null}保存</button>
    </>}>
      <div className="modal-body">
        {!item && <>
          <input ref={input} type="file" hidden multiple accept="image/*" onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          <button className="btn block" onClick={() => input.current?.click()}><Upload />{files.length ? `已选择 ${files.length} 张图片` : '上传图片（可多选）'}</button>
          {!files.length && <Field label="或者保存一个链接"><input className="input" value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…" /></Field>}
        </>}
        {(item || files.length <= 1) && <Field label="标题"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="这张参考好在哪" /></Field>}
        <Field label="笔记"><textarea className="textarea" style={{ minHeight: 70 }} value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="构图、配色、光影、笔触…值得借鉴的地方" /></Field>
        <div className="form-grid">
          <Field label="标签"><input className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="配色 构图" /></Field>
          <Field label="关联选题">
            <select className="select" value={f.topic_id} onChange={(e) => set('topic_id', e.target.value)}>
              <option value="">不关联</option>
              {topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </Field>
          <Field label="色板" className="full" hint="手动记录的色值，空格分隔，例如 #B5432B #2E86B5"><input className="input" value={f.palette} onChange={(e) => set('palette', e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function RefCard({ r, onEdit, onDelete }: { r: any; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="ref-card">
      {r.image_url
        ? <a href={r.image_url} target="_blank" rel="noreferrer"><img src={r.image_url} alt={r.title} loading="lazy" /></a>
        : <a className="link-ref" href={r.url} target="_blank" rel="noreferrer noopener"><span><Link2 size={16} /><br />{r.url.replace(/^https?:\/\//, '').slice(0, 60)}</span></a>}
      <div className="body">
        <div className="row between top">
          <div className="small" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{r.title}</div>
          <div className="row" style={{ gap: 0 }}>
            <button className="btn ghost icon sm" aria-label="编辑" onClick={onEdit}><Pencil /></button>
            <button className="btn ghost icon sm" aria-label="删除" onClick={onDelete}><Trash2 /></button>
          </div>
        </div>
        {r.note && <div className="xs muted" style={{ marginTop: 2 }}>{r.note}</div>}
        {r.palette.length > 0 && <div className="palette-row" title={r.palette.join(' ')}>{r.palette.map((c: string) => <i key={c} style={{ background: c }} />)}</div>}
        <div className="xs faint" style={{ marginTop: 6 }}>{[r.tags, r.topic_title].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}

type Tab = 'board' | 'calendar' | 'refs' | 'review';

export function Studio() {
  const { fail } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'board';
  const topics = useData(() => api.get<any[]>('/studio/topics'), []);
  const refs = useData(() => api.get<any[]>('/studio/refs'), []);
  const [over, setOver] = useState('');
  const [quick, setQuick] = useState('');
  const [refModal, setRefModal] = useState<null | { item?: any }>(null);
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const today = localDate();

  const addIdea = async () => {
    const title = quick.trim();
    if (!title) return;
    setQuick('');
    try { await api.post('/studio/topics', { title }); topics.reload(); } catch (err) { fail(err); }
  };
  const move = async (id: string, status: string) => {
    topics.setData((list) => list?.map((t) => (t.id === id ? { ...t, status } : t)));
    try { await api.patch(`/studio/topics/${id}`, { status }); } catch (err) { fail(err); topics.reload(); }
  };
  const drop = (e: DragEvent, status: string) => { e.preventDefault(); setOver(''); const id = e.dataTransfer.getData('text/plain'); if (id) move(id, status); };
  const delRef = async (r: any) => { if (!confirmDelete('这条视觉参考')) return; try { await api.del(`/studio/refs/${r.id}`); refs.reload(); } catch (err) { fail(err); } };

  const list = topics.data || [];
  const published = list.filter((t) => t.status === 'published');
  const cells = useMemo(() => {
    const first = new Date(month);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // 周一开头
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [month]);
  const totals = METRICS.map(([k, label]) => [label, published.reduce((n, t) => n + (t.metrics?.[k] || 0), 0)] as const);

  return (
    <div className="page">
      <section className="studio-hero">
        <i className="layer-c" />
        <div className="eyebrow">Content Studio · Remo叠绘</div>
        <h1>叠绘工作室</h1>
        <p className="muted" style={{ marginTop: 8, maxWidth: 520 }}>从一个灵感，到研究、脚本、制作、发布和复盘。每一期内容都在这里一层一层叠出来。</p>
        <div className="row wrap" style={{ marginTop: 20, gap: 28 }}>
          <div><div className="stat-value">{list.filter((t) => !['idea', 'published'].includes(t.status)).length}</div><div className="stat-label">制作中</div></div>
          <div><div className="stat-value">{list.filter((t) => t.status === 'idea').length}</div><div className="stat-label">灵感池</div></div>
          <div><div className="stat-value">{published.length}</div><div className="stat-label">已发布</div></div>
          <div><div className="stat-value">{refs.data?.length ?? 0}</div><div className="stat-label">视觉参考</div></div>
        </div>
      </section>

      <Tabs
        value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })}
        items={[{ id: 'board', label: '选题板' }, { id: 'calendar', label: '发布日历' }, { id: 'refs', label: '视觉参考', count: refs.data?.length || undefined }, { id: 'review', label: '内容复盘', count: published.length || undefined }]}
      />

      {tab === 'board' && (
        <div className="stack">
          <div className="row" style={{ maxWidth: 560 }}>
            <input className="input" value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="记下一个选题灵感，回车保存" onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addIdea(); }} />
            <button className="btn accent" onClick={addIdea} disabled={!quick.trim()}><Plus />添加</button>
          </div>
          {topics.loading && !topics.data && <Loading />}
          <div className="board">
            {STATUS.map(([status, label]) => {
              const items = list.filter((t) => t.status === status);
              return (
                <div key={status} className={`board-col ${over === status ? 'over' : ''}`} data-status={status}
                  onDragOver={(e) => { e.preventDefault(); setOver(status); }} onDragLeave={() => setOver('')} onDrop={(e) => drop(e, status)}>
                  <div className="board-col-head"><b>{label}</b><span>{items.length || ''}</span></div>
                  {items.map((t) => (
                    <Link key={t.id} to={`/studio/${t.id}`} className="topic-card" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}>
                      <h4>{t.title}</h4>
                      {t.angle && <div className="xs muted clamp-2" style={{ marginTop: 4 }}>{t.angle}</div>}
                      <div className="meta">
                        {t.series && <span className="tag">{t.series}</span>}
                        {t.platform && <span>{t.platform}</span>}
                        {t.publish_date && <span className="row" style={{ gap: 3 }}><CalendarDays size={11} />{dayLabel(t.publish_date)}</span>}
                        {t.ref_count > 0 && <span className="row" style={{ gap: 3 }}><ImageIcon size={11} />{t.ref_count}</span>}
                      </div>
                    </Link>
                  ))}
                  {!items.length && <div className="xs faint" style={{ padding: '8px 4px' }}>{status === 'idea' ? '灵感先放这里' : '把卡片拖到这一列'}</div>}
                </div>
              );
            })}
          </div>
          <p className="hint">拖动卡片可以改变阶段；点开卡片写大纲和脚本。手机上请在选题详情里切换阶段。</p>
        </div>
      )}

      {tab === 'calendar' && (
        <div className="stack">
          <div className="row between">
            <h2 style={{ fontSize: 20 }}>{month.getFullYear()} 年 {month.getMonth() + 1} 月</h2>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn icon sm" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft /></button>
              <button className="btn sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); }}>本月</button>
              <button className="btn icon sm" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight /></button>
            </div>
          </div>
          <div className="cal">
            {['一', '二', '三', '四', '五', '六', '日'].map((d) => <div key={d} className="cal-head">周{d}</div>)}
            {cells.map((d) => {
              const key = localDate(0, d);
              const items = list.filter((t) => t.publish_date === key);
              return (
                <div key={key} className={`cal-day ${d.getMonth() !== month.getMonth() ? 'out' : ''} ${key === today ? 'today' : ''}`}>
                  <span className="d">{d.getDate()}</span>
                  {items.map((t) => <Link key={t.id} to={`/studio/${t.id}`} className="cal-item" data-status={t.status} title={`${t.title} · ${STATUS_LABEL[t.status]}`}>{t.title}</Link>)}
                </div>
              );
            })}
          </div>
          <p className="hint">在选题详情里设置「计划发布日期」，它就会出现在日历上。颜色表示所处阶段。</p>
        </div>
      )}

      {tab === 'refs' && (
        <div className="stack">
          <div><button className="btn accent" onClick={() => setRefModal({})}><Plus />添加视觉参考</button></div>
          {refs.data && !refs.data.length && <div className="card"><Empty title="参考板是空的">收集打动你的画面：构图、配色、光影、版式。上传图片或保存链接，写一句它好在哪。</Empty></div>}
          <div className="ref-grid">
            {refs.data?.map((r) => <RefCard key={r.id} r={r} onEdit={() => setRefModal({ item: r })} onDelete={() => delRef(r)} />)}
          </div>
        </div>
      )}

      {tab === 'review' && (
        <div className="stack lg">
          {!published.length ? <div className="card"><Empty title="还没有已发布的内容">内容发布后，把选题拖到「已发布」，在详情里填上数据和复盘。这里会汇总每一期的表现。</Empty></div> : <>
            <div className="card pad row wrap" style={{ gap: 36 }}>
              {totals.map(([label, n]) => <div key={label}><div className="stat-value">{n.toLocaleString()}</div><div className="stat-label">累计{label}</div></div>)}
            </div>
            <div className="card table-wrap">
              <table className="table">
                <thead><tr><th>内容</th><th>发布</th>{METRICS.map(([k, l]) => <th key={k}>{l}</th>)}<th>复盘</th></tr></thead>
                <tbody>{published.map((t) => (
                  <tr key={t.id}>
                    <td><Link className="link" to={`/studio/${t.id}?tab=retro`}>{t.title}</Link><div className="xs faint">{[t.platform, t.series].filter(Boolean).join(' · ')}</div></td>
                    <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{t.publish_date || '—'}</td>
                    {METRICS.map(([k]) => <td key={k} className="num">{t.metrics?.[k]?.toLocaleString() ?? '—'}</td>)}
                    <td>{t.has_retro ? <span className="tag ok">已复盘</span> : <span className="tag warn">待复盘</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>}
        </div>
      )}

      {refModal && <RefModal item={refModal.item} topics={list} onClose={() => setRefModal(null)} onSaved={() => { setRefModal(null); refs.reload(); topics.reload(); }} />}
    </div>
  );
}

// ── 选题详情 ─────────────────────────────────────────────────
type EditTab = 'notes' | 'outline' | 'script' | 'retro';
const EDIT_TABS: { id: EditTab; label: string; placeholder: string }[] = [
  { id: 'notes', label: '资料与笔记', placeholder: '收集到的素材、想讲的点、观众可能的疑问…' },
  { id: 'outline', label: '大纲', placeholder: '开头怎么说清这期讲什么、主体分几部分、结尾如何收束。' },
  { id: 'script', label: '脚本', placeholder: '逐段的口播或正文，可以用【画面】标注镜头。' },
  { id: 'retro', label: '复盘', placeholder: '数据说明了什么？哪些做法保留，哪些要改？' },
];

export function TopicDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { models, fail, toast } = useApp();
  const { data: t, setData, loading, error, reload } = useData(() => api.get(`/studio/topics/${id}`), [id]);
  const research = useData(() => api.get<any[]>('/research'), []);
  const { busy, run } = useAction();
  const [tab, setTab] = useState<EditTab>((params.get('tab') as EditTab) || 'notes');
  const [text, setText] = useState<Record<EditTab, string>>({ notes: '', outline: '', script: '', retro: '' });
  const [draft, setDraft] = useState<null | { task: string; name: string; field: EditTab | null; content: string }>(null);
  const [instruction, setInstruction] = useState('');
  const [refModal, setRefModal] = useState<null | { item?: any }>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => { if (t) setText({ notes: t.notes, outline: t.outline, script: t.script, retro: t.retro }); /* eslint-disable-next-line */ }, [t?.id]);

  if (loading && !t) return <div className="page"><Loading /></div>;
  if (error || !t) return <div className="page"><Empty title="找不到这个选题"><Link className="link" to="/studio">返回工作室</Link></Empty></div>;

  const patch = async (body: Record<string, unknown>, quiet = true) => {
    try { setData(await api.patch(`/studio/topics/${id}`, body)); if (!quiet) toast('已保存'); } catch (err) { fail(err); }
  };
  const dirty = text[tab] !== t[tab];
  const saveText = () => patch({ [tab]: text[tab] }, false);
  const ai = (task: string) => run(`ai-${task}`, async () => {
    if (dirty) await patch({ [tab]: text[tab] }); // 让 AI 看到最新内容
    setDraft(await api.post(`/studio/topics/${id}/draft`, { task, instruction }));
  });
  const apply = async (mode: 'replace' | 'append') => {
    if (!draft?.field) return;
    const next = mode === 'replace' ? draft.content : `${text[draft.field]}\n\n${draft.content}`.trim();
    setText((s) => ({ ...s, [draft.field!]: next }));
    await patch({ [draft.field]: next }, false);
    setTab(draft.field);
    setDraft(null);
  };
  const remove = async () => {
    if (!confirmDelete(`选题「${t.title}」`)) return;
    try { await api.del(`/studio/topics/${id}`); navigate('/studio'); } catch (err) { fail(err); }
  };
  const delRef = async (r: any) => { if (!confirmDelete('这条视觉参考')) return; try { await api.del(`/studio/refs/${r.id}`); reload(); } catch (err) { fail(err); } };
  const aiTasks: [string, string][] = tab === 'notes' ? [['titles', '标题与角度'], ['outline', '起草大纲']] : tab === 'outline' ? [['outline', '起草大纲'], ['script', '按大纲写脚本']] : tab === 'script' ? [['script', '起草脚本']] : [['retro', '复盘建议']];

  return (
    <div className="page" data-status={t.status}>
      <Link className="back-link" to="/studio">← 叠绘工作室</Link>
      <div className="split">
        <div className="stack lg" style={{ gap: 20 }}>
          <header>
            <div className="eyebrow">选题 · {STATUS_LABEL[t.status]}</div>
            <input className="input title-input" defaultValue={t.title} key={t.id} aria-label="选题" onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.title) patch({ title: v }); }} />
            <input className="input" style={{ marginTop: 8 }} defaultValue={t.angle} placeholder="一句话说清切入角度：这期内容对谁有用、解决什么问题" aria-label="切入角度" onBlur={(e) => { if (e.target.value !== t.angle) patch({ angle: e.target.value }); }} />
          </header>

          <Tabs items={EDIT_TABS.map((x) => ({ id: x.id, label: x.label }))} value={tab} onChange={(v) => { setTab(v); setPreview(false); }} />

          <div className="stack">
            <AiNotice compact />
            <div className="row wrap">
              {aiTasks.map(([task, label]) => (
                <button key={task} className="btn sm" disabled={!!busy || !models.configured} onClick={() => ai(task)}>{busy === `ai-${task}` ? <Spinner /> : <Sparkles />}{label}</button>
              ))}
              <input className="input grow" style={{ height: 30, minWidth: 180, fontSize: 13 }} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="给 AI 的额外要求（可选），例如：控制在 3 分钟内" />
              <div className="seg">
                <button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>编辑</button>
                <button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>预览</button>
              </div>
            </div>
            {draft && (
              <div className="card pad stack" style={{ borderColor: 'var(--accent)' }}>
                <div className="row between wrap">
                  <b className="row" style={{ gap: 6 }}><Sparkles size={15} />AI 草稿 · {draft.name}</b>
                  <div className="row">
                    {draft.field && <>
                      <button className="btn accent sm" onClick={() => apply('replace')}>采用（替换{EDIT_TABS.find((x) => x.id === draft.field)?.label}）</button>
                      <button className="btn sm" onClick={() => apply('append')}>追加到末尾</button>
                    </>}
                    {!draft.field && <button className="btn sm" onClick={() => { const next = `${text.notes}\n\n${draft.content}`.trim(); setText((s) => ({ ...s, notes: next })); patch({ notes: next }, false); setDraft(null); setTab('notes'); }}>存到资料与笔记</button>}
                    <button className="btn ghost sm" onClick={() => setDraft(null)}>丢弃</button>
                  </div>
                </div>
                <div style={{ maxHeight: 360, overflowY: 'auto' }}><Markdown>{draft.content}</Markdown></div>
              </div>
            )}
            {preview
              ? <div className="card pad">{text[tab] ? <Markdown>{text[tab]}</Markdown> : <span className="faint">（空）</span>}</div>
              : <textarea className="textarea tall" style={{ minHeight: 380 }} value={text[tab]} onChange={(e) => setText((s) => ({ ...s, [tab]: e.target.value }))} placeholder={EDIT_TABS.find((x) => x.id === tab)?.placeholder} aria-label={EDIT_TABS.find((x) => x.id === tab)?.label} />}
            <div className="row">
              <button className="btn accent" disabled={!dirty} onClick={saveText}>保存</button>
              <span className="xs faint">{dirty ? '有未保存的修改' : `${text[tab].length} 字 · 上次更新 ${timeAgo(t.updated_at)}`}</span>
            </div>
          </div>

          {tab === 'retro' && (
            <div className="card pad stack">
              <div className="label">发布数据</div>
              <div className="metric-grid">
                {METRICS.map(([k, label]) => (
                  <Field key={k} label={label}>
                    <input className="input" type="number" min={0} defaultValue={t.metrics?.[k] ?? ''} key={`${t.id}-${k}`} onBlur={(e) => { const v = e.target.value; if (String(t.metrics?.[k] ?? '') !== v) patch({ metrics: { ...t.metrics, [k]: v } }); }} />
                  </Field>
                ))}
              </div>
              <Field label="发布链接"><input className="input" defaultValue={t.published_url} placeholder="https://…" onBlur={(e) => { if (e.target.value !== t.published_url) patch({ published_url: e.target.value }); }} /></Field>
            </div>
          )}
        </div>

        <aside className="stack lg">
          <div className="stack">
            <Field label="阶段">
              <select className="select" value={t.status} onChange={(e) => patch({ status: e.target.value })}>{STATUS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </Field>
            <Field label="计划发布日期"><input className="input" type="date" value={t.publish_date || ''} onChange={(e) => patch({ publish_date: e.target.value || null })} /></Field>
            <Field label="栏目 / 系列"><input className="input" defaultValue={t.series} key={`s-${t.id}`} placeholder="例如：色彩课" onBlur={(e) => { if (e.target.value !== t.series) patch({ series: e.target.value }); }} /></Field>
            <Field label="平台">
              <input className="input" list="platforms" defaultValue={t.platform} key={`p-${t.id}`} onBlur={(e) => { if (e.target.value !== t.platform) patch({ platform: e.target.value }); }} />
              <datalist id="platforms">{PLATFORMS.map((x) => <option key={x} value={x} />)}</datalist>
            </Field>
            <Field label="形式">
              <input className="input" list="formats" defaultValue={t.format} key={`f-${t.id}`} onBlur={(e) => { if (e.target.value !== t.format) patch({ format: e.target.value }); }} />
              <datalist id="formats">{FORMATS.map((x) => <option key={x} value={x} />)}</datalist>
            </Field>
            <Field label="关联研究项目" hint="关联后，AI 起草时会参考该项目最新的研究报告">
              <select className="select" value={t.research_id || ''} onChange={(e) => patch({ research_id: e.target.value })}>
                <option value="">不关联</option>
                {research.data?.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </Field>
            {t.research && <Link className="link small row" style={{ gap: 5 }} to={`/research/${t.research.id}`}><FlaskConical size={13} />打开研究项目</Link>}
            {t.published_url && <a className="link small row" style={{ gap: 5 }} href={t.published_url} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} />查看已发布内容</a>}
          </div>
          <div>
            <div className="row between"><div className="side-title" style={{ margin: 0 }}>视觉参考</div><button className="btn sm" onClick={() => setRefModal({})}><Plus />添加</button></div>
            {!t.refs.length && <p className="xs faint" style={{ marginTop: 8 }}>为这期内容收集参考图。</p>}
            <div style={{ marginTop: 10 }}>
              {t.refs.map((r: any) => <RefCard key={r.id} r={r} onEdit={() => setRefModal({ item: r })} onDelete={() => delRef(r)} />)}
            </div>
          </div>
          <button className="btn ghost danger sm" style={{ alignSelf: 'flex-start' }} onClick={remove}><Trash2 />删除这个选题</button>
        </aside>
      </div>
      {refModal && <RefModal item={refModal.item} topicId={id} topics={[{ id, title: t.title }]} onClose={() => setRefModal(null)} onSaved={() => { setRefModal(null); reload(); }} />}
    </div>
  );
}
