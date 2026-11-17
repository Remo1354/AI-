import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { all, get, insert, newId, now, run, tx, update } from '../db';
import { config } from '../config';
import { badRequest, notFound, readJson, requireText, today, parseJson } from '../lib/http';
import { DOC_PUBLIC_COLUMNS, touchDocuments } from '../lib/documents';
import { createKnowledge } from '../lib/knowledge';
import { indexDoc, removeByParent, retrieveChunks } from '../lib/search';
import { chatSystemPrompt, getMode } from '../ai/prompts';
import { resolveModel } from '../ai/registry';
import { streamChat } from '../ai/service';
import { AiError, type ChatMessage } from '../ai/types';

export const chatRoutes = new Hono();

interface ConversationRow {
  id: string; title: string; mode: string; model_ref: string | null; domain_id: string | null;
  pinned: number; created_at: string; updated_at: string;
}
interface MessageRow {
  id: string; conversation_id: string; role: 'user' | 'assistant'; content: string; model_ref: string | null;
  context_note: string | null; error: string | null; input_tokens: number | null; output_tokens: number | null; created_at: string;
}

const presentMessage = (m: MessageRow) => ({ ...m, context_note: parseJson(m.context_note, null) });

function conversationDocs(id: string) {
  return all<{ id: string; title: string; chars: number; status: string; text?: string }>(
    `SELECT ${DOC_PUBLIC_COLUMNS.split(', ').map((c) => `d.${c}`).join(', ')}
       FROM documents d JOIN conversation_documents cd ON cd.document_id = d.id
      WHERE cd.conversation_id = ? ORDER BY cd.created_at`, id);
}

