import { Hono } from 'hono';
import { all, get, insert, newId, now, run, tx, update } from '../db';
import { badRequest, isDate, notFound, readJson, requireText, today } from '../lib/http';
import { indexDoc, removeDoc } from '../lib/search';
import { PLAN_SYSTEM, REVIEW_SYSTEM } from '../ai/prompts';
import { complete, completeJson } from '../ai/service';

export const learningRoutes = new Hono();

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dateOr = (v: unknown, fallback: string | null = null) => (isDate(v) ? v : fallback);
const intOr = (v: unknown, fallback: number | null = null) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== '' && v !== null && v !== undefined ? n : fallback;
};

// ── 统计 ─────────────────────────────────────────────────────
export function learningStats(date: string) {
  const from28 = addDays(date, -27);
  const from7 = addDays(date, -6);
  const byDay = new Map(
    all<{ date: string; minutes: number }>('SELECT date, SUM(minutes) AS minutes FROM study_logs WHERE date >= ? AND date <= ? GROUP BY date', from28, date)
      .map((r) => [r.date, r.minutes]));
  const days = Array.from({ length: 28 }, (_, i) => {
    const d = addDays(from28, i);
    return { date: d, minutes: byDay.get(d) ?? 0 };
  });

  // 连续学习天数：今天还没记录时从昨天算起，不因为「今天还没学」就清零
  const logged = new Set(all<{ date: string }>('SELECT DISTINCT date FROM study_logs WHERE date <= ? AND minutes > 0 ORDER BY date DESC LIMIT 400', date).map((r) => r.date));
  let streak = 0;
  let cursor = logged.has(date) ? date : addDays(date, -1);
  while (logged.has(cursor)) { streak++; cursor = addDays(cursor, -1); }

  const domains = all<Record<string, any>>(
    `SELECT d.id, d.name, d.color, d.icon, d.description,
        (SELECT COALESCE(SUM(minutes), 0) FROM study_logs l WHERE l.domain_id = d.id) AS minutes_total,
        (SELECT COALESCE(SUM(minutes), 0) FROM study_logs l WHERE l.domain_id = d.id AND l.date >= ? AND l.date <= ?) AS minutes_7d,
        (SELECT COALESCE(SUM(minutes), 0) FROM study_logs l WHERE l.domain_id = d.id AND l.date >= ? AND l.date <= ?) AS minutes_28d,
        (SELECT COUNT(*) FROM plans p WHERE p.domain_id = d.id AND p.status = 'active') AS active_plans,
        (SELECT COUNT(*) FROM tasks t LEFT JOIN plans p ON p.id = t.plan_id
          WHERE COALESCE(p.domain_id, t.domain_id) = d.id AND (p.id IS NULL OR p.status = 'active')) AS tasks_total,
        (SELECT COUNT(*) FROM tasks t LEFT JOIN plans p ON p.id = t.plan_id
          WHERE COALESCE(p.domain_id, t.domain_id) = d.id AND (p.id IS NULL OR p.status = 'active') AND t.status = 'done') AS tasks_done,
        (SELECT COUNT(*) FROM knowledge_items k WHERE k.domain_id = d.id) AS knowledge_count
       FROM domains d ORDER BY d.sort, d.created_at`, from7, date, from28, date);

  const sum = (from: string) => get<{ m: number }>('SELECT COALESCE(SUM(minutes), 0) AS m FROM study_logs WHERE date >= ? AND date <= ?', from, date)!.m;
  return {
    date, streak, days, domains,
    minutes_today: byDay.get(date) ?? 0, minutes_7d: sum(from7), minutes_28d: sum(from28),
  };
}

learningRoutes.get('/learning/stats', (c) => c.json(learningStats(dateOr(c.req.query('date'), today())!)));

// ── 学习方向 ─────────────────────────────────────────────────
learningRoutes.get('/domains', (c) => c.json(all('SELECT * FROM domains ORDER BY sort, created_at')));

