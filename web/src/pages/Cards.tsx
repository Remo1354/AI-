import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, ListPlus, Pause, Pencil, Play, Plus, Sparkles, Trash2, Volume2, X } from 'lucide-react';
import { api } from '../lib/api';
import { dayLabel, localDate } from '../lib/format';
import { useApp, useData } from '../lib/store';
import { AiNotice, DomainSelect, Empty, Field, Loading, Modal, Spinner, confirmDelete } from '../components/ui';

type Rating = 'again' | 'hard' | 'good' | 'easy';
const RATING: { id: Rating; label: string; key: string }[] = [
  { id: 'again', label: '忘了', key: '1' },
  { id: 'hard', label: '勉强', key: '2' },
  { id: 'good', label: '记得', key: '3' },
  { id: 'easy', label: '很熟', key: '4' },
];
const intervalLabel = (days: number) => (days <= 0 ? '今天再来' : days < 30 ? `${days} 天后` : days < 365 ? `${Math.round(days / 30)} 个月后` : '1 年后');

/** 纯英文的正面（单词、短语、句子）可以用浏览器自带的语音朗读。 */
const canSpeak = (text: string) =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && /[a-zA-Z]{2,}/.test(text) && !/[\u3400-\u9fff]/.test(text) && text.length <= 300;
function speak(text: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.92;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* 这个浏览器不支持语音，忽略 */ }
}

export function CardModal({ card, onClose, onSaved }: { card?: any; onClose: () => void; onSaved: () => void }) {
  const { fail } = useApp();
  const [f, setF] = useState({ front: card?.front || '', back: card?.back || '', domain_id: card?.domain_id || '' });
  const save = async () => {
    try {
      if (card) await api.patch(`/cards/${card.id}`, f); else await api.post('/cards', { ...f, date: localDate() });
      onSaved();
    } catch (err) { fail(err); }
  };
  return (
    <Modal title={card ? '编辑卡片' : '新建卡片'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={!f.front.trim()}>保存</button>
    </>}>
      <div className="modal-body">
        <Field label="正面（问题）"><textarea className="textarea" style={{ minHeight: 70 }} value={f.front} onChange={(e) => setF({ ...f, front: e.target.value })} placeholder="例如：ephemeral  或  印象派第一次独立展览是哪一年？" /></Field>
        <Field label="背面（答案）"><textarea className="textarea" value={f.back} onChange={(e) => setF({ ...f, back: e.target.value })} placeholder="简洁、能判断对错的答案" /></Field>
        <Field label="学习方向"><DomainSelect value={f.domain_id} onChange={(v) => setF({ ...f, domain_id: v })} /></Field>
      </div>
    </Modal>
  );
}

/** 从一条知识生成卡片：AI 起草 → 逐张修改或删除 → 确认后保存。 */
export type CardSource = { knowledgeId: string } | { text: string; title?: string; domainId?: string | null };

