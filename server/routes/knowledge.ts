import { Hono } from 'hono';
import { zipSync, strToU8 } from 'fflate';
import { all, get, insert, newId, now, run, tx, update } from '../db';
import { badRequest, notFound, readJson, requireText } from '../lib/http';
import { createKnowledge, presentKnowledge, reindexKnowledge, setTags, tagsOf, type KnowledgeRow } from '../lib/knowledge';
import { getDocument } from '../lib/documents';
import { removeDoc, search, queryGrams, type IndexKind } from '../lib/search';
import { applySummary, summarizeText } from './documents';

export const knowledgeRoutes = new Hono();

const LIST_COLUMNS = `k.id, k.type, k.title, k.summary, k.key_points, k.category_id, k.domain_id, k.document_id,
  k.source_kind, k.source_id, k.source_url, k.pinned, k.created_at, k.updated_at, substr(k.content, 1, 240) AS content`;

function listItems(where: string[], params: unknown[], limit = 300) {
  const rows = all<KnowledgeRow>(
    `SELECT ${LIST_COLUMNS} FROM knowledge_items k ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY k.pinned DESC, k.updated_at DESC LIMIT ?`, ...params, limit);
  return rows.map(presentKnowledge);
}

knowledgeRoutes.get('/knowledge', (c) => {
  const q = (c.req.query('q') || '').trim();
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { where.push(sql); params.push(v); };
  if (c.req.query('category_id')) add('k.category_id = ?', c.req.query('category_id'));
  if (c.req.query('domain_id')) add('k.domain_id = ?', c.req.query('domain_id'));
  if (c.req.query('type')) add('k.type = ?', c.req.query('type'));
  if (c.req.query('tag')) {
    add('k.id IN (SELECT kt.item_id FROM knowledge_tags kt JOIN tags t ON t.id = kt.tag_id WHERE t.name = ?)', c.req.query('tag'));
  }

  if (!q) return c.json({ items: listItems(where, params), query: '' });

  // 全文检索：同时查知识条目本身和它关联资料的正文片段
  const hits = search(q, { kinds: ['knowledge', 'chunk'], limit: 100 });
  const snippets = new Map<string, string>();
  const order: string[] = [];
  for (const h of hits) {
    const ids = h.kind === 'knowledge'
      ? [h.ref_id]
      : all<{ id: string }>('SELECT id FROM knowledge_items WHERE document_id = ?', h.parent_id).map((r) => r.id);
    for (const id of ids) {
      if (!snippets.has(id)) { snippets.set(id, h.snippet); order.push(id); }
    }
  }
  if (!order.length) return c.json({ items: [], query: q });
  where.push(`k.id IN (${order.map(() => '?').join(',')})`);
  params.push(...order);
  const items = listItems(where, params)
    .map((it) => ({ ...it, snippet: snippets.get(it.id) }))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return c.json({ items, query: q });
});

knowledgeRoutes.post('/knowledge', async (c) => {
  const b = await readJson(c);
  const id = createKnowledge({
    type: b.type === 'summary' ? 'summary' : 'note',
    title: requireText(b.title, '标题', 200), content: String(b.content || ''), summary: String(b.summary || ''),
    category_id: b.category_id, domain_id: b.domain_id, tags: b.tags, source_url: b.source_url,
    source_kind: b.source_kind || 'manual', source_id: b.source_id,
  });
  return c.json(detail(id), 201);
});

function detail(id: string) {
  const row = get<KnowledgeRow>('SELECT * FROM knowledge_items WHERE id = ?', id);
  if (!row) throw notFound('知识条目');
  const links = all(
    `SELECT l.id, l.relation, 'out' AS direction, k.id AS item_id, k.title, k.type
       FROM knowledge_links l JOIN knowledge_items k ON k.id = l.to_id WHERE l.from_id = ?
     UNION ALL
     SELECT l.id, l.relation, 'in' AS direction, k.id AS item_id, k.title, k.type
       FROM knowledge_links l JOIN knowledge_items k ON k.id = l.from_id WHERE l.to_id = ?`, id, id);
  const doc = row.document_id ? getDocument(row.document_id) : undefined;
  const plans = all('SELECT p.id, p.title FROM plans p JOIN plan_resources r ON r.plan_id = p.id WHERE r.item_id = ?', id);
  return {
    ...presentKnowledge(row), links, plans,
    document: doc
      ? { id: doc.id, filename: doc.filename, ext: doc.ext, size: doc.size, pages: doc.pages, chars: doc.chars, status: doc.status, error: doc.error, kind: doc.kind, text: doc.text.slice(0, 30_000), text_truncated: doc.text.length > 30_000 }
      : null,
  };
}