learningRoutes.post('/domains', async (c) => {
  const b = await readJson(c);
  const id = newId('dom');
  const max = get<{ m: number }>('SELECT COALESCE(MAX(sort), 0) AS m FROM domains')!.m;
  insert('domains', {
    id, name: requireText(b.name, '方向名称', 30), description: String(b.description || '').slice(0, 120),
    color: String(b.color || 'indigo'), icon: String(b.icon || 'book'), sort: max + 1, created_at: now(),
  });
  return c.json(get('SELECT * FROM domains WHERE id = ?', id), 201);
});

learningRoutes.patch('/domains/:id', async (c) => {
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = requireText(b.name, '方向名称', 30);
  for (const f of ['description', 'color', 'icon']) if (b[f] !== undefined) patch[f] = String(b[f]);
  if (b.sort !== undefined) patch.sort = intOr(b.sort, 0);
  update('domains', c.req.param('id'), patch, ['name', 'description', 'color', 'icon', 'sort']);
  return c.json(get('SELECT * FROM domains WHERE id = ?', c.req.param('id')));
});

learningRoutes.delete('/domains/:id', (c) => {
  run('DELETE FROM domains WHERE id = ?', c.req.param('id'));
  return c.json({ ok: true });
});

// ── 学习计划 ─────────────────────────────────────────────────
const PLAN_LIST = `SELECT p.*,
    (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id) AS tasks_total,
    (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id AND t.status = 'done') AS tasks_done,
    (SELECT COALESCE(SUM(minutes), 0) FROM study_logs l WHERE l.plan_id = p.id) AS minutes_total,
    (SELECT MIN(t.due_date) FROM tasks t WHERE t.plan_id = p.id AND t.status != 'done' AND t.due_date IS NOT NULL) AS next_due
  FROM plans p`;

learningRoutes.get('/plans', (c) => {
  const domain = c.req.query('domain_id');
  const rows = domain
    ? all(`${PLAN_LIST} WHERE p.domain_id = ? ORDER BY (p.status = 'active') DESC, p.updated_at DESC`, domain)
    : all(`${PLAN_LIST} ORDER BY (p.status = 'active') DESC, p.updated_at DESC`);
  return c.json(rows);
});

interface TaskInput { title?: unknown; stage?: unknown; due_date?: unknown; estimate_min?: unknown; notes?: unknown }

function insertTasks(planId: string, domainId: string | null, tasks: TaskInput[]) {
  let sort = get<{ m: number }>('SELECT COALESCE(MAX(sort), 0) AS m FROM tasks WHERE plan_id = ?', planId)!.m;
  for (const t of tasks) {
    const title = String(t.title || '').trim();
    if (!title) continue;
    insert('tasks', {
      id: newId('task'), plan_id: planId, domain_id: domainId, title: title.slice(0, 200),
      notes: String(t.notes || ''), stage: String(t.stage || '').slice(0, 60), due_date: dateOr(t.due_date),
      estimate_min: intOr(t.estimate_min), sort: ++sort, created_at: now(),
    });
  }
}

function planDetail(id: string) {
  const plan = get(`${PLAN_LIST} WHERE p.id = ?`, id);
  if (!plan) throw notFound('学习计划');
  return {
    ...plan,
    tasks: all('SELECT * FROM tasks WHERE plan_id = ? ORDER BY sort, created_at', id),
    resources: all(
      `SELECT k.id, k.title, k.type, substr(k.summary, 1, 100) AS summary FROM knowledge_items k
         JOIN plan_resources r ON r.item_id = k.id WHERE r.plan_id = ? ORDER BY r.created_at`, id),
    logs: all('SELECT * FROM study_logs WHERE plan_id = ? ORDER BY date DESC, created_at DESC LIMIT 50', id),
  };
}

learningRoutes.post('/plans', async (c) => {
  const b = await readJson(c);
  const id = newId('plan');
  const ts = now();
  const title = requireText(b.title, '计划名称', 120);
  tx(() => {
    insert('plans', {
      id, domain_id: b.domain_id || null, title, goal: String(b.goal || ''), roadmap: String(b.roadmap || ''),
      status: 'active', start_date: dateOr(b.start_date), target_date: dateOr(b.target_date),
      ai_generated: b.ai_generated ? 1 : 0, created_at: ts, updated_at: ts,
    });
    if (Array.isArray(b.tasks)) insertTasks(id, b.domain_id || null, b.tasks);
    indexDoc('plan', id, title, `${b.goal || ''}\n${b.roadmap || ''}`);
  });
  return c.json(planDetail(id), 201);
});

