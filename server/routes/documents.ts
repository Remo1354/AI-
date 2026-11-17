import fs from 'node:fs';
import { Hono } from 'hono';
import { all, get, run } from '../db';
import { deleteDocument, documentPath, getDocument, listDocuments, publicDoc, saveUpload, touchDocuments } from '../lib/documents';
import { MIME } from '../lib/extract';
import { badRequest, notFound, parseJson } from '../lib/http';
import { createKnowledge, reindexKnowledge, setTags } from '../lib/knowledge';
import { SUMMARIZE_SYSTEM } from '../ai/prompts';
import { completeJson } from '../ai/service';

export const documentRoutes = new Hono();

documentRoutes.get('/documents', (c) => c.json(listDocuments(c.req.query('kind') || undefined)));

/**
 * 上传资料。表单字段：
 *   file            必填
 *   to_knowledge=1  同时在知识库建立一条「资料」条目
 *   category_id / domain_id / tags（逗号分隔） 可选
 *   conversation_id 同时附加到某个对话
 */
documentRoutes.post('/documents', async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw badRequest('没有收到文件');
  const { doc, duplicate } = await saveUpload(file, { title: typeof form.title === 'string' ? form.title : undefined });

  let knowledgeId: string | null = null;
  if (form.to_knowledge === '1' && doc.kind === 'document') {
    const existing = get<{ id: string }>('SELECT id FROM knowledge_items WHERE document_id = ?', doc.id);
    knowledgeId = existing?.id ?? createKnowledge({
      type: 'document', title: doc.title, document_id: doc.id, source_kind: 'upload',
      category_id: typeof form.category_id === 'string' ? form.category_id : null,
      domain_id: typeof form.domain_id === 'string' ? form.domain_id : null,
      tags: typeof form.tags === 'string' ? form.tags.split(/[,，]/) : [],
    });
  }
  if (typeof form.conversation_id === 'string' && form.conversation_id) {
    run('INSERT OR IGNORE INTO conversation_documents (conversation_id, document_id, created_at) SELECT id, ?, ? FROM conversations WHERE id = ?',
      doc.id, new Date().toISOString(), form.conversation_id);
    touchDocuments([doc.id]);
  }
  return c.json({ document: publicDoc(doc), duplicate, knowledge_id: knowledgeId }, 201);
});

documentRoutes.get('/documents/:id', (c) => {
  const doc = getDocument(c.req.param('id'));
  if (!doc) throw notFound('资料');
  const full = c.req.query('full') === '1';
  const knowledge = all('SELECT id, title FROM knowledge_items WHERE document_id = ?', doc.id);
  return c.json({ ...publicDoc(doc), text: full ? doc.text : undefined, knowledge });
});

/** 原始文件。图片内联显示，其余作为下载。 */
documentRoutes.get('/documents/:id/file', (c) => {
  const doc = getDocument(c.req.param('id'));
  if (!doc) throw notFound('资料');
  const file = documentPath(doc);
  if (!fs.existsSync(file)) throw notFound('原始文件');
  const buf = fs.readFileSync(file);
  const inline = doc.kind === 'image' && doc.ext !== '.svg';
  return new Response(buf, {
    headers: {
      'content-type': MIME[doc.ext] || 'application/octet-stream',
      'content-length': String(buf.length),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
});

documentRoutes.delete('/documents/:id', (c) => {
  if (!deleteDocument(c.req.param('id'))) throw notFound('资料');
  return c.json({ ok: true });
});

/** AI 总结资料：写入（或新建）对应的知识库条目的摘要、知识点和标签。 */
documentRoutes.post('/documents/:id/summarize', async (c) => {
  const doc = getDocument(c.req.param('id'));
  if (!doc) throw notFound('资料');
  if (doc.status !== 'ready' || !doc.text) throw badRequest(doc.error || '这份资料没有可供总结的文字内容');
  const result = await summarizeText(doc.title, doc.text, doc.id);
  let item = get<{ id: string }>('SELECT id FROM knowledge_items WHERE document_id = ?', doc.id);
  if (!item) item = { id: createKnowledge({ type: 'document', title: doc.title, document_id: doc.id, source_kind: 'upload' }) };
  applySummary(item.id, result);
  return c.json({ knowledge_id: item.id, ...result });
});

export interface SummaryResult { summary: string; key_points: string[]; tags: string[]; truncated: boolean }

const SUMMARY_INPUT_LIMIT = 120_000;

export async function summarizeText(title: string, text: string, refId?: string): Promise<SummaryResult> {
  const truncated = text.length > SUMMARY_INPUT_LIMIT;
  const body = truncated ? text.slice(0, SUMMARY_INPUT_LIMIT) : text;
  const { data } = await completeJson<{ summary?: string; key_points?: unknown; tags?: unknown }>({
    system: SUMMARIZE_SYSTEM,
    messages: [{
      role: 'user',
      content: `标题：${title}\n${truncated ? `（内容较长，以下为前 ${SUMMARY_INPUT_LIMIT} 字，请在摘要开头注明只覆盖了前半部分）\n` : ''}\n内容：\n${body}`,
    }],
    purpose: 'summarize', refId, maxTokens: 8000,
  });
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  return { summary: String(data.summary || '').trim(), key_points: arr(data.key_points).slice(0, 10), tags: arr(data.tags).slice(0, 6), truncated };
}

export function applySummary(itemId: string, r: SummaryResult) {
  run('UPDATE knowledge_items SET summary = ?, key_points = ?, updated_at = ? WHERE id = ?',
    r.summary, JSON.stringify(r.key_points), new Date().toISOString(), itemId);
  const current = all<{ name: string }>('SELECT t.name FROM tags t JOIN knowledge_tags kt ON kt.tag_id = t.id WHERE kt.item_id = ?', itemId).map((t) => t.name);
  setTags(itemId, [...current, ...r.tags]);
  reindexKnowledge(itemId);
  return parseJson(JSON.stringify(r), r);
}
