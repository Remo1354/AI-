import { Hono } from 'hono';
import { all, get, insert, newId, now, run, tx, update } from '../db';
import { badRequest, isDate, notFound, readJson, requireText, today } from '../lib/http';
import { getDocument } from '../lib/documents';
import { CARDS_SYSTEM } from '../ai/prompts';
import { completeJson } from '../ai/service';

export const cardRoutes = new Hono();

export type Rating = 'again' | 'hard' | 'good' | 'easy';
export const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy'];

interface CardRow {
  id: string; front: string; back: string; domain_id: string | null; knowledge_id: string | null; ai_generated: number;
  due_date: string; interval_days: number; ease: number; reps: number; lapses: number; suspended: number;
  last_reviewed_at: string | null; created_at: string; updated_at: string;
}

export const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * 间隔重复排程（SM-2 的简化版）。纯函数，测试直接覆盖。
 *   again 忘了：今天再来一遍，间隔归零，难度系数下降
 *   hard  勉强：间隔小幅增长，难度系数略降
 *   good  记得：1 天 → 3 天 → 之后按难度系数成倍增长
 *   easy  很熟：更快拉长间隔，难度系数上升
 */
export function schedule(card: Pick<CardRow, 'interval_days' | 'ease' | 'reps' | 'lapses'>, rating: Rating, date: string) {
  let { interval_days: interval, ease, reps, lapses } = card;
  if (rating === 'again') {
    interval = 0;
    reps = 0;
    lapses += 1;
    ease = Math.max(1.3, ease - 0.2);
  } else if (rating === 'hard') {
    interval = reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
    ease = Math.max(1.3, ease - 0.15);
    reps += 1;
  } else if (rating === 'good') {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(interval + 1, Math.round(interval * ease));
    reps += 1;
  } else {
    interval = reps === 0 ? 4 : Math.max(interval + 2, Math.round(interval * ease * 1.3));
    ease = Math.min(3.2, ease + 0.15);
    reps += 1;
  }
  interval = Math.min(interval, 365);
  return { interval_days: interval, ease: Math.round(ease * 100) / 100, reps, lapses, due_date: addDays(date, interval) };
}

const SELECT = `SELECT c.*, k.title AS knowledge_title FROM cards c LEFT JOIN knowledge_items k ON k.id = c.knowledge_id`;

/** 附带每个评分对应的下次间隔，前端直接显示在按钮上。 */
function present(c: CardRow & { knowledge_title?: string | null }, date: string) {
  const next = Object.fromEntries(RATINGS.map((r) => [r, schedule(c, r, date).interval_days]));
  return { ...c, ai_generated: !!c.ai_generated, suspended: !!c.suspended, next };
}

export function cardStats(date: string) {
  const one = (sql: string, ...p: unknown[]) => get<{ n: number }>(sql, ...p)!.n;
  return {
    due: one('SELECT COUNT(*) AS n FROM cards WHERE suspended = 0 AND due_date <= ?', date),
    total: one('SELECT COUNT(*) AS n FROM cards'),
    fresh: one('SELECT COUNT(*) AS n FROM cards WHERE last_reviewed_at IS NULL'),
    mature: one('SELECT COUNT(*) AS n FROM cards WHERE interval_days >= 21'),
    reviewed_today: one('SELECT COUNT(*) AS n FROM card_reviews WHERE date = ?', date),
    tomorrow: one('SELECT COUNT(*) AS n FROM cards WHERE suspended = 0 AND due_date = ?', addDays(date, 1)),
  };
}

cardRoutes.get('/cards/stats', (c) => {
  const q = c.req.query('date');
  return c.json(cardStats(isDate(q) ? q : today()));
});

