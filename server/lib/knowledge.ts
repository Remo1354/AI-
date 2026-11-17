import { all, get, insert, newId, now, run, tx } from '../db';
import { parseJson } from './http';
import { indexDoc, removeDoc } from './search';

export interface KnowledgeRow {
  id: string; type: string; title: string; content: string; summary: string; key_points: string;
  category_id: string | null; domain_id: string | null; document_id: string | null;
  source_kind: string | null; source_id: string | null; source_url: string | null;
  pinned: number; created_at: string; updated_at: string;
}

export function tagsOf(itemId: string): string[] {
  return all<{ name: string }>(
    'SELECT t.name FROM tags t JOIN knowledge_tags kt ON kt.tag_id = t.id WHERE kt.item_id = ? ORDER BY t.name', itemId,
  ).map((r) => r.name);
}

export function setTags(itemId: string, names: unknown) {
  const clean = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n).trim().replace(/^#/, '')).filter(Boolean))].slice(0, 20);
  run('DELETE FROM knowledge_tags WHERE item_id = ?', itemId);
  for (const name of clean) {
    let tag = get<{ id: string }>('SELECT id FROM tags WHERE name = ?', name);
    if (!tag) {
      tag = { id: newId('tag') };
      insert('tags', { id: tag.id, name });
    }
    run('INSERT OR IGNORE INTO knowledge_tags (item_id, tag_id) VALUES (?, ?)', itemId, tag.id);
  }
  run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM knowledge_tags)');
}

export function reindexKnowledge(id: string) {
  const item = get<KnowledgeRow>('SELECT * FROM knowledge_items WHERE id = ?', id);
  if (!item) return removeDoc('knowledge', id);
  const points = parseJson<string[]>(item.key_points, []).join('\n');
  const tags = tagsOf(id).join(' ');
  indexDoc('knowledge', id, item.title, [item.summary, points, item.content, tags].filter(Boolean).join('\n\n'));
}

export interface NewKnowledge {
  type?: string; title: string; content?: string; summary?: string; key_points?: string[];
  category_id?: string | null; domain_id?: string | null; document_id?: string | null;
  source_kind?: string | null; source_id?: string | null; source_url?: string | null; tags?: string[];
}

export function createKnowledge(input: NewKnowledge): string {
  const id = newId('kn');
  const ts = now();
  tx(() => {
    insert('knowledge_items', {
      id, type: input.type || 'note', title: input.title.slice(0, 200), content: input.content || '',
      summary: input.summary || '', key_points: JSON.stringify(input.key_points || []),
      category_id: input.category_id || null, domain_id: input.domain_id || null,
      document_id: input.document_id || null, source_kind: input.source_kind || 'manual',
      source_id: input.source_id || null, source_url: input.source_url || null,
      created_at: ts, updated_at: ts,
    });
    if (input.tags?.length) setTags(id, input.tags);
    reindexKnowledge(id);
  });
  return id;
}

export function presentKnowledge(row: KnowledgeRow) {
  return { ...row, pinned: !!row.pinned, key_points: parseJson<string[]>(row.key_points, []), tags: tagsOf(row.id) };
}