export function CardDraftModal({ source, onClose, onSaved }: { source: CardSource; onClose: () => void; onSaved: (n: number) => void }) {
  const knowledgeId = 'knowledgeId' in source ? source.knowledgeId : undefined;
  const { models, fail } = useApp();
  const [cards, setCards] = useState<{ front: string; back: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const generate = useCallback(async () => {
    setBusy('ai');
    try {
      const r = await api.post('/cards/generate', 'knowledgeId' in source ? { knowledge_id: source.knowledgeId } : { text: source.text, title: source.title });
      setCards((list) => [...list, ...r.cards]);
      setNote(r.truncated ? '内容较长，这次只依据了前半部分出题。' : '');
    } catch (err) { fail(err); } finally { setBusy(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fail]);
  useEffect(() => { if (models.configured) generate(); /* eslint-disable-next-line */ }, []);

  const edit = (i: number, k: 'front' | 'back', v: string) => setCards((list) => list.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const valid = cards.filter((c) => c.front.trim());
  const save = async () => {
    setBusy('save');
    try {
      const r = await api.post('/cards', {
        cards: valid, knowledge_id: knowledgeId, domain_id: 'domainId' in source ? source.domainId : undefined, ai_generated: true, date: localDate(),
      });
      onSaved(r.created);
    } catch (err) { fail(err); } finally { setBusy(''); }
  };
  return (
    <Modal title="生成复习卡片" wide onClose={onClose} footer={<>
      <button className="btn left" onClick={() => setCards([...cards, { front: '', back: '' }])}><Plus />手动加一张</button>
      <button className="btn" onClick={generate} disabled={!!busy || !models.configured}>{busy === 'ai' ? <Spinner /> : <Sparkles />}再出几张</button>
      <button className="btn primary" onClick={save} disabled={!!busy || !valid.length}>保存 {valid.length} 张卡片</button>
    </>}>
      <div className="modal-body">
        <AiNotice compact />
        <p className="hint">卡片只依据{knowledgeId ? '这条知识' : '这段回答'}的内容出题。保存前可以修改或删掉不合适的；保存后从今天开始进入复习。{note}</p>
        {busy === 'ai' && !cards.length && <Loading label="正在阅读内容并出题…" />}
        <div className="stack" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {cards.map((c, i) => (
            <div key={i} className="card-draft">
              <div className="grow stack sm">
                <input className="input" value={c.front} onChange={(e) => edit(i, 'front', e.target.value)} placeholder="正面（问题）" aria-label={`第 ${i + 1} 张的问题`} />
                <textarea className="textarea" style={{ minHeight: 56 }} value={c.back} onChange={(e) => edit(i, 'back', e.target.value)} placeholder="背面（答案）" aria-label={`第 ${i + 1} 张的答案`} />
              </div>
              <button className="btn ghost icon sm" aria-label="删掉这张" onClick={() => setCards(cards.filter((_, j) => j !== i))}><X /></button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** 把一行文字拆成正面和背面：支持制表符、竖线、全角或半角冒号、破折号、两个以上空格。 */
export function parseCardLine(line: string): { front: string; back: string } | null {
  const text = line.trim();
  if (!text) return null;
  const m = text.match(/^(.+?)(?:\t+|\s*[|｜]\s*|\s*[:：]\s+|\s*：\s*|\s+[-—–]+\s+|\s{2,})(.+)$/);
  return m ? { front: m[1].trim(), back: m[2].trim() } : { front: text, back: '' };
}

/** 批量导入：一行一张，适合粘贴单词表。 */
function ImportModal({ onClose, onSaved }: { onClose: () => void; onSaved: (n: number) => void }) {
  const { fail } = useApp();
  const [text, setText] = useState('');
  const [domainId, setDomainId] = useState('');
  const parsed = text.split(/\r?\n/).map(parseCardLine).filter((c): c is { front: string; back: string } => !!c);
  const save = async () => {
    try { onSaved((await api.post('/cards', { cards: parsed, domain_id: domainId, date: localDate() })).created); } catch (err) { fail(err); }
  };
  return (
    <Modal title="批量导入卡片" wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={!parsed.length || parsed.length > 100}>导入 {parsed.length} 张</button>
    </>}>
      <div className="modal-body">
        <Field label="每行一张" hint="正面和背面之间用「 | 」、制表符、冒号或「 - 」隔开；从表格里复制两列也可以直接粘贴。一次最多 100 张。">
          <textarea className="textarea mono" style={{ minHeight: 200 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'ephemeral | 短暂的\nchiaroscuro | 明暗对照法\ncomposition | 构图'} />
        </Field>
        <Field label="学习方向"><DomainSelect value={domainId} onChange={setDomainId} /></Field>
        {parsed.length > 0 && (
          <div className="card" style={{ maxHeight: 180, overflowY: 'auto' }}>
            {parsed.slice(0, 50).map((c, i) => (
              <div key={i} className="list-row small" style={{ padding: '6px 12px' }}>
                <b className="truncate" style={{ flex: '0 1 40%' }}>{c.front}</b>
                <span className={`truncate grow ${c.back ? 'muted' : 'faint'}`}>{c.back || '（没有识别到背面）'}</span>
              </div>
            ))}
          </div>
        )}
        {parsed.length > 100 && <div className="banner warn small"><X /><div>一次最多导入 100 张，请分批粘贴。</div></div>}
      </div>
    </Modal>
  );
}

/** 学习中心的「复习」标签页：今天到期的卡片逐张过一遍，按记忆情况安排下一次。 */
export function ReviewTab({ onChanged }: { onChanged: () => void }) {
  const date = localDate();
  const { domain, fail, toast } = useApp();
  const due = useData(() => api.get<any[]>(`/cards?scope=due&date=${date}`), [date]);
  const stats = useData(() => api.get(`/cards/stats?date=${date}`), [date]);
  const everything = useData(() => api.get<any[]>(`/cards?date=${date}`), [date]);
  const [queue, setQueue] = useState<any[] | null>(null);
  const [shown, setShown] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [view, setView] = useState<'review' | 'all'>('review');
  const [modal, setModal] = useState<null | { card?: any }>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (due.data && queue === null) setQueue(due.data); }, [due.data, queue]);
  const current = queue?.[0];

  const rate = useCallback(async (rating: Rating) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const r = await api.post(`/cards/${current.id}/review`, { rating, date });
      setShown(false);
      setReviewed((n) => n + 1);
      // 忘了的卡片排到队尾，这一轮结束前再过一遍
      setQueue((q) => (q ? (rating === 'again' ? [...q.slice(1), r.card] : q.slice(1)) : q));
      stats.setData(r.stats);
      everything.reload(); // 「全部卡片」里的下次复习日期随之更新
      onChanged();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }, [current, busy, date, fail, onChanged, stats, everything]);

  useEffect(() => {
    if (view !== 'review' || modal) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (!current) return;
      if (!shown && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); setShown(true); }
      else if (shown) { const r = RATING.find((x) => x.key === e.key); if (r) rate(r.id); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, modal, current, shown, rate]);

  const refresh = () => { setQueue(null); setShown(false); due.reload(); stats.reload(); everything.reload(); onChanged(); };
  const remove = async (c: any) => { if (!confirmDelete('这张卡片')) return; try { await api.del(`/cards/${c.id}`); refresh(); } catch (err) { fail(err); } };
  const suspend = async (c: any) => { try { await api.patch(`/cards/${c.id}`, { suspended: !c.suspended }); refresh(); } catch (err) { fail(err); } };

  const s = stats.data;
  const total = s?.total ?? 0;
  return (
    <div className="stack lg">
      <div className="row between wrap">
        <div className="seg">
          <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}>今日复习{s?.due ? ` · ${s.due}` : ''}</button>
          <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>全部卡片{total ? ` · ${total}` : ''}</button>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setImporting(true)}><ListPlus />批量导入</button>
          <button className="btn" onClick={() => setModal({})}><Plus />新建卡片</button>
        </div>
      </div>

      {view === 'review' && (
        queue === null ? <Loading /> : current ? (
          <div className="flash-wrap">
            <div className="row between xs faint">
              <span>还剩 {queue.length} 张{reviewed ? ` · 本次已复习 ${reviewed} 次` : ''}</span>
              <span data-color={domain(current.domain_id)?.color} className="row" style={{ gap: 6 }}>
                {domain(current.domain_id) && <><i className="dot" />{domain(current.domain_id)!.name}</>}
              </span>
            </div>
            <div className="flash">
              <div className="flash-front">{current.front}</div>
              {canSpeak(current.front) && (
                <button className="btn ghost sm" style={{ alignSelf: 'center' }} onClick={() => speak(current.front)}><Volume2 />朗读</button>
              )}
              {shown ? <>
                <hr className="rule" />
                <div className="flash-back">{current.back || <span className="faint">（这张卡片没有填写答案）</span>}</div>
                {current.knowledge_title && <Link className="xs faint" style={{ textAlign: 'center' }} to={`/knowledge/${current.knowledge_id}`}>出自《{current.knowledge_title}》→</Link>}
              </> : (
                <button className="btn primary" style={{ alignSelf: 'center', marginTop: 12 }} onClick={() => setShown(true)}><Eye />显示答案</button>
              )}
            </div>
            {shown ? (
              <div className="rate-row">
                {RATING.map((r) => (
                  <button key={r.id} className={`rate rate-${r.id}`} disabled={busy} onClick={() => rate(r.id)}>
                    <b>{r.label}</b><span>{intervalLabel(current.next[r.id])}</span>
                  </button>
                ))}
              </div>
            ) : <p className="xs faint" style={{ textAlign: 'center' }}>先在心里回答，再看答案。快捷键：空格显示答案，1–4 评分。</p>}
          </div>
        ) : total === 0 ? (
          <div className="card"><Empty title="还没有复习卡片">
            把需要记住的东西做成卡片：单词、概念、年代、技法要点。平台会按记忆规律安排复习——记得牢的隔得久，容易忘的出现得勤。<br />
            可以在这里手动新建，也可以打开知识库里的任意一条内容，点「生成复习卡片」让 AI 出题。<br />
            <button className="btn primary" onClick={() => setModal({})}><Plus />新建第一张卡片</button>
          </Empty></div>
        ) : (
          <div className="card"><Empty title={reviewed ? '今天的复习完成了' : '今天没有到期的卡片'}>
            {reviewed ? `这一轮复习了 ${reviewed} 次。` : ''}{s?.tomorrow ? `明天有 ${s.tomorrow} 张到期。` : '明天暂时没有到期的卡片。'}
            {s ? ` 共 ${s.total} 张卡片，其中 ${s.mature} 张已经记得很牢（间隔三周以上）。` : ''}
          </Empty></div>
        )
      )}

      {view === 'all' && (
        <div className="card">
          {everything.loading && !everything.data && <Loading />}
          {everything.data && !everything.data.length && <Empty compact title="还没有卡片" />}
          <div className="list divided">
            {everything.data?.map((c) => (
              <div key={c.id} className="list-row hoverable" style={{ padding: '12px 16px', alignItems: 'flex-start', opacity: c.suspended ? 0.55 : 1 }} data-color={domain(c.domain_id)?.color}>
                <i className="dot" style={{ marginTop: 9 }} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{c.front}</div>
                  <div className="small muted clamp-2">{c.back}</div>
                  <div className="task-meta">
                    <span>{c.suspended ? '已暂停' : c.due_date <= date ? '今天到期' : `下次复习 ${dayLabel(c.due_date)}`}</span>
                    {c.interval_days > 0 && <span>间隔 {c.interval_days} 天</span>}
                    {c.lapses > 0 && <span>忘过 {c.lapses} 次</span>}
                    {c.knowledge_title && <Link to={`/knowledge/${c.knowledge_id}`}>{c.knowledge_title}</Link>}
                  </div>
                </div>
                <div className="actions">
                  <button className="btn ghost icon sm" aria-label={c.suspended ? '恢复复习' : '暂停复习'} title={c.suspended ? '恢复复习' : '暂停复习'} onClick={() => suspend(c)}>{c.suspended ? <Play /> : <Pause />}</button>
                  <button className="btn ghost icon sm" aria-label="编辑" onClick={() => setModal({ card: c })}><Pencil /></button>
                  <button className="btn ghost icon sm" aria-label="删除" onClick={() => remove(c)}><Trash2 /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {modal && <CardModal card={modal.card} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh(); }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onSaved={(n) => { setImporting(false); toast(`已导入 ${n} 张卡片`); refresh(); }} />}
    </div>
  );
}
