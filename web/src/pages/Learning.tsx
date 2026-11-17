import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarDays, Check, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { api, qs } from '../lib/api';
import { dayLabel, localDate, longDate, minutes, percent } from '../lib/format';
import { useAction, useApp, useData } from '../lib/store';
import { AiNotice, DomainSelect, DomainTag, Empty, Field, Loading, Markdown, Modal, PageHead, Spinner, Tabs, confirmDelete } from '../components/ui';

const PLAN_STATUS: Record<string, string> = { active: '进行中', paused: '已暂停', done: '已完成' };

// ── 记录学习 ─────────────────────────────────────────────────
export function LogModal({ onClose, onSaved, planId, log }: { onClose: () => void; onSaved: () => void; planId?: string; log?: any }) {
  const { fail, toast } = useApp();
  const plans = useData(() => api.get<any[]>('/plans'), []);
  const [f, setF] = useState({
    date: log?.date || localDate(), minutes: String(log?.minutes ?? 30), domain_id: log?.domain_id || '', plan_id: log?.plan_id || planId || '', content: log?.content || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, minutes: Number(f.minutes) || 0 };
      if (log) await api.patch(`/logs/${log.id}`, body); else await api.post('/logs', body);
      toast(log ? '已更新' : '已记录');
      onSaved();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={log ? '编辑学习记录' : '记录学习'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={busy}>保存</button>
    </>}>
      <div className="modal-body">
        <div className="form-grid">
          <Field label="日期"><input className="input" type="date" value={f.date} max={localDate()} onChange={(e) => set('date', e.target.value)} /></Field>
          <Field label="时长（分钟）"><input className="input" type="number" min={0} max={1440} step={5} value={f.minutes} onChange={(e) => set('minutes', e.target.value)} /></Field>
          <div className="full row wrap" style={{ gap: 6 }}>
            {[15, 30, 45, 60, 90, 120].map((m) => <button key={m} type="button" className={`tag ${Number(f.minutes) === m ? 'active' : ''}`} onClick={() => set('minutes', String(m))}>{minutes(m)}</button>)}
          </div>
          <Field label="所属计划">
            <select className="select" value={f.plan_id} onChange={(e) => set('plan_id', e.target.value)}>
              <option value="">不关联计划</option>
              {plans.data?.filter((p) => p.status === 'active' || p.id === f.plan_id).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </Field>
          <Field label="学习方向" hint={f.plan_id ? '留空则跟随计划' : undefined}><DomainSelect value={f.domain_id} onChange={(v) => set('domain_id', v)} /></Field>
          <Field label="学了什么" className="full"><textarea className="textarea" value={f.content} onChange={(e) => set('content', e.target.value)} placeholder="今天学到的内容、卡住的地方、下一步想做什么" /></Field>
        </div>
      </div>
    </Modal>
  );
}

function TaskModal({ task, planId, onClose, onSaved }: { task?: any; planId?: string; onClose: () => void; onSaved: () => void }) {
  const { fail } = useApp();
  const [f, setF] = useState({
    title: task?.title || '', due_date: task?.due_date || '', estimate_min: task?.estimate_min ? String(task.estimate_min) : '', stage: task?.stage || '', notes: task?.notes || '', domain_id: task?.domain_id || '',
  });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    try {
      const body = { ...f, due_date: f.due_date || null, estimate_min: f.estimate_min || null, plan_id: planId };
      if (task) await api.patch(`/tasks/${task.id}`, body); else await api.post('/tasks', body);
      onSaved();
    } catch (err) { fail(err); }
  };
  return (
    <Modal title={task ? '编辑任务' : '新建任务'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={!f.title.trim()}>保存</button>
    </>}>
      <div className="modal-body">
        <Field label="任务内容"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="具体到可以直接动手，例如：临摹 3 张色彩小稿" /></Field>
        <div className="form-grid">
          <Field label="计划日期"><input className="input" type="date" value={f.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
          <Field label="预计时长（分钟）"><input className="input" type="number" min={0} step={5} value={f.estimate_min} onChange={(e) => set('estimate_min', e.target.value)} /></Field>
          {(planId || task?.plan_id)
            ? <Field label="所属阶段" className="full"><input className="input" value={f.stage} onChange={(e) => set('stage', e.target.value)} placeholder="例如：第一阶段 · 基础" /></Field>
            : <Field label="学习方向" className="full"><DomainSelect value={f.domain_id} onChange={(v) => set('domain_id', v)} /></Field>}
          <Field label="备注" className="full"><textarea className="textarea" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

/** 刚刚勾选完成、还可以顺手记一笔学习时长的任务。放在模块级，列表刷新后仍然有效。 */
const justCompleted = new Set<string>();

function TaskRow({ t, onChange, onEdit, showPlan = true }: { t: any; onChange: () => void; onEdit: (t: any) => void; showPlan?: boolean }) {
  const { domain, fail, toast } = useApp();
  const today = localDate();
  const d = domain(t.effective_domain_id ?? t.domain_id);
  const done = t.status === 'done';
  const logMinutes = t.estimate_min || 30;
  const toggle = async () => {
    try {
      await api.patch(`/tasks/${t.id}`, { status: done ? 'todo' : 'done', date: today });
      if (done) justCompleted.delete(t.id); else justCompleted.add(t.id);
      onChange();
    } catch (err) { fail(err); }
  };
  const logIt = async () => {
    try {
      await api.post('/logs', { date: today, minutes: logMinutes, plan_id: t.plan_id, domain_id: t.effective_domain_id ?? t.domain_id, content: `完成：${t.title}` });
      justCompleted.delete(t.id);
      toast(`已记录 ${minutes(logMinutes)}学习`);
      onChange();
    } catch (err) { fail(err); }
  };
  const remove = async () => {
    if (!confirmDelete(`任务「${t.title}」`)) return;
    try { await api.del(`/tasks/${t.id}`); onChange(); } catch (err) { fail(err); }
  };
  return (
    <div className="task-row">
      <button className={`check ${done ? 'done' : ''}`} onClick={toggle} aria-label={done ? '标记为未完成' : '标记为完成'}><Check /></button>
      <div className="grow">
        <div className={`task-title ${done ? 'done' : ''}`}>{t.title}</div>
        <div className="task-meta">
          {showPlan && d && <span className="row" style={{ gap: 5 }} data-color={d.color}><i className="dot" />{d.name}</span>}
          {showPlan && t.plan_title && <Link to={`/learning/plans/${t.plan_id}`}>{t.plan_title}</Link>}
          {t.due_date && <span className={!done && t.due_date < today ? 'overdue' : ''}>{!done && t.due_date < today ? '逾期 · ' : ''}{dayLabel(t.due_date)}</span>}
          {t.estimate_min ? <span>约 {minutes(t.estimate_min)}</span> : null}
          {t.notes && <span className="truncate" style={{ maxWidth: 260 }}>{t.notes}</span>}
        </div>
        {done && justCompleted.has(t.id) && (
          <button className="tag accent" style={{ marginTop: 6 }} onClick={logIt}><Plus />顺手记录 {minutes(logMinutes)}学习</button>
        )}
      </div>
      <div className="actions">
        <button className="btn ghost icon sm" onClick={() => onEdit(t)} aria-label="编辑"><Pencil /></button>
        <button className="btn ghost icon sm" onClick={remove} aria-label="删除"><Trash2 /></button>
      </div>
    </div>
  );
}

function QuickAdd({ placeholder, onAdd }: { placeholder: string; onAdd: (title: string) => Promise<void> }) {
  const [v, setV] = useState('');
  const submit = async () => { const t = v.trim(); if (!t) return; setV(''); await onAdd(t); };
  return (
    <div className="inline-add">
      <input className="input" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); }} />
      <button className="btn sm" onClick={submit} disabled={!v.trim()} style={{ height: 34 }}><Plus />添加</button>
    </div>
  );
}

