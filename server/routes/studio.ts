import { Hono } from 'hono';
import { all, get, insert, newId, now, run, tx, update } from '../db';
import { badRequest, isDate, notFound, parseJson, readJson, requireText } from '../lib/http';
import { deleteDocument, saveUpload } from '../lib/documents';
import { indexDoc, removeDoc } from '../lib/search';
import { STUDIO_IDENTITY, STUDIO_TASKS } from '../ai/prompts';
import { complete } from '../ai/service';

export const studioRoutes = new Hono();

interface TopicRow {
  id: string; title: string; angle: string; series: string; platform: string; format: string; status: string;
  priority: number; research_id: string | null; notes: string; outline: string; script: string;
  publish_date: string | null; published_url: string; metrics: string; retro: string; created_at: string; updated_at: string;
}

export const TOPIC_STATUSES = ['idea', 'research', 'script', 'production', 'scheduled', 'published'];
const TEXT_FIELDS = ['angle', 'series', 'platform', 'format', 'notes', 'outline', 'script', 'published_url', 'retro'];

const presentTopic = (t: TopicRow) => ({ ...t, metrics: parseJson<Record<string, number>>(t.metrics, {}) });
const presentRef = (r: Record<string, any>) => ({
  ...r, palette: parseJson<string[]>(r.palette, []), image_url: r.document_id ? `/api/documents/${r.document_id}/file` : null,
});

function reindex(id: string) {
  const t = get<TopicRow>('SELECT * FROM content_topics WHERE id = ?', id);
  if (t) indexDoc('topic', id, t.title, [t.angle, t.series, t.notes, t.outline, t.script].filter(Boolean).join('\n'));
}

function topicDetail(id: string) {
  const t = get<TopicRow>('SELECT * FROM content_topics WHERE id = ?', id);
  if (!t) throw notFound('选题');
  const research = t.research_id ? get('SELECT id, title, status FROM research_projects WHERE id = ?', t.research_id) : null;
  const refs = all<Record<string, any>>('SELECT * FROM content_refs WHERE topic_id = ? ORDER BY created_at DESC', id);
  return { ...presentTopic(t), research, refs: refs.map(presentRef) };
}

studioRoutes.get('/studio/topics', (c) => {
  const rows = all<TopicRow & { ref_count: number }>(
    `SELECT t.*, (SELECT COUNT(*) FROM content_refs r WHERE r.topic_id = t.id) AS ref_count
       FROM content_topics t ORDER BY t.priority DESC, t.updated_at DESC LIMIT 500`);
  return c.json(rows.map((t) => ({ ...presentTopic(t), outline: undefined, script: undefined, notes: undefined, retro: undefined, has_script: !!t.script.trim(), has_retro: !!t.retro.trim() })));
});

studioRoutes.post('/studio/topics', async (c) => {
  const b = await readJson(c);
  const id = newId('tp');
  insert('content_topics', {
    id, title: requireText(b.title, '选题', 160), angle: String(b.angle || ''), series: String(b.series || ''),
    platform: String(b.platform || ''), format: String(b.format || ''), notes: String(b.notes || ''),
    status: TOPIC_STATUSES.includes(b.status) ? b.status : 'idea', publish_date: isDate(b.publish_date) ? b.publish_date : null,
    research_id: b.research_id || null, created_at: now(), updated_at: now(),
  });
  reindex(id);
  return c.json(topicDetail(id), 201);
});

studioRoutes.get('/studio/topics/:id', (c) => c.json(topicDetail(c.req.param('id'))));

studioRoutes.patch('/studio/topics/:id', async (c) => {
  const id = c.req.param('id');
  if (!get('SELECT id FROM content_topics WHERE id = ?', id)) throw notFound('选题');
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '选题', 160);
  for (const f of TEXT_FIELDS) if (b[f] !== undefined) patch[f] = String(b[f] ?? '');
  if (b.status !== undefined && TOPIC_STATUSES.includes(b.status)) patch.status = b.status;
  if (b.priority !== undefined) patch.priority = Math.max(0, Math.min(3, Math.round(Number(b.priority)) || 0));
  if (b.publish_date !== undefined) patch.publish_date = isDate(b.publish_date) ? b.publish_date : null;
  if (b.research_id !== undefined) patch.research_id = b.research_id || null;
  if (b.metrics !== undefined && b.metrics && typeof b.metrics === 'object') {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.metrics)) {
      const n = Number(v);
      if (v !== '' && v !== null && Number.isFinite(n) && n >= 0) clean[k.slice(0, 20)] = n;
    }
    patch.metrics = JSON.stringify(clean);
  }
  update('content_topics', id, patch, ['title', ...TEXT_FIELDS, 'status', 'priority', 'publish_date', 'research_id', 'metrics'], { updated_at: now() });
  reindex(id);
  return c.json(topicDetail(id));
});

studioRoutes.delete('/studio/topics/:id', (c) => {
  const id = c.req.param('id');
  tx(() => {
    removeDoc('topic', id);
    run('DELETE FROM content_topics WHERE id = ?', id);
  });
  return c.json({ ok: true });
});

studioRoutes.get('/studio/tasks', (c) => c.json(Object.entries(STUDIO_TASKS).map(([id, t]) => ({ id, name: t.name, field: t.field }))));