knowledgeRoutes.get('/knowledge/export', (c) => {
  const rows = all<KnowledgeRow>('SELECT * FROM knowledge_items ORDER BY created_at');
  const categories = new Map(all<{ id: string; name: string }>('SELECT id, name FROM categories').map((r) => [r.id, r.name]));
  const domains = new Map(all<{ id: string; name: string }>('SELECT id, name FROM domains').map((r) => [r.id, r.name]));
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const row of rows) {
    const item = presentKnowledge(row);
    const folder = (item.category_id && categories.get(item.category_id)) || '未分类';
    let name = item.title.replace(/[\\/:*?"<>|\n\r]/g, ' ').trim().slice(0, 80) || item.id;
    while (used.has(`${folder}/${name}`)) name += `-${item.id.slice(-4)}`;
    used.add(`${folder}/${name}`);
    const yaml = (v: string) => JSON.stringify(v);
    const front = [
      '---',
      `id: ${item.id}`,
      `title: ${yaml(item.title)}`,
      `type: ${item.type}`,
      `category: ${yaml(folder)}`,
      `domain: ${yaml((item.domain_id && domains.get(item.domain_id)) || '')}`,
      `tags: [${item.tags.map(yaml).join(', ')}]`,
      item.source_url ? `source_url: ${yaml(item.source_url)}` : '',
      `created: ${item.created_at}`,
      `updated: ${item.updated_at}`,
      '---',
    ].filter(Boolean).join('\n');
    const doc = item.document_id ? getDocument(item.document_id) : undefined;
    const body = [
      `# ${item.title}`,
      item.summary && `## 摘要\n\n${item.summary}`,
      item.key_points.length && `## 知识点\n\n${item.key_points.map((p) => `- ${p}`).join('\n')}`,
      item.content,
      doc?.text && `## 资料原文（${doc.filename}）\n\n${doc.text}`,
    ].filter(Boolean).join('\n\n');
    files[`${folder}/${name}.md`] = strToU8(`${front}\n\n${body}\n`);
  }
  files['README.txt'] = strToU8(`Remo 知识库导出\n导出时间：${now()}\n条目数：${rows.length}\n每个条目是一个 Markdown 文件，按分类放在文件夹里。\n`);
  const zip = zipSync(files, { level: 6 });
  return new Response(zip as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="remo-knowledge-${now().slice(0, 10)}.zip"`,
    },
  });
});

knowledgeRoutes.get('/knowledge/:id', (c) => c.json(detail(c.req.param('id'))));

knowledgeRoutes.patch('/knowledge/:id', async (c) => {
  const id = c.req.param('id');
  if (!get('SELECT id FROM knowledge_items WHERE id = ?', id)) throw notFound('知识条目');
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '标题', 200);
  for (const f of ['content', 'summary', 'source_url']) if (b[f] !== undefined) patch[f] = String(b[f] ?? '');
  for (const f of ['category_id', 'domain_id']) if (b[f] !== undefined) patch[f] = b[f] || null;
  if (b.key_points !== undefined) patch.key_points = JSON.stringify(Array.isArray(b.key_points) ? b.key_points.map(String).filter(Boolean) : []);
  if (b.pinned !== undefined) patch.pinned = b.pinned ? 1 : 0;
  tx(() => {
    update('knowledge_items', id, patch, ['title', 'content', 'summary', 'source_url', 'category_id', 'domain_id', 'key_points', 'pinned'], { updated_at: now() });
    if (b.tags !== undefined) setTags(id, b.tags);
    reindexKnowledge(id);
  });
  return c.json(detail(id));
});

knowledgeRoutes.delete('/knowledge/:id', (c) => {
  const id = c.req.param('id');
  tx(() => {
    removeDoc('knowledge', id);
    run('DELETE FROM knowledge_items WHERE id = ?', id);
    run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM knowledge_tags)');
  });
  return c.json({ ok: true });
});

/** AI 提炼：摘要 + 知识点 + 标签。来源是条目正文，或其关联资料的全文。 */
knowledgeRoutes.post('/knowledge/:id/summarize', async (c) => {
  const id = c.req.param('id');
  const row = get<KnowledgeRow>('SELECT * FROM knowledge_items WHERE id = ?', id);
  if (!row) throw notFound('知识条目');
  const doc = row.document_id ? getDocument(row.document_id) : undefined;
  const text = [row.content, doc?.text].filter(Boolean).join('\n\n');
  if (text.trim().length < 10) throw badRequest('内容太少，暂时没有可提炼的东西');
  const result = await summarizeText(row.title, text, id);
  applySummary(id, result);
  return c.json(detail(id));
});

// ── 知识关联 ─────────────────────────────────────────────────
knowledgeRoutes.post('/knowledge/:id/links', async (c) => {
  const from = c.req.param('id');
  const b = await readJson(c);
  const to = String(b.to_id || '');
  if (from === to) throw badRequest('不能关联到自己');
  if (!get('SELECT id FROM knowledge_items WHERE id = ?', from) || !get('SELECT id FROM knowledge_items WHERE id = ?', to)) throw notFound('知识条目');
  const dup = get('SELECT id FROM knowledge_links WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', from, to, to, from);
  if (!dup) insert('knowledge_links', { id: newId('ln'), from_id: from, to_id: to, relation: String(b.relation || '相关').slice(0, 20), created_at: now() });
  return c.json(detail(from));
});

knowledgeRoutes.delete('/knowledge/links/:linkId', (c) => {
  run('DELETE FROM knowledge_links WHERE id = ?', c.req.param('linkId'));
  return c.json({ ok: true });
});

/** 关联建议：基于标题与标签的全文相似度（不调用 AI），由用户确认后才建立关联。 */
knowledgeRoutes.get('/knowledge/:id/suggestions', (c) => {
  const id = c.req.param('id');
  const row = get<KnowledgeRow>('SELECT * FROM knowledge_items WHERE id = ?', id);
  if (!row) throw notFound('知识条目');
  const linked = new Set(all<{ a: string; b: string }>('SELECT from_id AS a, to_id AS b FROM knowledge_links WHERE from_id = ? OR to_id = ?', id, id).flatMap((r) => [r.a, r.b]));
  linked.add(id);
  const grams = queryGrams(`${row.title} ${tagsOf(id).join(' ')}`, 24);
  if (!grams.length) return c.json([]);
  let rows: { ref_id: string }[] = [];
  try {
    rows = all<{ ref_id: string }>(
      `SELECT ref_id FROM search_index WHERE search_index MATCH ? AND kind = 'knowledge' ORDER BY bm25(search_index, 0, 0, 0, 4.0, 1.0) LIMIT 12`,
      grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR '));
  } catch { rows = []; }
  const ids = rows.map((r) => r.ref_id).filter((r) => !linked.has(r)).slice(0, 6);
  if (!ids.length) return c.json([]);
  return c.json(all(`SELECT id, title, type, substr(summary, 1, 80) AS summary FROM knowledge_items WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids));
});