// ── AI 制定学习计划：填写目标 → 生成草稿 → 确认后才保存 ─────────
function PlanModal({ onClose, onSaved, defaultDomain }: { onClose: () => void; onSaved: (id: string) => void; defaultDomain?: string }) {
  const { models, fail } = useApp();
  const [mode, setMode] = useState<'ai' | 'manual'>(models.configured ? 'ai' : 'manual');
  const [f, setF] = useState({ topic: '', goal: '', level: '', weeks: '8', hours_per_week: '5', domain_id: defaultDomain || '', start_date: localDate() });
  const [draft, setDraft] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const generate = async () => {
    setBusy(true);
    try { setDraft((await api.post('/plans/generate', f)).draft); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = draft ?? { title: f.topic, goal: f.goal, domain_id: f.domain_id, start_date: f.start_date };
      onSaved((await api.post('/plans', body)).id);
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  if (draft) {
    const stages = [...new Set<string>(draft.tasks.map((t: any) => t.stage))];
    return (
      <Modal title="确认学习计划" wide onClose={onClose} footer={<>
        <button className="btn left" onClick={() => setDraft(null)}>← 返回修改</button>
        <button className="btn" onClick={generate} disabled={busy}>{busy ? <Spinner /> : <Sparkles />}重新生成</button>
        <button className="btn primary" onClick={save} disabled={busy || !draft.title.trim() || !draft.tasks.length}>保存计划</button>
      </>}>
        <div className="modal-body">
          <p className="hint">这是 AI 生成的草稿，保存前可以修改标题、删掉不合适的任务。保存后仍可随时调整。</p>
          <Field label="计划名称"><input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field>
          <Field label="目标"><textarea className="textarea" style={{ minHeight: 60 }} value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} /></Field>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>任务（{draft.tasks.length} 项 · {draft.start_date} 至 {draft.target_date}）</div>
            <div className="card" style={{ maxHeight: 300, overflowY: 'auto' }}>
              {stages.map((s) => (
                <div key={s}>
                  <div className="stage-title">{s || '任务'}</div>
                  {draft.tasks.map((t: any, i: number) => t.stage === s && (
                    <div key={i} className="task-row">
                      <div className="grow">
                        <div>{t.title}</div>
                        <div className="task-meta"><span>{dayLabel(t.due_date)}前</span>{t.estimate_min ? <span>约 {minutes(t.estimate_min)}</span> : null}</div>
                      </div>
                      <button className="btn ghost icon sm" aria-label="移除" onClick={() => setDraft({ ...draft, tasks: draft.tasks.filter((_: any, j: number) => j !== i) })}><X /></button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          {draft.roadmap && <details><summary className="label" style={{ cursor: 'pointer' }}>查看学习路线说明</summary><div style={{ marginTop: 10 }}><Markdown>{draft.roadmap}</Markdown></div></details>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="新建学习计划" wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      {mode === 'ai'
        ? <button className="btn primary" onClick={generate} disabled={busy || !f.topic.trim() || !models.configured}>{busy ? <Spinner /> : <Sparkles />}{busy ? '正在规划…' : '生成计划草稿'}</button>
        : <button className="btn primary" onClick={save} disabled={busy || !f.topic.trim()}>创建</button>}
    </>}>
      <div className="modal-body">
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button className={mode === 'ai' ? 'active' : ''} onClick={() => setMode('ai')}>AI 帮我规划</button>
          <button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>自己建立</button>
        </div>
        {mode === 'ai' && <AiNotice compact />}
        <Field label={mode === 'ai' ? '想学什么' : '计划名称'}><input className="input" value={f.topic} onChange={(e) => set('topic', e.target.value)} placeholder="例如：数字绘画中的色彩与光影" /></Field>
        <div className="form-grid">
          <Field label="学习方向"><DomainSelect value={f.domain_id} onChange={(v) => set('domain_id', v)} /></Field>
          <Field label="开始日期"><input className="input" type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></Field>
          <Field label="想达到的目标" className="full"><textarea className="textarea" style={{ minHeight: 64 }} value={f.goal} onChange={(e) => set('goal', e.target.value)} placeholder="学完之后希望能做到什么" /></Field>
          {mode === 'ai' && <>
            <Field label="现有基础" className="full"><input className="input" value={f.level} onChange={(e) => set('level', e.target.value)} placeholder="例如：会用 Procreate，没有系统学过色彩理论" /></Field>
            <Field label="计划周期（周）"><input className="input" type="number" min={1} max={52} value={f.weeks} onChange={(e) => set('weeks', e.target.value)} /></Field>
            <Field label="每周可投入（小时）"><input className="input" type="number" min={1} max={80} value={f.hours_per_week} onChange={(e) => set('hours_per_week', e.target.value)} /></Field>
          </>}
        </div>
      </div>
    </Modal>
  );
}

// ── 阶段总结 ─────────────────────────────────────────────────
function ReviewModal({ review, onClose, onSaved }: { review?: any; onClose: () => void; onSaved: () => void }) {
  const { models, fail, toast } = useApp();
  const [f, setF] = useState({
    title: review?.title || '', content: review?.content || '', period_start: review?.period_start || localDate(-6), period_end: review?.period_end || localDate(), domain_id: review?.domain_id || '',
  });
  const [busy, setBusy] = useState('');
  const [basis, setBasis] = useState<any | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const generate = async () => {
    setBusy('ai');
    try {
      const r = await api.post('/reviews/generate', { period_start: f.period_start, period_end: f.period_end, domain_id: f.domain_id });
      setF((s) => ({ ...s, title: s.title || r.draft.title, content: r.draft.content }));
      setBasis(r.basis);
    } catch (err) { fail(err); } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save');
    try {
      if (review) await api.patch(`/reviews/${review.id}`, f); else await api.post('/reviews', f);
      toast('总结已保存');
      onSaved();
    } catch (err) { fail(err); } finally { setBusy(''); }
  };
  return (
    <Modal title={review ? '编辑总结' : '写一份阶段总结'} wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={!!busy || !f.title.trim()}>保存</button>
    </>}>
      <div className="modal-body">
        {!review && (
          <div className="form-grid">
            <Field label="开始"><input className="input" type="date" value={f.period_start} onChange={(e) => set('period_start', e.target.value)} /></Field>
            <Field label="结束"><input className="input" type="date" value={f.period_end} onChange={(e) => set('period_end', e.target.value)} /></Field>
            <Field label="范围" className="full"><DomainSelect value={f.domain_id} onChange={(v) => set('domain_id', v)} empty="全部方向" /></Field>
            <div className="full row wrap">
              <button className="btn" onClick={generate} disabled={!!busy || !models.configured}>{busy === 'ai' ? <Spinner /> : <Sparkles />}{busy === 'ai' ? '正在阅读学习记录…' : 'AI 根据学习记录起草'}</button>
              {basis && <span className="xs faint">依据：{basis.logs} 条学习记录、{basis.tasks_done} 项已完成任务、{basis.tasks_overdue} 项逾期任务</span>}
            </div>
            <div className="full"><AiNotice compact /></div>
          </div>
        )}
        <Field label="标题"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="例如：11 月第二周学习总结" /></Field>
        <Field label="内容" hint="支持 Markdown。AI 起草的内容只来自这段时间真实的记录，请按实际情况修改。"><textarea className="textarea tall" value={f.content} onChange={(e) => set('content', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

type Tab = 'today' | 'plans' | 'logs' | 'reviews';

export function Learning() {
  const { domains, domain, fail } = useApp();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tab = (params.get('tab') as Tab) || 'today';
  const domainFilter = params.get('domain') || '';
  const date = localDate();
  const [modal, setModal] = useState<null | { kind: 'log' | 'task' | 'plan' | 'review'; data?: any }>(params.get('new') ? { kind: 'plan' } : null);
  const [openReview, setOpenReview] = useState('');

  const todayTasks = useData(() => api.get<any[]>(`/tasks?scope=today&date=${date}`), [date]);
  const upcoming = useData(() => api.get<any[]>(`/tasks?scope=upcoming&date=${date}`), [date]);
  const inbox = useData(() => api.get<any[]>('/tasks?scope=inbox'), []);
  const stats = useData(() => api.get(`/learning/stats?date=${date}`), [date]);
  const plans = useData(() => api.get<any[]>(`/plans${qs({ domain_id: domainFilter })}`), [domainFilter]);
  const logs = useData(() => api.get<any[]>(`/logs${qs({ domain_id: domainFilter, limit: 200 })}`), [domainFilter]);
  const reviews = useData(() => api.get<any[]>('/reviews'), []);

  const reloadTasks = () => { todayTasks.reload(); upcoming.reload(); inbox.reload(); stats.reload(); plans.reload(); };
  const setTab = (t: Tab) => { const n = new URLSearchParams(params); n.set('tab', t); n.delete('new'); setParams(n, { replace: true }); };
  const setDomain = (d: string) => { const n = new URLSearchParams(params); if (d) n.set('domain', d); else n.delete('domain'); setParams(n, { replace: true }); };
  const addToday = async (title: string) => { try { await api.post('/tasks', { title, due_date: date }); reloadTasks(); } catch (err) { fail(err); } };
  const addInbox = async (title: string) => { try { await api.post('/tasks', { title }); reloadTasks(); } catch (err) { fail(err); } };
  const removeLog = async (l: any) => { if (!confirmDelete('这条学习记录')) return; try { await api.del(`/logs/${l.id}`); logs.reload(); stats.reload(); } catch (err) { fail(err); } };
  const removeReview = async (r: any) => { if (!confirmDelete(`总结「${r.title}」`)) return; try { await api.del(`/reviews/${r.id}`); reviews.reload(); } catch (err) { fail(err); } };

  const open = todayTasks.data?.filter((t) => t.status !== 'done') || [];
  const done = todayTasks.data?.filter((t) => t.status === 'done') || [];
  const logsByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const l of logs.data || []) map.set(l.date, [...(map.get(l.date) || []), l]);
    return [...map.entries()];
  }, [logs.data]);

  const DomainFilter = (
    <div className="row wrap" style={{ gap: 6, marginBottom: 16 }}>
      <button className={`tag ${!domainFilter ? 'active' : ''}`} onClick={() => setDomain('')}>全部方向</button>
      {domains.map((d) => <button key={d.id} className={`tag ${domainFilter === d.id ? 'active' : ''}`} data-color={d.color} onClick={() => setDomain(d.id)}><i className="dot" />{d.name}</button>)}
    </div>
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="Learning Center" title="学习中心"
        desc="把目标拆成计划和任务，每天记一笔，定期回头看。"
        actions={<>
          <button className="btn" onClick={() => setModal({ kind: 'log' })}><Plus />记录学习</button>
          <button className="btn primary" onClick={() => setModal({ kind: 'plan' })}><Sparkles />新建学习计划</button>
        </>}
      />
      <Tabs
        value={tab} onChange={setTab}
        items={[
          { id: 'today', label: '今日', count: open.length || undefined },
          { id: 'plans', label: '学习计划', count: plans.data?.filter((p) => p.status === 'active').length || undefined },
          { id: 'logs', label: '学习记录' },
          { id: 'reviews', label: '阶段总结', count: reviews.data?.length || undefined },
        ]}
      />

      {tab === 'today' && (
        <div className="split">
          <div className="stack lg">
            <section className="card">
              <div className="card-head"><h2 className="card-title">{longDate(date)}</h2><span className="xs faint">{done.length ? `已完成 ${done.length} 项` : ''}</span></div>
              <div className="card-body flush">
                {todayTasks.loading && !todayTasks.data && <Loading />}
                {todayTasks.data && !todayTasks.data.length && <Empty compact title="今天还没有任务">在下面添加一项，或到学习计划里给任务排期。</Empty>}
                {open.map((t) => <TaskRow key={t.id} t={t} onChange={reloadTasks} onEdit={(x) => setModal({ kind: 'task', data: x })} />)}
                {done.map((t) => <TaskRow key={t.id} t={t} onChange={reloadTasks} onEdit={(x) => setModal({ kind: 'task', data: x })} />)}
                <QuickAdd placeholder="添加今天要做的事，回车确认" onAdd={addToday} />
              </div>
            </section>
            {!!upcoming.data?.length && (
              <section className="card">
                <div className="card-head"><h2 className="card-title">接下来两周 <span className="count">{upcoming.data.length} 项</span></h2></div>
                <div className="card-body flush">{upcoming.data.slice(0, 12).map((t) => <TaskRow key={t.id} t={t} onChange={reloadTasks} onEdit={(x) => setModal({ kind: 'task', data: x })} />)}</div>
              </section>
            )}
            <section className="card">
              <div className="card-head"><h2 className="card-title">待安排 <span className="count">没有日期的零散任务</span></h2></div>
              <div className="card-body flush">
                {inbox.data?.map((t) => <TaskRow key={t.id} t={t} onChange={reloadTasks} onEdit={(x) => setModal({ kind: 'task', data: x })} />)}
                <QuickAdd placeholder="想到要学的东西，先记在这里" onAdd={addInbox} />
              </div>
            </section>
          </div>
          <aside className="stack lg">
            {stats.data && (
              <div className="card pad stack">
                <div className="row between">
                  <div><div className="stat-value">{stats.data.streak}<small>天</small></div><div className="stat-label">连续学习</div></div>
                  <div><div className="stat-value">{stats.data.minutes_today}<small>分钟</small></div><div className="stat-label">今日已学</div></div>
                </div>
                <button className="btn block" onClick={() => setModal({ kind: 'log' })}><Plus />记录一次学习</button>
              </div>
            )}
            {stats.data && (
              <div>
                <div className="side-title">近 7 天 · 各方向时长</div>
                {stats.data.domains.map((d: any) => {
                  const max = Math.max(...stats.data.domains.map((x: any) => x.minutes_7d), 1);
                  return (
                    <div key={d.id} className="domain-row" data-color={d.color} style={{ gridTemplateColumns: 'minmax(0,1fr) 70px auto', padding: '6px 0' }}>
                      <span className="row small" style={{ gap: 7 }}><i className="dot" /><span className="truncate">{d.name}</span></span>
                      <div className="progress"><span style={{ width: `${(d.minutes_7d / max) * 100}%` }} /></div>
                      <span className="meta" style={{ minWidth: 58 }}>{d.minutes_7d ? minutes(d.minutes_7d) : '—'}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      )}

      {tab === 'plans' && (
        <div>
          {DomainFilter}
          {plans.loading && !plans.data && <Loading />}
          {plans.data && !plans.data.length && (
            <div className="card"><Empty title="还没有学习计划">告诉 AI 你想学什么、每周有多少时间，它会拆出一条分阶段的路线，由你确认后保存。<br /><button className="btn primary" onClick={() => setModal({ kind: 'plan' })}><Sparkles />新建学习计划</button></Empty></div>
          )}
          <div className="grid-cards">
            {plans.data?.map((p) => (
              <Link key={p.id} to={`/learning/plans/${p.id}`} className="card hover plan-card" data-color={domain(p.domain_id)?.color}>
                <div className="row between"><DomainTag id={p.domain_id} />{p.status !== 'active' && <span className="tag outline">{PLAN_STATUS[p.status]}</span>}</div>
                <h3>{p.title}</h3>
                {p.goal && <p className="small muted clamp-2">{p.goal}</p>}
                <div style={{ marginTop: 'auto' }}>
                  <div className="row between xs faint num"><span>{p.tasks_done}/{p.tasks_total} 项任务</span><span>{percent(p.tasks_done, p.tasks_total)}%</span></div>
                  <div className="progress" style={{ marginTop: 6 }}><span style={{ width: `${percent(p.tasks_done, p.tasks_total)}%` }} /></div>
                  <div className="xs faint" style={{ marginTop: 8 }}>
                    累计 {minutes(p.minutes_total)}{p.next_due ? ` · 下一项 ${dayLabel(p.next_due)}` : ''}{p.target_date ? ` · 目标 ${dayLabel(p.target_date)}` : ''}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {tab === 'logs' && (
        <div className="page narrow" style={{ padding: 0, margin: 0 }}>
          {DomainFilter}
          {logs.loading && !logs.data && <Loading />}
          {logs.data && !logs.data.length && <div className="card"><Empty title="还没有学习记录">每次学完记一笔：学了多久、学了什么。总览页的学习节奏和阶段总结都来自这里。<br /><button className="btn" onClick={() => setModal({ kind: 'log' })}><Plus />记录学习</button></Empty></div>}
          {logsByDay.map(([day, items]) => (
            <div key={day}>
              <div className="day-head">{dayLabel(day)}<span className="xs faint" style={{ fontFamily: 'var(--font-sans)', fontWeight: 400 }}>{day} · 共 {minutes(items.reduce((n, l) => n + l.minutes, 0))}</span></div>
              <div className="card">
                <div className="list divided">
                  {items.map((l) => (
                    <div key={l.id} className="list-row hoverable top" style={{ padding: '12px 16px', alignItems: 'flex-start' }} data-color={domain(l.domain_id)?.color}>
                      <i className="dot" style={{ marginTop: 9 }} />
                      <div className="grow">
                        <div style={{ whiteSpace: 'pre-wrap' }}>{l.content || <span className="faint">（未填写内容）</span>}</div>
                        <div className="task-meta"><span>{minutes(l.minutes)}</span>{domain(l.domain_id) && <span>{domain(l.domain_id)!.name}</span>}{l.plan_title && <Link to={`/learning/plans/${l.plan_id}`}>{l.plan_title}</Link>}</div>
                      </div>
                      <div className="actions">
                        <button className="btn ghost icon sm" aria-label="编辑" onClick={() => setModal({ kind: 'log', data: l })}><Pencil /></button>
                        <button className="btn ghost icon sm" aria-label="删除" onClick={() => removeLog(l)}><Trash2 /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'reviews' && (
        <div className="page narrow stack lg" style={{ padding: 0, margin: 0 }}>
          <div><button className="btn" onClick={() => setModal({ kind: 'review' })}><Plus />写一份总结</button></div>
          {reviews.data && !reviews.data.length && <div className="card"><Empty title="还没有阶段总结">每周或每个阶段结束时回顾一次。AI 可以根据这段时间的学习记录和任务完成情况替你起草。</Empty></div>}
          {reviews.data?.map((r) => (
            <article key={r.id} className="card pad">
              <div className="row between top">
                <button className="link" style={{ color: 'var(--ink)', textAlign: 'left' }} onClick={() => setOpenReview(openReview === r.id ? '' : r.id)}>
                  <h3 className="serif" style={{ fontSize: 17 }}>{r.title}</h3>
                </button>
                <div className="row" style={{ gap: 2 }}>
                  <button className="btn ghost icon sm" aria-label="编辑" onClick={() => setModal({ kind: 'review', data: r })}><Pencil /></button>
                  <button className="btn ghost icon sm" aria-label="删除" onClick={() => removeReview(r)}><Trash2 /></button>
                </div>
              </div>
              <div className="k-meta"><CalendarDays size={13} />{r.period_start && r.period_end ? `${r.period_start} 至 ${r.period_end}` : dayLabel(r.created_at.slice(0, 10))}<DomainTag id={r.domain_id} /></div>
              {openReview === r.id ? <div style={{ marginTop: 14 }}><Markdown>{r.content || '（空）'}</Markdown></div> : <p className="small muted clamp-2" style={{ marginTop: 8 }}>{r.content.replace(/[#*>`-]/g, '').slice(0, 200)}</p>}
            </article>
          ))}
        </div>
      )}

      {modal?.kind === 'log' && <LogModal log={modal.data} onClose={() => setModal(null)} onSaved={() => { setModal(null); logs.reload(); stats.reload(); plans.reload(); }} />}
      {modal?.kind === 'task' && <TaskModal task={modal.data} onClose={() => setModal(null)} onSaved={() => { setModal(null); reloadTasks(); }} />}
      {modal?.kind === 'plan' && <PlanModal defaultDomain={domainFilter} onClose={() => setModal(null)} onSaved={(id) => navigate(`/learning/plans/${id}`)} />}
      {modal?.kind === 'review' && <ReviewModal review={modal.data} onClose={() => setModal(null)} onSaved={() => { setModal(null); reviews.reload(); }} />}
    </div>
  );
}

// ── 计划详情 ─────────────────────────────────────────────────
function ResourcePicker({ planId, onClose, onAdded }: { planId: string; onClose: () => void; onAdded: (p: any) => void }) {
  const { fail } = useApp();
  const [q, setQ] = useState('');
  const results = useData(() => api.get(`/knowledge${qs({ q })}`), [q]);
  const add = async (itemId: string) => { try { onAdded(await api.post(`/plans/${planId}/resources`, { item_id: itemId })); onClose(); } catch (err) { fail(err); } };
  return (
    <Modal title="关联知识库中的资料" onClose={onClose}>
      <div className="modal-body" style={{ paddingBottom: 24 }}>
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索知识库" />
        <div className="list" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {results.data && !results.data.items.length && <Empty compact title="没有找到">先到知识库上传资料或写一条笔记。</Empty>}
          {results.data?.items.slice(0, 40).map((i: any) => (
            <button key={i.id} className="list-row" onClick={() => add(i.id)}><span className="grow truncate">{i.title}</span><Plus size={15} className="faint" /></button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function PlanDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { domain, fail, toast } = useApp();
  const { data: plan, setData, reload, loading, error } = useData(() => api.get(`/plans/${id}`), [id]);
  const { run } = useAction();
  const [tab, setTab] = useState<'tasks' | 'roadmap' | 'resources' | 'logs'>('tasks');
  const [modal, setModal] = useState<null | { kind: 'task' | 'log' | 'resource'; data?: any }>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', goal: '', roadmap: '' });

  useEffect(() => { if (plan) setDraft({ title: plan.title, goal: plan.goal, roadmap: plan.roadmap }); /* eslint-disable-next-line */ }, [plan?.id, plan?.updated_at]);

  if (loading && !plan) return <div className="page"><Loading /></div>;
  if (error || !plan) return <div className="page"><Empty title="找不到这个学习计划"><Link className="link" to="/learning?tab=plans">返回学习中心</Link></Empty></div>;

  const patch = (body: Record<string, unknown>) => run('save', async () => { setData(await api.patch(`/plans/${id}`, body)); });
  const remove = async () => {
    if (!window.confirm(`确定删除计划「${plan.title}」吗？计划下的 ${plan.tasks_total} 项任务会一并删除，学习记录会保留。`)) return;
    try { await api.del(`/plans/${id}`); navigate('/learning?tab=plans'); } catch (err) { fail(err); }
  };
  const addTask = async (title: string, stage: string) => { try { await api.post('/tasks', { title, plan_id: id, stage }); reload(); } catch (err) { fail(err); } };
  const d = domain(plan.domain_id);
  const stages: string[] = [...new Set<string>(plan.tasks.map((t: any) => t.stage))];
  if (!stages.length) stages.push('');
  const pct = percent(plan.tasks_done, plan.tasks_total);

  return (
    <div className="page" data-color={d?.color}>
      <Link className="back-link" to="/learning?tab=plans">← 学习计划</Link>
      <header className="page-head" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div className="eyebrow row" style={{ gap: 8 }}>{d ? <><i className="dot" />{d.name}</> : '学习计划'}{plan.ai_generated ? <span className="tag accent"><Sparkles />AI 规划</span> : null}</div>
          {editing ? <input className="input title-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="计划名称" /> : <h1 className="page-title">{plan.title}</h1>}
          {editing
            ? <textarea className="textarea" style={{ marginTop: 8, minHeight: 64 }} value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} placeholder="目标" />
            : plan.goal && <p className="page-desc">{plan.goal}</p>}
          <div className="row" style={{ marginTop: 16, maxWidth: 520 }}>
            <div className="progress grow" style={{ height: 8 }}><span style={{ width: `${pct}%` }} /></div>
            <span className="small muted num" style={{ whiteSpace: 'nowrap' }}>{plan.tasks_done}/{plan.tasks_total} · {pct}%</span>
          </div>
          <div className="k-meta">
            <span>累计学习 {minutes(plan.minutes_total)}</span>
            {plan.start_date && <span>开始 {plan.start_date}</span>}
            {plan.target_date && <span>目标 {plan.target_date}</span>}
          </div>
        </div>
        <div className="page-actions">
          {editing ? <>
            <button className="btn primary" onClick={async () => { await patch({ title: draft.title, goal: draft.goal }); setEditing(false); }} disabled={!draft.title.trim()}>保存</button>
            <button className="btn" onClick={() => setEditing(false)}>取消</button>
          </> : <>
            <select className="select" style={{ width: 'auto' }} value={plan.status} onChange={(e) => patch({ status: e.target.value })} aria-label="计划状态">
              {Object.entries(PLAN_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button className="btn" onClick={() => setEditing(true)}><Pencil />编辑</button>
            <button className="btn" onClick={() => setModal({ kind: 'log' })}><Plus />记录学习</button>
          </>}
        </div>
      </header>

      <Tabs
        value={tab} onChange={setTab}
        items={[
          { id: 'tasks', label: '任务', count: plan.tasks_total || undefined },
          { id: 'roadmap', label: '学习路线' },
          { id: 'resources', label: '学习资料', count: plan.resources.length || undefined },
          { id: 'logs', label: '学习记录', count: plan.logs.length || undefined },
        ]}
      />

      {tab === 'tasks' && (
        <div className="card">
          <div className="card-body flush">
            {stages.map((s) => (
              <div key={s}>
                <div className="stage-title"><span>{s || '任务'}</span><span>{plan.tasks.filter((t: any) => t.stage === s && t.status === 'done').length}/{plan.tasks.filter((t: any) => t.stage === s).length}</span></div>
                {plan.tasks.filter((t: any) => t.stage === s).map((t: any) => (
                  <TaskRow key={t.id} t={t} showPlan={false} onChange={reload} onEdit={(x) => setModal({ kind: 'task', data: x })} />
                ))}
                <QuickAdd placeholder={`在「${s || '任务'}」里添加一项`} onAdd={(title) => addTask(title, s)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'roadmap' && (
        <div className="page narrow stack" style={{ padding: 0, margin: 0 }}>
          <textarea className="textarea tall" value={draft.roadmap} onChange={(e) => setDraft({ ...draft, roadmap: e.target.value })} placeholder="写下这份计划的路线：分几个阶段、每个阶段学什么、怎么判断学会了。支持 Markdown。" aria-label="学习路线" />
          <div className="row">
            <button className="btn primary" disabled={draft.roadmap === plan.roadmap} onClick={async () => { await patch({ roadmap: draft.roadmap }); toast('路线已保存'); }}>保存路线</button>
          </div>
          {plan.roadmap && <><div className="side-title" style={{ marginTop: 12 }}>预览</div><div className="card pad"><Markdown>{draft.roadmap}</Markdown></div></>}
        </div>
      )}

      {tab === 'resources' && (
        <div className="stack">
          <div><button className="btn" onClick={() => setModal({ kind: 'resource' })}><Plus />关联资料</button></div>
          <div className="card">
            {!plan.resources.length && <Empty compact title="还没有关联资料">把知识库里的笔记和上传的资料挂到这份计划上，学的时候不用到处找。</Empty>}
            <div className="list divided">
              {plan.resources.map((r: any) => (
                <div key={r.id} className="list-row hoverable" style={{ padding: '12px 16px' }}>
                  <Link to={`/knowledge/${r.id}`} className="grow"><div className="truncate" style={{ fontWeight: 600 }}>{r.title}</div>{r.summary && <div className="xs faint truncate">{r.summary}</div>}</Link>
                  <div className="actions"><button className="btn ghost icon sm" aria-label="取消关联" onClick={async () => { try { setData(await api.del(`/plans/${id}/resources/${r.id}`)); } catch (err) { fail(err); } }}><X /></button></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'logs' && (
        <div className="card">
          {!plan.logs.length && <Empty compact title="这份计划还没有学习记录">点击右上角「记录学习」。</Empty>}
          <div className="list divided">
            {plan.logs.map((l: any) => (
              <div key={l.id} className="list-row" style={{ padding: '12px 16px', alignItems: 'flex-start' }}>
                <span className="xs faint num" style={{ width: 86, flex: 'none', paddingTop: 3 }}>{l.date}</span>
                <div className="grow" style={{ whiteSpace: 'pre-wrap' }}>{l.content || <span className="faint">（未填写内容）</span>}</div>
                <span className="xs faint" style={{ whiteSpace: 'nowrap', paddingTop: 3 }}>{minutes(l.minutes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 32 }}><button className="btn ghost danger sm" onClick={remove}><Trash2 />删除这份计划</button></div>

      {modal?.kind === 'task' && <TaskModal task={modal.data} planId={id} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal?.kind === 'log' && <LogModal planId={id} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal?.kind === 'resource' && <ResourcePicker planId={id} onClose={() => setModal(null)} onAdded={setData} />}
    </div>
  );
}