chatRoutes.get('/conversations', (c) => {
  const rows = all(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT COUNT(*) FROM conversation_documents cd WHERE cd.conversation_id = c.id) AS document_count
       FROM conversations c ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 300`);
  return c.json(rows);
});

chatRoutes.post('/conversations', async (c) => {
  const b = await readJson(c);
  const id = newId('conv');
  const ts = now();
  tx(() => {
    insert('conversations', {
      id, title: String(b.title || '新对话').slice(0, 80), mode: getMode(b.mode).id,
      model_ref: b.model_ref || null, domain_id: b.domain_id || null, created_at: ts, updated_at: ts,
    });
    for (const docId of Array.isArray(b.document_ids) ? b.document_ids : []) {
      run('INSERT OR IGNORE INTO conversation_documents (conversation_id, document_id, created_at) SELECT ?, id, ? FROM documents WHERE id = ?', id, ts, docId);
    }
  });
  return c.json(get('SELECT * FROM conversations WHERE id = ?', id), 201);
});

chatRoutes.get('/conversations/:id', (c) => {
  const conv = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', c.req.param('id'));
  if (!conv) throw notFound('对话');
  const messages = all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', conv.id);
  return c.json({ ...conv, messages: messages.map(presentMessage), documents: conversationDocs(conv.id) });
});

chatRoutes.patch('/conversations/:id', async (c) => {
  const id = c.req.param('id');
  if (!get('SELECT id FROM conversations WHERE id = ?', id)) throw notFound('对话');
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '标题', 80);
  if (b.mode !== undefined) patch.mode = getMode(b.mode).id;
  if (b.model_ref !== undefined) patch.model_ref = b.model_ref || null;
  if (b.pinned !== undefined) patch.pinned = b.pinned ? 1 : 0;
  update('conversations', id, patch, ['title', 'mode', 'model_ref', 'pinned']);
  return c.json(get('SELECT * FROM conversations WHERE id = ?', id));
});

chatRoutes.delete('/conversations/:id', (c) => {
  const id = c.req.param('id');
  tx(() => {
    removeByParent('message', id);
    run('DELETE FROM conversations WHERE id = ?', id);
  });
  return c.json({ ok: true });
});

chatRoutes.post('/conversations/:id/documents', async (c) => {
  const id = c.req.param('id');
  if (!get('SELECT id FROM conversations WHERE id = ?', id)) throw notFound('对话');
  const { document_id } = await readJson(c);
  if (!get('SELECT id FROM documents WHERE id = ?', document_id)) throw notFound('资料');
  run('INSERT OR IGNORE INTO conversation_documents (conversation_id, document_id, created_at) VALUES (?, ?, ?)', id, document_id, now());
  touchDocuments([document_id]);
  return c.json({ documents: conversationDocs(id) });
});

chatRoutes.delete('/conversations/:id/documents/:docId', (c) => {
  run('DELETE FROM conversation_documents WHERE conversation_id = ? AND document_id = ?', c.req.param('id'), c.req.param('docId'));
  return c.json({ documents: conversationDocs(c.req.param('id')) });
});

/** 把附加资料变成给模型的上下文：放得下就全文，放不下就检索与问题相关的片段，并如实告知。 */
function buildContext(conversationId: string, question: string) {
  const docs = all<{ id: string; title: string; filename: string; text: string; chars: number; status: string }>(
    `SELECT d.id, d.title, d.filename, d.text, d.chars, d.status
       FROM documents d JOIN conversation_documents cd ON cd.document_id = d.id
      WHERE cd.conversation_id = ? ORDER BY cd.created_at`, conversationId);
  const usable = docs.filter((d) => d.status === 'ready' && d.chars > 0);
  if (!usable.length) return { text: '', note: null as null | Record<string, unknown> };
  touchDocuments(usable.map((d) => d.id));

  const total = usable.reduce((n, d) => n + d.chars, 0);
  if (total <= config.ai.contextChars) {
    const body = usable.map((d) => `<资料 标题="${d.title}" 文件="${d.filename}">\n${d.text}\n</资料>`).join('\n\n');
    return {
      text: `用户为这次对话附上了以下学习资料（全文）。回答与资料有关的问题时以资料内容为准。\n\n${body}`,
      note: { mode: 'full', documents: usable.map((d) => ({ id: d.id, title: d.title })), chars: total },
    };
  }
  const perChunk = 1100;
  const k = Math.max(6, Math.min(40, Math.floor(config.ai.contextChars / perChunk)));
  const chunks = retrieveChunks(question, usable.map((d) => d.id), k);
  const titleOf = new Map(usable.map((d) => [d.id, d.title]));
  const body = chunks.map((ch) => `<片段 资料="${titleOf.get(ch.document_id)}" 序号="${ch.seq + 1}">\n${ch.content}\n</片段>`).join('\n\n');
  return {
    text:
      `用户为这次对话附上了学习资料：${usable.map((d) => `《${d.title}》`).join('、')}。资料较长（共约 ${total} 字），` +
      `下面只载入了与当前问题最相关的 ${chunks.length} 个片段，不是全文。如果这些片段不足以回答，请直接说明，并建议用户换一种问法或指出具体章节。\n\n${body}`,
    note: { mode: 'retrieval', documents: usable.map((d) => ({ id: d.id, title: d.title })), chars: total, chunks: chunks.length },
  };
}

/** 整理历史：跳过空回复，合并连续同角色消息，保证 user/assistant 交替且以 user 开头。 */
function buildHistory(conversationId: string, budget = 120_000): ChatMessage[] {
  const rows = all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', conversationId);
  const out: ChatMessage[] = [];
  for (const m of rows) {
    if (!m.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  let used = 0;
  let start = out.length;
  for (let i = out.length - 1; i >= 0; i--) {
    used += out[i].content.length;
    if (used > budget && i < out.length - 1) break;
    start = i;
  }
  let trimmed = out.slice(start);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed = trimmed.slice(1);
  return trimmed;
}

/** 发送消息并以 SSE 流式返回：meta → (thinking) → delta… → done | error */
chatRoutes.post('/conversations/:id/messages', async (c) => {
  const conv = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', c.req.param('id'));
  if (!conv) throw notFound('对话');
  const b = await readJson(c);
  // regenerate：不新增提问，丢弃上一次的回答（包括失败或被中止的），对同一个问题重新作答
  const regenerate = b.regenerate === true;
  const lastUser = regenerate
    ? get<MessageRow>("SELECT * FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1", conv.id)
    : undefined;
  if (regenerate && !lastUser) throw badRequest('这个对话里还没有可以重新回答的问题');
  const content = lastUser ? lastUser.content : requireText(b.content, '消息内容', 200_000);
  const modelRef = (b.model_ref as string | undefined) || conv.model_ref;
  const resolved = resolveModel(modelRef); // 未配置模型时在这里抛出 409，不会写入或删除任何消息

  const ts = now();
  const userId = lastUser?.id ?? newId('msg');
  const isFirst = !get('SELECT id FROM messages WHERE conversation_id = ? LIMIT 1', conv.id);
  const context = buildContext(conv.id, content);
  tx(() => {
    const patch: Record<string, unknown> = { updated_at: ts, model_ref: resolved.ref };
    if (lastUser) {
      const stale = all<{ id: string }>(
        "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' AND rowid > (SELECT rowid FROM messages WHERE id = ?)",
        conv.id, lastUser.id);
      for (const m of stale) {
        run("DELETE FROM search_index WHERE kind = 'message' AND ref_id = ?", m.id);
        run('DELETE FROM messages WHERE id = ?', m.id);
      }
    } else {
      insert('messages', { id: userId, conversation_id: conv.id, role: 'user', content, created_at: ts });
      if (isFirst && conv.title === '新对话') patch.title = content.replace(/\s+/g, ' ').slice(0, 28);
      indexDoc('message', userId, String(patch.title || conv.title), content, conv.id);
    }
    update('conversations', conv.id, patch, ['updated_at', 'model_ref', 'title']);
  });

  const history = buildHistory(conv.id);
  const system = chatSystemPrompt(conv.mode, { date: typeof b.date === 'string' ? b.date : today(), context: context.text });
  const assistantId = newId('msg');
  const ac = new AbortController();

  return streamSSE(c, async (stream) => {
    stream.onAbort(() => ac.abort());
    let text = '';
    let error: AiError | null = null;
    let end: { inputTokens?: number; outputTokens?: number; stopReason?: string } = {};
    await stream.writeSSE({
      event: 'meta',
      data: JSON.stringify({ user_message_id: userId, assistant_message_id: assistantId, model_ref: resolved.ref, context: context.note }),
    });
    try {
      for await (const ev of streamChat({
        resolved, system, messages: history, purpose: 'chat', refId: conv.id, signal: ac.signal,
      })) {
        if (ev.type === 'text') {
          text += ev.text;
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: ev.text }) });
        } else if (ev.type === 'thinking') {
          await stream.writeSSE({ event: 'thinking', data: '{}' });
        } else if (ev.type === 'end') {
          end = ev;
        }
      }
      if (end.stopReason === 'refusal') {
        text += `${text ? '\n\n' : ''}> 模型出于安全策略没有继续回答这个问题。可以换一种问法，或在上方切换其他模型再试。`;
      } else if (end.stopReason === 'max_tokens') {
        text += '\n\n> 回复达到长度上限被截断。可以发送「继续」让它接着写。';
      }
    } catch (err) {
      error = err instanceof AiError ? err : new AiError('provider', (err as Error).message || '调用模型失败');
    }

    const aborted = ac.signal.aborted || error?.code === 'aborted';
    const saved = {
      id: assistantId, conversation_id: conv.id, role: 'assistant' as const, content: text,
      model_ref: resolved.ref, context_note: context.note ? JSON.stringify(context.note) : null,
      error: error && !aborted ? error.message : aborted && !text ? '已停止生成' : null,
      input_tokens: end.inputTokens ?? null, output_tokens: end.outputTokens ?? null, created_at: now(),
    };
    tx(() => {
      insert('messages', saved);
      run('UPDATE conversations SET updated_at = ? WHERE id = ?', saved.created_at, conv.id);
      if (text) indexDoc('message', assistantId, conv.title, text, conv.id);
    });
    if (aborted) return;
    if (error) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: error.code, message: error.message, message_record: presentMessage(saved) }) });
    } else {
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ message: presentMessage(saved) }) });
    }
  });
});

chatRoutes.delete('/messages/:id', (c) => {
  const id = c.req.param('id');
  tx(() => {
    run("DELETE FROM search_index WHERE kind = 'message' AND ref_id = ?", id);
    run('DELETE FROM messages WHERE id = ?', id);
  });
  return c.json({ ok: true });
});

/** 把对话中的一条消息（或其中选中的一段）保存进知识库，并保留来源指向。 */
chatRoutes.post('/messages/:id/save', async (c) => {
  const msg = get<MessageRow>('SELECT * FROM messages WHERE id = ?', c.req.param('id'));
  if (!msg) throw notFound('消息');
  const b = await readJson(c);
  const conv = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', msg.conversation_id);
  const content = typeof b.content === 'string' && b.content.trim() ? b.content.trim() : msg.content;
  if (!content) throw badRequest('这条消息没有可保存的内容');
  const id = createKnowledge({
    type: 'excerpt',
    title: String(b.title || conv?.title || '对话摘录').slice(0, 200),
    content, category_id: b.category_id, domain_id: b.domain_id ?? conv?.domain_id,
    tags: b.tags, source_kind: 'conversation', source_id: msg.conversation_id,
  });
  return c.json({ id }, 201);
});