/** AI 起草：返回草稿文本，由用户决定是否写入对应字段。 */
studioRoutes.post('/studio/topics/:id/draft', async (c) => {
  const id = c.req.param('id');
  const t = get<TopicRow>('SELECT * FROM content_topics WHERE id = ?', id);
  if (!t) throw notFound('选题');
  const b = await readJson(c);
  const task = STUDIO_TASKS[String(b.task)];
  if (!task) throw badRequest('未知的创作任务');

  const report = t.research_id
    ? get<{ title: string; content: string }>('SELECT title, content FROM research_reports WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', t.research_id)
    : undefined;
  const metrics = parseJson<Record<string, number>>(t.metrics, {});
  const material = [
    `选题：${t.title}`,
    t.angle && `切入角度：${t.angle}`,
    t.series && `所属栏目：${t.series}`,
    t.platform && `发布平台：${t.platform}`,
    t.format && `内容形式：${t.format}`,
    t.notes && `资料与笔记：\n${t.notes.slice(0, 20_000)}`,
    (b.task === 'script' || b.task === 'retro') && t.outline && `大纲：\n${t.outline.slice(0, 12_000)}`,
    b.task === 'retro' && t.script && `脚本：\n${t.script.slice(0, 20_000)}`,
    b.task === 'retro' && `发布数据：${Object.keys(metrics).length ? JSON.stringify(metrics) : '（尚未记录）'}`,
    report && `关联研究报告《${report.title}》（引用其中事实时保留来源编号）：\n${report.content.slice(0, 30_000)}`,
    b.instruction && `额外要求：${String(b.instruction).slice(0, 800)}`,
  ].filter(Boolean).join('\n\n');

  const res = await complete({
    system: STUDIO_IDENTITY,
    messages: [{ role: 'user', content: `${task.prompt}\n\n${material}` }],
    purpose: 'studio', refId: id, maxTokens: 16000,
  });
  return c.json({ task: b.task, name: task.name, field: task.field, content: res.text.trim(), model_ref: res.modelRef });
});

// ── 视觉参考 ─────────────────────────────────────────────────
studioRoutes.get('/studio/refs', (c) => {
  const topic = c.req.query('topic_id');
  const rows = topic
    ? all<Record<string, any>>('SELECT r.*, t.title AS topic_title FROM content_refs r LEFT JOIN content_topics t ON t.id = r.topic_id WHERE r.topic_id = ? ORDER BY r.created_at DESC', topic)
    : all<Record<string, any>>('SELECT r.*, t.title AS topic_title FROM content_refs r LEFT JOIN content_topics t ON t.id = r.topic_id ORDER BY r.created_at DESC LIMIT 500');
  return c.json(rows.map(presentRef));
});

const HEX = /^#[0-9a-f]{6}$/i;
const cleanPalette = (v: unknown) => (Array.isArray(v) ? v : String(v || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter((s) => HEX.test(s)).slice(0, 8);

/** 新增视觉参考：multipart（file 图片）或 JSON（url 外链）。 */
studioRoutes.post('/studio/refs', async (c) => {
  const type = c.req.header('content-type') || '';
  const id = newId('ref');
  if (type.includes('multipart/form-data')) {
    const form = await c.req.parseBody();
    if (!(form.file instanceof File)) throw badRequest('没有收到图片');
    const { doc } = await saveUpload(form.file);
    if (doc.kind !== 'image') throw badRequest('视觉参考只支持图片文件（PNG、JPG、WebP、GIF 等）');
    insert('content_refs', {
      id, topic_id: typeof form.topic_id === 'string' && form.topic_id ? form.topic_id : null,
      title: String(form.title || doc.title).slice(0, 120), note: String(form.note || ''), tags: String(form.tags || ''),
      document_id: doc.id, palette: JSON.stringify(cleanPalette(form.palette)), created_at: now(),
    });
  } else {
    const b = await readJson(c);
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw badRequest('请上传图片，或填写以 http(s):// 开头的参考链接');
    insert('content_refs', {
      id, topic_id: b.topic_id || null, title: String(b.title || url).slice(0, 120), note: String(b.note || ''),
      tags: String(b.tags || ''), url, palette: JSON.stringify(cleanPalette(b.palette)), created_at: now(),
    });
  }
  return c.json(presentRef(get<Record<string, any>>('SELECT * FROM content_refs WHERE id = ?', id)!), 201);
});

studioRoutes.patch('/studio/refs/:id', async (c) => {
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  for (const f of ['title', 'note', 'tags']) if (b[f] !== undefined) patch[f] = String(b[f] ?? '');
  if (b.topic_id !== undefined) patch.topic_id = b.topic_id || null;
  if (b.palette !== undefined) patch.palette = JSON.stringify(cleanPalette(b.palette));
  update('content_refs', c.req.param('id'), patch, ['title', 'note', 'tags', 'topic_id', 'palette']);
  const row = get<Record<string, any>>('SELECT * FROM content_refs WHERE id = ?', c.req.param('id'));
  if (!row) throw notFound('视觉参考');
  return c.json(presentRef(row));
});

studioRoutes.delete('/studio/refs/:id', (c) => {
  const row = get<{ id: string; document_id: string | null }>('SELECT id, document_id FROM content_refs WHERE id = ?', c.req.param('id'));
  if (!row) throw notFound('视觉参考');
  run('DELETE FROM content_refs WHERE id = ?', row.id);
  // 图片不再被任何参考使用时，连同文件一起删除
  if (row.document_id && !get('SELECT id FROM content_refs WHERE document_id = ?', row.document_id)) deleteDocument(row.document_id);
  return c.json({ ok: true });
});