learningRoutes.get('/plans/:id', (c) => c.json(planDetail(c.req.param('id'))));

learningRoutes.patch('/plans/:id', async (c) => {
  const id = c.req.param('id');
  if (!get('SELECT id FROM plans WHERE id = ?', id)) throw notFound('学习计划');
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '计划名称', 120);
  for (const f of ['goal', 'roadmap']) if (b[f] !== undefined) patch[f] = String(b[f] ?? '');
  if (b.status !== undefined && ['active', 'paused', 'done'].includes(b.status)) patch.status = b.status;
  if (b.domain_id !== undefined) patch.domain_id = b.domain_id || null;
  for (const f of ['start_date', 'target_date']) if (b[f] !== undefined) patch[f] = dateOr(b[f]);
  tx(() => {
    update('plans', id, patch, ['title', 'goal', 'roadmap', 'status', 'domain_id', 'start_date', 'target_date'], { updated_at: now() });
    if (patch.domain_id !== undefined) run('UPDATE tasks SET domain_id = ? WHERE plan_id = ?', patch.domain_id, id);
    const p = get<{ title: string; goal: string; roadmap: string }>('SELECT title, goal, roadmap FROM plans WHERE id = ?', id)!;
    indexDoc('plan', id, p.title, `${p.goal}\n${p.roadmap}`);
  });
  return c.json(planDetail(id));
});

learningRoutes.delete('/plans/:id', (c) => {
  const id = c.req.param('id');
  tx(() => {
    removeDoc('plan', id);
    run('DELETE FROM plans WHERE id = ?', id);
  });
  return c.json({ ok: true });
});

learningRoutes.post('/plans/:id/resources', async (c) => {
  const id = c.req.param('id');
  const { item_id } = await readJson(c);
  if (!get('SELECT id FROM plans WHERE id = ?', id) || !get('SELECT id FROM knowledge_items WHERE id = ?', item_id)) throw notFound('计划或资料');
  run('INSERT OR IGNORE INTO plan_resources (plan_id, item_id, created_at) VALUES (?, ?, ?)', id, item_id, now());
  return c.json(planDetail(id));
});

learningRoutes.delete('/plans/:id/resources/:itemId', (c) => {
  run('DELETE FROM plan_resources WHERE plan_id = ? AND item_id = ?', c.req.param('id'), c.req.param('itemId'));
  return c.json(planDetail(c.req.param('id')));
});

/** AI 生成学习计划草稿。只返回草稿，不写库；用户确认/修改后再调用 POST /plans 保存。 */
learningRoutes.post('/plans/generate', async (c) => {
  const b = await readJson(c);
  const topic = requireText(b.topic, '学习主题', 200);
  const weeks = Math.min(Math.max(intOr(b.weeks, 8)!, 1), 52);
  const hours = Math.min(Math.max(Number(b.hours_per_week) || 5, 1), 80);
  const start = dateOr(b.start_date, today())!;
  const domain = b.domain_id ? get<{ name: string }>('SELECT name FROM domains WHERE id = ?', b.domain_id) : undefined;
  const { data, modelRef } = await completeJson<Record<string, any>>({
    system: PLAN_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `学习主题：${topic}`,
        domain && `所属方向：${domain.name}`,
        b.goal && `想达到的目标：${String(b.goal).slice(0, 500)}`,
        b.level && `现有基础：${String(b.level).slice(0, 300)}`,
        `计划周期：${weeks} 周`,
        `每周可投入：约 ${hours} 小时`,
      ].filter(Boolean).join('\n'),
    }],
    purpose: 'plan', maxTokens: 12000,
  });

  const stages = Array.isArray(data.stages) ? data.stages : [];
  const tasks: Record<string, unknown>[] = [];
  let weekCursor = 1;
  for (const s of stages) {
    const stageName = String(s?.name || '').trim();
    const stageWeeks = Math.max(1, intOr(s?.weeks, 1)!);
    for (const t of Array.isArray(s?.tasks) ? s.tasks : []) {
      const title = String(t?.title || '').trim();
      if (!title) continue;
      const week = Math.min(Math.max(intOr(t?.week, weekCursor)!, 1), weeks);
      tasks.push({ title, stage: stageName, estimate_min: intOr(t?.estimate_min), due_date: addDays(start, week * 7 - 1) });
    }
    weekCursor += stageWeeks;
  }
  if (!tasks.length) throw badRequest('模型没有生成可用的任务，请调整描述后重试');
  return c.json({
    draft: {
      title: String(data.title || topic).slice(0, 120), goal: String(data.goal || b.goal || ''),
      roadmap: String(data.roadmap || ''), domain_id: b.domain_id || null,
      start_date: start, target_date: addDays(start, weeks * 7 - 1), tasks, ai_generated: true,
    },
    model_ref: modelRef,
  });
});

