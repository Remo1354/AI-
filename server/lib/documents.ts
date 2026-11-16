import fs from 'node:fs';
import path from 'node:path';
import { all, get, insert, newId, now, run, tx } from '../db';
import { config, ensureDataDirs } from '../config';
import { sha256 } from './crypto';
import { chunkText, extractText, isSupported } from './extract';
import { badRequest, HttpError } from './http';
import { indexDoc, removeByParent, removeDoc } from './search';

export interface DocumentRow {
  id: string; title: string; filename: string; ext: string; mime: string; size: number; sha256: string;
  stored_as: string; kind: 'document' | 'image'; status: 'ready' | 'no_text' | 'error'; error: string | null;
  pages: number | null; text: string; chars: number; created_at: string; last_used_at: string | null;
}

export const DOC_PUBLIC_COLUMNS =
  'id, title, filename, ext, mime, size, kind, status, error, pages, chars, created_at, last_used_at';

export function getDocument(id: string): DocumentRow | undefined {
  return get<DocumentRow>('SELECT * FROM documents WHERE id = ?', id);
}

export function documentPath(doc: Pick<DocumentRow, 'stored_as'>) {
  return path.join(config.uploadDir, doc.stored_as);
}

function indexDocument(doc: Pick<DocumentRow, 'id' | 'title' | 'text'>) {
  removeByParent('chunk', doc.id);
  run('DELETE FROM document_chunks WHERE document_id = ?', doc.id);
  indexDoc('document', doc.id, doc.title, doc.text.slice(0, 400));
  chunkText(doc.text).forEach((content, seq) => {
    const id = newId('ck');
    insert('document_chunks', { id, document_id: doc.id, seq, content });
    indexDoc('chunk', id, doc.title, content, doc.id);
  });
}

/** 保存一个上传文件：落盘 → 提取文字 → 切片 → 建索引。同内容文件按 sha256 去重。 */
export async function saveUpload(file: File, opts: { title?: string } = {}): Promise<{ doc: DocumentRow; duplicate: boolean }> {
  if (!file || typeof file.arrayBuffer !== 'function') throw badRequest('没有收到文件');
  if (file.size === 0) throw badRequest('文件是空的');
  if (file.size > config.maxUploadBytes) {
    throw new HttpError(413, 'too_large', `文件超过 ${Math.round(config.maxUploadBytes / 1048576)} MB 上限`);
  }
  const filename = path.basename(file.name || 'untitled').replace(/[\u0000-\u001f]/g, '');
  const ext = path.extname(filename).toLowerCase();
  if (!isSupported(ext)) {
    throw badRequest(`暂不支持 ${ext || '无扩展名'} 文件。支持 PDF、DOCX、TXT、Markdown 等文本文件和常见图片。`);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  const hash = sha256(buf);
  const existing = get<DocumentRow>('SELECT * FROM documents WHERE sha256 = ?', hash);
  if (existing && fs.existsSync(documentPath(existing))) return { doc: existing, duplicate: true };

  const extracted = await extractText(buf, filename);
  const id = newId('doc');
  const storedAs = `${id}${ext}`;
  ensureDataDirs();
  fs.writeFileSync(path.join(config.uploadDir, storedAs), buf);

  const doc: DocumentRow = {
    id, title: (opts.title || filename.replace(/\.[^.]+$/, '')).slice(0, 200), filename, ext,
    mime: file.type || '', size: file.size, sha256: hash, stored_as: storedAs,
    kind: extracted.kind, status: extracted.status, error: extracted.error ?? null,
    pages: extracted.pages ?? null, text: extracted.text, chars: extracted.text.length,
    created_at: now(), last_used_at: null,
  };
  tx(() => {
    insert('documents', doc as unknown as Record<string, unknown>);
    if (doc.kind === 'document' && doc.status === 'ready') indexDocument(doc);
  });
  return { doc, duplicate: false };
}

export function deleteDocument(id: string) {
  const doc = getDocument(id);
  if (!doc) return false;
  tx(() => {
    removeByParent('chunk', id);
    removeDoc('document', id);
    run('DELETE FROM documents WHERE id = ?', id);
  });
  try { fs.unlinkSync(documentPath(doc)); } catch { /* 文件已不存在 */ }
  return true;
}

export function touchDocuments(ids: string[]) {
  if (!ids.length) return;
  run(`UPDATE documents SET last_used_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, now(), ...ids);
}

export function publicDoc(doc: DocumentRow) {
  const { text, sha256: _s, stored_as: _p, ...rest } = doc;
  return { ...rest, preview: text.slice(0, 600) };
}

export function listDocuments(kind?: string, limit = 200) {
  return kind
    ? all(`SELECT ${DOC_PUBLIC_COLUMNS} FROM documents WHERE kind = ? ORDER BY created_at DESC LIMIT ?`, kind, limit)
    : all(`SELECT ${DOC_PUBLIC_COLUMNS} FROM documents ORDER BY created_at DESC LIMIT ?`, limit);
}