// ── 分类与标签 ───────────────────────────────────────────────
knowledgeRoutes.get('/categories', (c) =>
  c.json(all(`SELECT c.*, (SELECT COUNT(*) FROM knowledge_items k WHERE k.category_id = c.id) AS count FROM categories c ORDER BY c.sort, c.created_at`)));

knowledgeRoutes.post('/categories', async (c) => {
  const b = await readJson(c);
  const id = newId('cat');
  const max = get<{ m: number }>('SELECT COALESCE(MAX(sort), 0) AS m FROM categories')!.m;
  insert('categories', { id, name: requireText(b.name, '分类名称', 30), parent_id: b.parent_id || null, sort: max + 1, created_at: now() });
  return c.json(get('SELECT * FROM categories WHERE id = ?', id), 201);
});

knowledgeRoutes.patch('/categories/:id', async (c) => {
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = requireText(b.name, '分类名称', 30);
  if (b.sort !== undefined) patch.sort = Number(b.sort) || 0;
  update('categories', c.req.param('id'), patch, ['name', 'sort']);
  return c.json(get('SELECT * FROM categories WHERE id = ?', c.req.param('id')));
});

knowledgeRoutes.delete('/categories/:id', (c) => {
  run('DELETE FROM categories WHERE id = ?', c.req.param('id'));
  return c.json({ ok: true });
});

knowledgeRoutes.get('/tags', (c) =>
  c.json(all(`SELECT t.name, COUNT(kt.item_id) AS count FROM tags t JOIN knowledge_tags kt ON kt.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name LIMIT 200`)));

// ── 全站搜索 ─────────────────────────────────────────────────
const LINK: Record<IndexKind, (h: { ref_id: string; parent_id: string }) => string> = {
  knowledge: (h) => `/knowledge/${h.ref_id}`,
  document: (h) => `/knowledge?doc=${h.ref_id}`,
  chunk: (h) => `/knowledge?doc=${h.parent_id}`,
  message: (h) => `/assistant/${h.parent_id}`,
  research: (h) => `/research/${h.ref_id}`,
  source: (h) => `/research/${h.parent_id}`,
  topic: (h) => `/studio/${h.ref_id}`,
  plan: (h) => `/learning/plans/${h.ref_id}`,
};

knowledgeRoutes.get('/search', (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ query: '', results: [] });
  const seen = new Set<string>();
  const results = [];
  for (const h of search(q, { limit: 80 })) {
    let kind: string = h.kind;
    let url = LINK[h.kind](h);
    let title = h.title;
    if (h.kind === 'chunk' || h.kind === 'document') {
      const docId = h.kind === 'chunk' ? h.parent_id : h.ref_id;
      const item = get<{ id: string; title: string }>('SELECT id, title FROM knowledge_items WHERE document_id = ?', docId);
      kind = 'document';
      if (item) { url = `/knowledge/${item.id}`; title = item.title; }
      else url = `/knowledge?doc=${docId}`;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ kind, title, snippet: h.snippet, url });
    if (results.length >= 40) break;
  }
  return c.json({ query: q, results });
});