// ── 任务 ─────────────────────────────────────────────────────
const TASK_SELECT = `SELECT t.*, p.title AS plan_title, COALESCE(p.domain_id, t.domain_id) AS effective_domain_id
  FROM tasks t LEFT JOIN plans p ON p.id = t.plan_id`;

/** 「今日任务」= 今天到期 + 已逾期未完成 + 今天完成的。 */
export function tasksForDay(date: string) {
  return all(
    `${TASK_SELECT}
      WHERE (p.id IS NULL OR p.status = 'active')
        AND ((t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date <= ?)
          OR (t.status = 'done' AND substr(t.completed_at, 1, 10) = ?)
          OR (t.status = 'done' AND t.due_date = ?))
      ORDER BY (t.status = 'done'), t.due_date, t.sort`, date, date, date);
}

learningRoutes.get('/tasks', (c) => {
  const scope = c.req.query('scope');
  const date = dateOr(c.req.query('date'), today())!;
  if (scope === 'today') return c.json(tasksForDay(date));
  if (scope === 'upcoming') {
    return c.json(all(`${TASK_SELECT} WHERE t.status != 'done' AND t.due_date > ? AND t.due_date <= ? AND (p.id IS NULL OR p.status = 'active') ORDER BY t.due_date, t.sort LIMIT 100`, date, addDays(date, 14)));
  }
  if (scope === 'inbox') {
    return c.json(all(`${TASK_SELECT} WHERE t.plan_id IS NULL AND t.status != 'done' AND t.due_date IS NULL ORDER BY t.created_at DESC LIMIT 100`));
  }
  if (c.req.query('plan_id')) return c.json(all(`${TASK_SELECT} WHERE t.plan_id = ? ORDER BY t.sort, t.created_at`, c.req.query('plan_id')));
  return c.json(all(`${TASK_SELECT} ORDER BY t.created_at DESC LIMIT 300`));
});

learningRoutes.post('/tasks', async (c) => {
  const b = await readJson(c);
  const id = newId('task');
  const plan = b.plan_id ? get<{ id: string; domain_id: string | null }>('SELECT id, domain_id FROM plans WHERE id = ?', b.plan_id) : undefined;
  if (b.plan_id && !plan) throw notFound('学习计划');
  const sort = get<{ m: number }>('SELECT COALESCE(MAX(sort), 0) AS m FROM tasks WHERE plan_id IS ?', plan?.id ?? null)!.m + 1;
  insert('tasks', {
    id, plan_id: plan?.id ?? null, domain_id: plan?.domain_id ?? b.domain_id ?? null,
    title: requireText(b.title, '任务内容', 200), notes: String(b.notes || ''), stage: String(b.stage || '').slice(0, 60),
    due_date: dateOr(b.due_date), estimate_min: intOr(b.estimate_min), sort, created_at: now(),
  });
  return c.json(get(`${TASK_SELECT} WHERE t.id = ?`, id), 201);
});