cardRoutes.get('/cards', (c) => {
  const q = c.req.query('date');
  const date = isDate(q) ? q : today();
  const where: string[] = [];
  const params: unknown[] = [];
  if (c.req.query('scope') === 'due') { where.push('c.suspended = 0 AND c.due_date <= ?'); params.push(date); }
  if (c.req.query('domain_id')) { where.push('c.domain_id = ?'); params.push(c.req.query('domain_id')); }
  if (c.req.query('knowledge_id')) { where.push('c.knowledge_id = ?'); params.push(c.req.query('knowledge_id')); }
  const order = c.req.query('scope') === 'due' ? 'c.due_date, c.created_at' : 'c.created_at DESC';
  const rows = all<CardRow>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 500`, ...params);
  return c.json(rows.map((r) => present(r, date)));
});

/** 新建卡片。传 cards 数组可以一次保存多张（AI 草稿确认后走这里）。 */
cardRoutes.post('/cards', async (c) => {
  const b = await readJson(c);
  const date = isDate(b.date) ? b.date : today();
  const list: any[] = Array.isArray(b.cards) ? b.cards : [b];
  const knowledge = b.knowledge_id ? get<{ id: string; domain_id: string | null }>('SELECT id, domain_id FROM knowledge_items WHERE id = ?', b.knowledge_id) : undefined;
  if (b.knowledge_id && !knowledge) throw notFound('知识条目');
  const clean = list
    .map((x) => ({ front: String(x?.front || '').trim().slice(0, 2000), back: String(x?.back || '').trim().slice(0, 4000) }))
    .filter((x) => x.front);
  if (!clean.length) throw badRequest('请填写卡片的问题');
  const ids: string[] = [];
  tx(() => {
    for (const x of clean.slice(0, 100)) {
      const id = newId('card');
      ids.push(id);
      insert('cards', {
        id, front: x.front, back: x.back, domain_id: b.domain_id || knowledge?.domain_id || null, knowledge_id: knowledge?.id ?? null,
        ai_generated: b.ai_generated ? 1 : 0, due_date: date, created_at: now(), updated_at: now(),
      });
    }
  });
  return c.json({ created: ids.length, ids }, 201);
});

cardRoutes.patch('/cards/:id', async (c) => {
  const id = c.req.param('id');
  if (!get('SELECT id FROM cards WHERE id = ?', id)) throw notFound('卡片');
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.front !== undefined) patch.front = requireText(b.front, '问题', 2000);
  if (b.back !== undefined) patch.back = String(b.back ?? '').slice(0, 4000);
  if (b.domain_id !== undefined) patch.domain_id = b.domain_id || null;
  if (b.suspended !== undefined) patch.suspended = b.suspended ? 1 : 0;
  update('cards', id, patch, ['front', 'back', 'domain_id', 'suspended'], { updated_at: now() });
  return c.json(present(get<CardRow>(`${SELECT} WHERE c.id = ?`, id)!, today()));
});

cardRoutes.delete('/cards/:id', (c) => {
  run('DELETE FROM cards WHERE id = ?', c.req.param('id'));
  return c.json({ ok: true });
});

cardRoutes.post('/cards/:id/review', async (c) => {
  const card = get<CardRow>('SELECT * FROM cards WHERE id = ?', c.req.param('id'));
  if (!card) throw notFound('卡片');
  const b = await readJson(c);
  if (!RATINGS.includes(b.rating)) throw badRequest('评分无效');
  const date = isDate(b.date) ? b.date : today();
  const next = schedule(card, b.rating, date);
  tx(() => {
    update('cards', card.id, next, ['interval_days', 'ease', 'reps', 'lapses', 'due_date'], { last_reviewed_at: now(), updated_at: now() });
    insert('card_reviews', { id: newId('rv'), card_id: card.id, date, rating: b.rating, interval_days: next.interval_days, created_at: now() });
  });
  return c.json({ card: present(get<CardRow>(`${SELECT} WHERE c.id = ?`, card.id)!, date), stats: cardStats(date) });
});

/** AI 根据一条知识（或它关联的资料）、或任意一段文字（例如助手的回答）起草卡片。只返回草稿，由用户确认后再保存。 */
cardRoutes.post('/cards/generate', async (c) => {
  const b = await readJson(c);
  let title = String(b.title || '').trim().slice(0, 200);
  let text = String(b.text || '').trim();
  let itemId: string | null = null;
  if (b.knowledge_id) {
    const item = get<{ id: string; title: string; content: string; summary: string; document_id: string | null }>(
      'SELECT id, title, content, summary, document_id FROM knowledge_items WHERE id = ?', b.knowledge_id);
    if (!item) throw notFound('知识条目');
    const doc = item.document_id ? getDocument(item.document_id) : undefined;
    itemId = item.id;
    title = item.title;
    text = [item.summary, item.content, doc?.text].filter(Boolean).join('\n\n');
  }
  if (text.trim().length < 10) throw badRequest('内容太少，暂时出不了卡片');
  const LIMIT = 60_000;
  const truncated = text.length > LIMIT;
  const count = Math.min(Math.max(Math.round(Number(b.count)) || 8, 3), 20);
  const existing = itemId ? all<{ front: string }>('SELECT front FROM cards WHERE knowledge_id = ? LIMIT 60', itemId).map((r) => r.front) : [];
  const { data, modelRef } = await completeJson<{ cards?: unknown }>({
    system: CARDS_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `请出 ${count} 张左右的卡片。`,
        existing.length ? `已经有这些卡片，不要重复：\n${existing.map((f) => `- ${f}`).join('\n')}` : '',
        title ? `标题：${title}` : '',
        `内容${truncated ? `（较长，以下是前 ${LIMIT} 字）` : ''}：\n${text.slice(0, LIMIT)}`,
      ].filter(Boolean).join('\n\n'),
    }],
    purpose: 'cards', refId: itemId ?? undefined, maxTokens: 8000,
  });
  const cards = (Array.isArray(data.cards) ? data.cards : [])
    .map((x: any) => ({ front: String(x?.front || '').trim(), back: String(x?.back || '').trim() }))
    .filter((x) => x.front && x.back)
    .slice(0, 30);
  if (!cards.length) throw badRequest('模型没有生成可用的卡片，请重试');
  return c.json({ cards, truncated, model_ref: modelRef });
});
