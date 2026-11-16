import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowUp, BookmarkPlus, Check, Copy, FileText, Layers, Menu, Paperclip, Pencil, Pin, Plus, Square, Trash2, Upload, X,
} from 'lucide-react';
import { api, streamChat } from '../lib/api';
import { chars, localDate, timeAgo } from '../lib/format';
import { useApp, useData } from '../lib/store';
import { AiNotice, DomainSelect, Empty, Field, Loading, Markdown, Modal, Spinner, confirmDelete } from '../components/ui';

interface Message {
  id: string; role: 'user' | 'assistant'; content: string; error?: string | null; model_ref?: string | null;
  context_note?: { mode: string; documents: { id: string; title: string }[]; chunks?: number; chars: number } | null;
  created_at?: string; pending?: boolean;
}
interface Mode { id: string; name: string; description: string; starters: string[] }

/** 把一条回答（或其中一部分）存进知识库 */
function SaveModal({ message, onClose }: { message: Message; onClose: () => void }) {
  const { categories, toast, fail, refresh } = useApp();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(message.content);
  const [category, setCategory] = useState('');
  const [domainId, setDomainId] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/messages/${message.id}/save`, {
        title: title.trim() || undefined, content, category_id: category || undefined, domain_id: domainId || undefined,
        tags: tags.split(/[,，\s]+/).filter(Boolean),
      });
      toast('已保存到知识库');
      refresh();
      onClose();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  return (
    <Modal title="保存到知识库" onClose={onClose} wide footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={busy || !content.trim()}>{busy ? <Spinner /> : <BookmarkPlus />}保存</button>
    </>}>
      <div className="modal-body">
        <Field label="标题" hint="留空则使用对话标题"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="给这条知识起个名字" /></Field>
        <Field label="内容" hint="可以删改，只保留值得长期留存的部分"><textarea className="textarea" style={{ minHeight: 200 }} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
        <div className="form-grid">
          <Field label="分类">
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">未分类</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="学习方向"><DomainSelect value={domainId} onChange={setDomainId} /></Field>
          <Field label="标签" hint="用空格或逗号分隔" className="full"><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="色彩 构图" /></Field>
        </div>
      </div>
    </Modal>
  );
}

/** 给对话附加资料：上传新文件，或从已有资料中选择 */
function AttachModal({ attached, onClose, onUpload, onPick }: {
  attached: string[]; onClose: () => void; onUpload: (file: File) => Promise<void>; onPick: (id: string) => Promise<void>;
}) {
  const { data: docs, loading } = useData(() => api.get<any[]>('/documents?kind=document'), []);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    for (const f of Array.from(files)) await onUpload(f);
    setBusy(false);
    onClose();
  };
  return (
    <Modal title="附加学习资料" onClose={onClose}>
      <div className="modal-body" style={{ paddingBottom: 24 }}>
        <input ref={input} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.srt" onChange={(e) => upload(e.target.files)} />
        <button className="btn block" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? <Spinner /> : <Upload />}上传文件（PDF / DOCX / TXT / Markdown）
        </button>
        <p className="hint">助手会依据资料内容回答。资料较短时载入全文；较长时自动检索与问题最相关的片段，并在回答下方标明。</p>
        <div className="side-title" style={{ marginTop: 8 }}>已有资料</div>
        {loading && <Loading />}
        {docs && !docs.length && <Empty compact title="还没有资料">上传的文件会保存在这里，之后可以重复使用。</Empty>}
        <div className="list" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {docs?.filter((d) => d.status === 'ready').map((d) => {
            const on = attached.includes(d.id);
            return (
              <button key={d.id} className="list-row" disabled={on} onClick={async () => { await onPick(d.id); onClose(); }}>
                <FileText className="type-icon" />
                <div className="grow"><div className="truncate">{d.title}</div><div className="xs faint">{chars(d.chars)} · {timeAgo(d.created_at)}</div></div>
                {on && <span className="tag ok"><Check />已附加</span>}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

export function Assistant() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { models, toast, fail } = useApp();
  const convs = useData(() => api.get<any[]>('/conversations'), []);
  const modes = useData(() => api.get<Mode[]>('/ai/modes'), []);

  const [conv, setConv] = useState<any | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('general');
  const [modelRef, setModelRef] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [saving, setSaving] = useState<Message | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [copied, setCopied] = useState('');

  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const box = useRef<HTMLTextAreaElement>(null);
  const skipLoad = useRef<string | null>(null);
  const autoSent = useRef(false);

  const loadConv = useCallback(async (cid: string) => {
    const c = await api.get(`/conversations/${cid}`);
    setConv(c);
    setMessages(c.messages);
    setMode(c.mode);
    if (c.model_ref) setModelRef(c.model_ref);
    return c;
  }, []);

  useEffect(() => {
    setDrawer(false);
    if (!id) { setConv(null); setMessages([]); return; }
    if (skipLoad.current === id) { skipLoad.current = null; return; } // 刚创建并正在发送，不用重新加载
    setLoadingConv(true);
    loadConv(id).catch((err) => { fail(err); navigate('/assistant', { replace: true }); }).finally(() => setLoadingConv(false));
  }, [id, loadConv, fail, navigate]);

  useEffect(() => {
    if (!modelRef && models.default) setModelRef(models.default);
  }, [models.default, modelRef]);

  // 回复流式增长时保持贴底，除非用户自己往上翻了
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  const ensureConversation = async (): Promise<string> => {
    if (conv) return conv.id;
    const c = await api.post('/conversations', { mode, model_ref: modelRef || undefined });
    skipLoad.current = c.id;
    setConv({ ...c, documents: [] });
    navigate(`/assistant/${c.id}`, { replace: true });
    return c.id;
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    if (!models.configured) { toast('请先在设置中配置 AI 模型', 'error'); return; }
    let cid: string;
    try { cid = await ensureConversation(); } catch (err) { fail(err); return; }
    setInput('');
    stick.current = true;
    const tempUser = `tmp-u-${Date.now()}`;
    const tempBot = `tmp-a-${Date.now()}`;
    setMessages((m) => [...m, { id: tempUser, role: 'user', content }, { id: tempBot, role: 'assistant', content: '', pending: true }]);
    setStreaming(true);
    setThinking(false);
    const ac = new AbortController();
    abort.current = ac;
    const patchBot = (fn: (m: Message) => Message) => setMessages((list) => list.map((m) => (m.id === tempBot || m.pending ? fn(m) : m)));

    await streamChat(cid, { content, model_ref: modelRef || undefined, date: localDate() }, {
      onMeta: (meta) => setMessages((list) => list.map((m) => (m.id === tempUser ? { ...m, id: meta.user_message_id } : m.id === tempBot ? { ...m, context_note: meta.context } : m))),
      onThinking: () => setThinking(true),
      onDelta: (t) => { setThinking(false); patchBot((m) => ({ ...m, content: m.content + t })); },
      onDone: (message) => setMessages((list) => list.map((m) => (m.pending ? { ...message, pending: false } : m))),
      onError: (err) => {
        if (err.message_record) setMessages((list) => list.map((m) => (m.pending ? { ...err.message_record, pending: false } : m)));
        else patchBot((m) => ({ ...m, pending: false, error: err.message }));
        if (err.code === 'ai_not_configured') setMessages((list) => list.filter((m) => m.id !== tempUser && !m.id.startsWith('tmp-')));
      },
    }, ac.signal);

    setStreaming(false);
    setThinking(false);
    abort.current = null;
    // 与服务端对齐：拿到自动生成的标题和真实消息记录。停止生成时服务端稍后才写入已生成的部分。
    setTimeout(() => { loadConv(cid).catch(() => {}); convs.reload(); }, ac.signal.aborted ? 500 : 0);
  };

  // 从总览页带着问题过来：自动填入并发送
  useEffect(() => {
    const st = location.state as { draft?: string; send?: boolean } | null;
    if (!st?.draft || autoSent.current || !id || loadingConv) return;
    if (st.send && !models.configured) return;
    autoSent.current = true;
    navigate(location.pathname, { replace: true, state: null });
    if (st.send) send(st.draft);
    else setInput(st.draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, loadingConv, models.configured]);

  const stop = () => abort.current?.abort();

  const newChat = () => { stop(); navigate('/assistant'); setInput(''); box.current?.focus(); };

  const changeMode = async (m: string) => {
    setMode(m);
    if (conv) { try { await api.patch(`/conversations/${conv.id}`, { mode: m }); setConv({ ...conv, mode: m }); } catch (err) { fail(err); } }
  };
  const changeModel = async (ref: string) => {
    setModelRef(ref);
    if (conv) api.patch(`/conversations/${conv.id}`, { model_ref: ref }).catch(() => {});
  };
  const rename = async (c: any) => {
    const title = window.prompt('重命名对话', c.title)?.trim();
    if (!title) return;
    try { await api.patch(`/conversations/${c.id}`, { title }); convs.reload(); if (conv?.id === c.id) setConv({ ...conv, title }); } catch (err) { fail(err); }
  };
  const togglePin = async (c: any) => {
    try { await api.patch(`/conversations/${c.id}`, { pinned: !c.pinned }); convs.reload(); } catch (err) { fail(err); }
  };
  const remove = async (c: any) => {
    if (!confirmDelete(`对话「${c.title}」`)) return;
    try { await api.del(`/conversations/${c.id}`); convs.reload(); if (id === c.id) navigate('/assistant'); } catch (err) { fail(err); }
  };
  const copy = async (m: Message) => {
    try { await navigator.clipboard.writeText(m.content); setCopied(m.id); setTimeout(() => setCopied(''), 1500); } catch { toast('复制失败，请手动选择文本', 'error'); }
  };

  const uploadDoc = async (file: File) => {
    try {
      const cid = await ensureConversation();
      const r = await api.upload('/documents', { file, conversation_id: cid, to_knowledge: '1' });
      if (r.document.status !== 'ready') toast(r.document.error || '这份文件没有可用的文字内容', 'error');
      else toast(`已附加《${r.document.title}》`);
      const c = await api.get(`/conversations/${cid}`);
      setConv((prev: any) => ({ ...(prev || c), documents: c.documents }));
    } catch (err) { fail(err); }
  };
  const pickDoc = async (docId: string) => {
    try {
      const cid = await ensureConversation();
      const r = await api.post(`/conversations/${cid}/documents`, { document_id: docId });
      setConv((prev: any) => ({ ...prev, documents: r.documents }));
    } catch (err) { fail(err); }
  };
  const detachDoc = async (docId: string) => {
    if (!conv) return;
    try { const r = await api.del(`/conversations/${conv.id}/documents/${docId}`); setConv({ ...conv, documents: r.documents }); } catch (err) { fail(err); }
  };

  const currentMode = useMemo(() => modes.data?.find((m) => m.id === mode), [modes.data, mode]);
  const grouped = useMemo(() => {
    const list = convs.data || [];
    return { pinned: list.filter((c) => c.pinned), rest: list.filter((c) => !c.pinned) };
  }, [convs.data]);
  const modelLabel = (ref?: string | null) => models.options.find((o) => o.ref === ref)?.label;
  const showEmpty = !id && !messages.length;

  const ConvItem = (c: any) => (
    <button key={c.id} className={`conv-item ${id === c.id ? 'active' : ''}`} onClick={() => navigate(`/assistant/${c.id}`)}>
      <span className="truncate grow">{c.title}</span>
      {c.document_count > 0 && <Paperclip size={12} className="faint" />}
      <span className="actions">
        <span role="button" tabIndex={0} className="btn ghost icon sm" title={c.pinned ? '取消置顶' : '置顶'} onClick={(e) => { e.stopPropagation(); togglePin(c); }}><Pin /></span>
        <span role="button" tabIndex={0} className="btn ghost icon sm" title="重命名" onClick={(e) => { e.stopPropagation(); rename(c); }}><Pencil /></span>
        <span role="button" tabIndex={0} className="btn ghost icon sm" title="删除" onClick={(e) => { e.stopPropagation(); remove(c); }}><Trash2 /></span>
      </span>
    </button>
  );

  return (
    <div className="chat">
      <aside className={`chat-side ${drawer ? 'open' : ''}`}>
        <div className="chat-side-head">
          <div className="row between">
            <div><div className="eyebrow" style={{ marginBottom: 0 }}>AI Assistant</div><h1 style={{ fontSize: 20 }}>学习助手</h1></div>
            <button className="btn ghost icon sm chat-drawer-toggle" onClick={() => setDrawer(false)} aria-label="关闭"><X /></button>
          </div>
          <button className="btn primary block" onClick={newChat}><Plus />新对话</button>
        </div>
        <div className="chat-side-list">
          {convs.loading && <Loading />}
          {convs.data && !convs.data.length && <p className="xs faint" style={{ padding: '8px 10px' }}>对话记录会保存在这里。</p>}
          {grouped.pinned.length > 0 && <div className="conv-group">置顶</div>}
          {grouped.pinned.map(ConvItem)}
          {grouped.pinned.length > 0 && grouped.rest.length > 0 && <div className="conv-group">最近</div>}
          {grouped.rest.map(ConvItem)}
        </div>
      </aside>

      <section className="chat-main">
        <div className="chat-head">
          <button className="btn ghost icon sm chat-drawer-toggle" onClick={() => setDrawer(true)} aria-label="对话列表"><Menu /></button>
          <div className="chat-title truncate grow">{conv?.title || '新对话'}</div>
          <select className="select" value={mode} onChange={(e) => changeMode(e.target.value)} aria-label="教学模式" title="教学模式">
            {modes.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {models.configured ? (
            <select className="select" value={modelRef} onChange={(e) => changeModel(e.target.value)} aria-label="模型" title="切换模型">
              {models.options.map((o) => <option key={o.ref} value={o.ref}>{o.label} · {o.providerName}</option>)}
            </select>
          ) : <span className="tag warn">未配置模型</span>}
        </div>

        {conv?.documents?.length > 0 && (
          <div className="chat-docs">
            <span className="xs faint">本次对话的资料</span>
            {conv.documents.map((d: any) => (
              <span key={d.id} className="doc-chip" title={`${d.title} · ${chars(d.chars)}`}>
                <FileText /><span className="truncate">{d.title}</span>
                <button onClick={() => detachDoc(d.id)} aria-label={`移除 ${d.title}`}><X size={13} /></button>
              </span>
            ))}
          </div>
        )}

        <div className="chat-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {loadingConv ? <Loading /> : showEmpty ? (
            <div className="chat-empty">
              <h2 style={{ fontSize: 26 }}>今天想学点什么？</h2>
              <p className="muted" style={{ marginTop: 6 }}>选择一种方式开始。可以附上 PDF、DOCX 或笔记，助手会依据资料回答。</p>
              <div className="mode-grid">
                {modes.data?.map((m) => (
                  <button key={m.id} className={`mode-card ${mode === m.id ? 'active' : ''}`} onClick={() => changeMode(m.id)}>
                    <b>{m.name}</b><span>{m.description}</span>
                  </button>
                ))}
              </div>
              {currentMode?.starters.map((s) => (
                <button key={s} className="starter" onClick={() => { setInput(s); box.current?.focus(); }}>{s}</button>
              ))}
            </div>
          ) : (
            <div className="chat-inner">
              {messages.map((m) => m.role === 'user' ? (
                <div key={m.id} className="msg user"><div className="bubble">{m.content}</div></div>
              ) : (
                <div key={m.id} className="msg assistant">
                  <div className="msg-role"><Layers size={12} />助手{modelLabel(m.model_ref) ? <span style={{ letterSpacing: 0, textTransform: 'none' }}>· {modelLabel(m.model_ref)}</span> : null}</div>
                  {m.content ? (
                    <div className={m.pending ? 'caret' : ''}><Markdown>{m.content}</Markdown></div>
                  ) : m.pending ? (
                    <div className="row faint small"><Spinner />{thinking ? '正在思考…' : '正在连接模型…'}</div>
                  ) : null}
                  {m.error && <div className="banner danger small"><X /><div>{m.error}</div></div>}
                  {m.context_note && (
                    <div className="msg-note">
                      <FileText />
                      {m.context_note.mode === 'full'
                        ? `已载入资料全文：${m.context_note.documents.map((d) => d.title).join('、')}`
                        : `资料较长，本次检索了 ${m.context_note.chunks} 个相关片段（共约 ${chars(m.context_note.chars)}）`}
                    </div>
                  )}
                  {!m.pending && m.content && (
                    <div className="msg-actions">
                      <button className="btn ghost sm" onClick={() => copy(m)}>{copied === m.id ? <Check /> : <Copy />}{copied === m.id ? '已复制' : '复制'}</button>
                      <button className="btn ghost sm" onClick={() => setSaving(m)}><BookmarkPlus />存入知识库</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div style={{ maxWidth: 780, margin: '0 auto 8px' }}><AiNotice /></div>
          <div className="composer">
            <textarea
              ref={box} rows={1} value={input} placeholder={currentMode ? `${currentMode.name}：输入问题，Enter 发送，Shift + Enter 换行` : '输入问题…'} aria-label="消息"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            />
            <div className="composer-foot">
              <button className="btn ghost sm" onClick={() => setAttaching(true)}><Paperclip />附加资料</button>
              {streaming
                ? <button className="btn sm" onClick={stop}><Square />停止</button>
                : <button className="btn accent sm" onClick={() => send()} disabled={!input.trim() || !models.configured}>发送<ArrowUp /></button>}
            </div>
          </div>
        </div>
      </section>

      {saving && <SaveModal message={saving} onClose={() => setSaving(null)} />}
      {attaching && (
        <AttachModal attached={(conv?.documents || []).map((d: any) => d.id)} onClose={() => setAttaching(false)} onUpload={uploadDoc} onPick={pickDoc} />
      )}
    </div>
  );
}