learningRoutes.patch('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const task = get<{ id: string; status: string }>('SELECT id, status FROM tasks WHERE id = ?', id);
  if (!task) throw notFound('任务');
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '任务内容', 200);
  for (const f of ['notes', 'stage']) if (b[f] !== undefined) patch[f] = String(b[f] ?? '');
  if (b.due_date !== undefined) patch.due_date = dateOr(b.due_date);
  if (b.estimate_min !== undefined) patch.estimate_min = intOr(b.estimate_min);
  if (b.sort !== undefined) patch.sort = intOr(b.sort, 0);
  if (b.status !== undefined && ['todo', 'done'].includes(b.status) && b.status !== task.status) {
    patch.status = b.status;
    patch.completed_at = b.status === 'done' ? (isDate(b.date) ? `${b.date}T${now().slice(11)}` : now()) : null;
  }
  update('tasks', id, patch, ['title', 'notes', 'stage', 'due_date', 'estimate_min', 'sort', 'status', 'completed_at']);
  return c.json(get(`${TASK_SELECT} WHERE t.id = ?`, id));
});

learningRoutes.delete('/tasks/:id', (c) => {
  run('DELETE FROM tasks WHERE id = ?', c.req.param('id'));
  return c.json({ ok: true });
});

// ── 学习记录 ─────────────────────────────────────────────────
const LOG_SELECT = `SELECT l.*, p.title AS plan_title FROM study_logs l LEFT JOIN plans p ON p.id = l.plan_id`;

learningRoutes.get('/logs', (c) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (isDate(c.req.query('from'))) { where.push('l.date >= ?'); params.push(c.req.query('from')); }
  if (isDate(c.req.query('to'))) { where.push('l.date <= ?'); params.push(c.req.query('to')); }
  if (c.req.query('domain_id')) { where.push('l.domain_id = ?'); params.push(c.req.query('domain_id')); }
  if (c.req.query('plan_id')) { where.push('l.plan_id = ?'); params.push(c.req.query('plan_id')); }
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  return c.json(all(`${LOG_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.date DESC, l.created_at DESC LIMIT ?`, ...params, limit));
});

learningRoutes.post('/logs', async (c) => {
  const b = await readJson(c);
  const minutes = Math.max(0, Math.min(intOr(b.minutes, 0)!, 24 * 60));
  const content = String(b.content || '').trim();
  if (!minutes && !content) throw badRequest('请填写学习时长或学习内容');
  const plan = b.plan_id ? get<{ id: string; domain_id: string | null }>('SELECT id, domain_id FROM plans WHERE id = ?', b.plan_id) : undefined;
  const id = newId('log');
  insert('study_logs', {
    id, date: dateOr(b.date, today()), domain_id: b.domain_id || plan?.domain_id || null, plan_id: plan?.id ?? null,
    minutes, content, created_at: now(),
  });
  return c.json(get(`${LOG_SELECT} WHERE l.id = ?`, id), 201);
});

learningRoutes.patch('/logs/:id', async (c) => {
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.content !== undefined) patch.content = String(b.content ?? '');
  if (b.minutes !== undefined) patch.minutes = Math.max(0, Math.min(intOr(b.minutes, 0)!, 24 * 60));
  if (b.date !== undefined && isDate(b.date)) patch.date = b.date;
  if (b.domain_id !== undefined) patch.domain_id = b.domain_id || null;
  if (b.plan_id !== undefined) patch.plan_id = b.plan_id || null;
  update('study_logs', c.req.param('id'), patch, ['content', 'minutes', 'date', 'domain_id', 'plan_id']);
  const row = get(`${LOG_SELECT} WHERE l.id = ?`, c.req.param('id'));
  if (!row) throw notFound('学习记录');
  return c.json(row);
});

learningRoutes.delete('/logs/:id', (c) => {
  run('DELETE FROM study_logs WHERE id = ?', c.req.param('id'));
  return c.json({ ok: true });
});

// ── 阶段性总结 ───────────────────────────────────────────────
learningRoutes.get('/reviews', (c) => c.json(all('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 100')));

learningRoutes.post('/reviews', async (c) => {
  const b = await readJson(c);
  const id = newId('rev');
  insert('reviews', {
    id, title: requireText(b.title, '总结标题', 120), content: String(b.content || ''), domain_id: b.domain_id || null,
    plan_id: b.plan_id || null, period_start: dateOr(b.period_start), period_end: dateOr(b.period_end),
    created_at: now(), updated_at: now(),
  });
  return c.json(get('SELECT * FROM reviews WHERE id = ?', id), 201);
});

