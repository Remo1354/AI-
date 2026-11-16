import { all, run } from '../db';

/**
 * 统一全文索引。FTS5 trigram 分词：3 个字符及以上走索引；更短的词（例如两个字的中文词）
 * 回退到 LIKE 扫描，个人数据规模下足够快。
 */
export type IndexKind =
  | 'knowledge' | 'document' | 'chunk' | 'message' | 'research' | 'source' | 'topic' | 'plan';

export const MARK_OPEN = '\u0001';
export const MARK_CLOSE = '\u0002';

export function indexDoc(kind: IndexKind, refId: string, title: string, body: string, parentId = '') {
  run('DELETE FROM search_index WHERE kind = ? AND ref_id = ?', kind, refId);
  run(
    'INSERT INTO search_index (kind, ref_id, parent_id, title, body) VALUES (?, ?, ?, ?, ?)',
    kind, refId, parentId, title || '', body || '',
  );
}

export function removeDoc(kind: IndexKind, refId: string) {
  run('DELETE FROM search_index WHERE kind = ? AND ref_id = ?', kind, refId);
}

export function removeByParent(kind: IndexKind, parentId: string) {
  run('DELETE FROM search_index WHERE kind = ? AND parent_id = ?', kind, parentId);
}

export interface SearchHit {
  kind: IndexKind;
  ref_id: string;
  parent_id: string;
  title: string;
  snippet: string;
}

const len = (s: string) => Array.from(s).length;
const ftsPhrase = (t: string) => `"${t.replace(/"/g, '""')}"`;
const likePattern = (t: string) => `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

function terms(q: string): string[] {
  return q.replace(/["“”]/g, ' ').split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
}

function manualSnippet(body: string, title: string, ts: string[]): string {
  const lower = body.toLowerCase();
  for (const t of ts) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0) {
      const start = Math.max(0, i - 36);
      const end = Math.min(body.length, i + t.length + 60);
      return (
        (start > 0 ? '…' : '') +
        body.slice(start, i) + MARK_OPEN + body.slice(i, i + t.length) + MARK_CLOSE +
        body.slice(i + t.length, end) + (end < body.length ? '…' : '')
      ).replace(/\s+/g, ' ');
    }
  }
  return (body || title).slice(0, 96).replace(/\s+/g, ' ');
}

export function search(q: string, opts: { kinds?: IndexKind[]; limit?: number } = {}): SearchHit[] {
  const ts = terms(q);
  if (!ts.length) return [];
  const limit = Math.min(opts.limit ?? 30, 100);
  const kindFilter = opts.kinds?.length ? ` AND kind IN (${opts.kinds.map(() => '?').join(',')})` : '';
  const kindParams = opts.kinds ?? [];

  if (ts.every((t) => len(t) >= 3)) {
    const match = ts.map(ftsPhrase).join(' AND ');
    try {
      return all<SearchHit>(
        `SELECT kind, ref_id, parent_id, title,
                snippet(search_index, 4, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 48) AS snippet
           FROM search_index
          WHERE search_index MATCH ?${kindFilter}
          ORDER BY bm25(search_index, 0, 0, 0, 6.0, 1.0)
          LIMIT ?`,
        match, ...kindParams, limit,
      );
    } catch {
      // 查询语法异常时回退到 LIKE
    }
  }

  const where = ts.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')").join(' AND ');
  const params = ts.flatMap((t) => [likePattern(t), likePattern(t)]);
  const rows = all<{ kind: IndexKind; ref_id: string; parent_id: string; title: string; body: string }>(
    `SELECT kind, ref_id, parent_id, title, substr(body, 1, 20000) AS body
       FROM search_index WHERE ${where}${kindFilter} LIMIT ?`,
    ...params, ...kindParams, limit,
  );
  return rows.map((r) => ({
    kind: r.kind, ref_id: r.ref_id, parent_id: r.parent_id, title: r.title,
    snippet: manualSnippet(r.body, r.title, ts),
  }));
}

// ── 面向问答的片段检索（关键词版 RAG；向量检索的位置已在数据表中预留）──────
const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'with', 'that', 'this', 'what', 'how', 'why', 'does', 'can', 'you', 'from', 'have', 'has', 'about', 'please']);

export function queryGrams(question: string, max = 48): string[] {
  const grams = new Set<string>();
  for (const w of question.toLowerCase().match(/[a-z0-9][a-z0-9_\-+.#]{2,}/g) ?? []) {
    if (!STOP.has(w)) grams.add(w);
  }
  for (const seg of question.match(/[㐀-鿿぀-ヿ]+/g) ?? []) {
    const chars = Array.from(seg);
    for (let i = 0; i + 3 <= chars.length; i++) grams.add(chars.slice(i, i + 3).join(''));
  }
  return [...grams].slice(0, max);
}

export interface ChunkHit { id: string; document_id: string; seq: number; content: string }

export function retrieveChunks(question: string, documentIds: string[], k = 10): ChunkHit[] {
  if (!documentIds.length) return [];
  const grams = queryGrams(question);
  const marks = documentIds.map(() => '?').join(',');
  let ids: string[] = [];
  if (grams.length) {
    try {
      ids = all<{ ref_id: string }>(
        `SELECT ref_id FROM search_index
          WHERE search_index MATCH ? AND kind = 'chunk' AND parent_id IN (${marks})
          ORDER BY bm25(search_index) LIMIT ?`,
        grams.map(ftsPhrase).join(' OR '), ...documentIds, k,
      ).map((r) => r.ref_id);
    } catch { ids = []; }
  }
  if (!ids.length) {
    // 没有命中关键词时，退回每份资料的开头部分，至少让模型知道资料在讲什么
    return all<ChunkHit>(
      `SELECT id, document_id, seq, content FROM document_chunks
        WHERE document_id IN (${marks}) AND seq < ? ORDER BY document_id, seq`,
      ...documentIds, Math.max(2, Math.floor(k / documentIds.length)),
    );
  }
  const rows = all<ChunkHit>(
    `SELECT id, document_id, seq, content FROM document_chunks WHERE id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  return rows.sort((a, b) => a.document_id.localeCompare(b.document_id) || a.seq - b.seq);
}