learningRoutes.patch('/reviews/:id', async (c) => {
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '总结标题', 120);
  if (b.content !== undefined) patch.content = String(b.content ?? '');
  update('reviews', c.req.param('id'), patch, ['title', 'content'], { updated_at: now() });
  return c.json(get('SELECT * FROM reviews WHERE id = ?', c.req.param('id')));
});

learningRoutes.delete('/reviews/:id', (c) => {
  run('DELETE FROM reviews WHERE id = ?', c.req.param('id'));
  return c.json({ ok: true });
});

/** AI 起草阶段总结：只依据这段时间真实的学习记录和任务完成情况。返回草稿，不写库。 */
learningRoutes.post('/reviews/generate', async (c) => {
  const b = await readJson(c);
  const end = dateOr(b.period_end, today())!;
  const start = dateOr(b.period_start, addDays(end, -6))!;
  const domainFilter = b.domain_id ? ' AND l.domain_id = ?' : '';
  const logs = all<{ date: string; minutes: number; content: string; domain: string | null; plan_title: string | null }>(
    `SELECT l.date, l.minutes, l.content, d.name AS domain, p.title AS plan_title
       FROM study_logs l LEFT JOIN domains d ON d.id = l.domain_id LEFT JOIN plans p ON p.id = l.plan_id
      WHERE l.date >= ? AND l.date <= ?${domainFilter} ORDER BY l.date`,
    ...[start, end, ...(b.domain_id ? [b.domain_id] : [])]);
  const taskFilter = b.domain_id ? ' AND COALESCE(p.domain_id, t.domain_id) = ?' : '';
  const done = all<{ title: string; plan_title: string | null }>(
    `SELECT t.title, p.title AS plan_title FROM tasks t LEFT JOIN plans p ON p.id = t.plan_id
      WHERE t.status = 'done' AND substr(t.completed_at, 1, 10) >= ? AND substr(t.completed_at, 1, 10) <= ?${taskFilter}`,
    ...[start, end, ...(b.domain_id ? [b.domain_id] : [])]);
  const overdue = all<{ title: string; due_date: string; plan_title: string | null }>(
    `SELECT t.title, t.due_date, p.title AS plan_title FROM tasks t LEFT JOIN plans p ON p.id = t.plan_id
      WHERE t.status != 'done' AND t.due_date >= ? AND t.due_date <= ?${taskFilter}`,
    ...[start, end, ...(b.domain_id ? [b.domain_id] : [])]);
  if (!logs.length && !done.length) throw badRequest('这段时间没有学习记录或完成的任务，暂时没有可总结的内容');

  const material = [
    `时间范围：${start} 至 ${end}`,
    `总学习时长：${logs.reduce((n, l) => n + l.minutes, 0)} 分钟，共 ${logs.length} 条记录`,
    '\n学习记录：',
    ...logs.map((l) => `- ${l.date}｜${l.domain || '未分类'}${l.plan_title ? `｜${l.plan_title}` : ''}｜${l.minutes} 分钟｜${l.content || '（无文字记录）'}`),
    '\n已完成的任务：',
    ...(done.length ? done.map((t) => `- ${t.title}${t.plan_title ? `（${t.plan_title}）` : ''}`) : ['- 无']),
    '\n到期未完成的任务：',
    ...(overdue.length ? overdue.map((t) => `- ${t.title}（应于 ${t.due_date}）`) : ['- 无']),
  ].join('\n');
  const res = await complete({ system: REVIEW_SYSTEM, messages: [{ role: 'user', content: material }], purpose: 'review', maxTokens: 8000 });
  return c.json({
    draft: { title: `${start} – ${end} 学习总结`, content: res.text.trim(), period_start: start, period_end: end, domain_id: b.domain_id || null },
    model_ref: res.modelRef,
    basis: { logs: logs.length, tasks_done: done.length, tasks_overdue: overdue.length },
  });
});
