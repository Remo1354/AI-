import { Hono } from 'hono';
import { all, get, insert, newId, now, run, tx, update } from '../db';
import { badRequest, HttpError, notFound, parseJson, readJson, requireText, today } from '../lib/http';
import { getDocument } from '../lib/documents';
import { htmlToText, tidy } from '../lib/extract';
import { createKnowledge } from '../lib/knowledge';
import { indexDoc, removeByParent, removeDoc } from '../lib/search';
import { FACTCHECK_SYSTEM, REPORT_PROMPT, RESEARCH_RULES, RESEARCH_TASKS } from '../ai/prompts';
import { complete, completeJson } from '../ai/service';

export const researchRoutes = new Hono();

interface SourceRow {
  id: string; project_id: string; seq: number; title: string; url: string; author: string; published_at: string;
  kind: string; content: string; note: string; document_id: string | null; accessed_at: string | null; created_at: string;
}
interface FindingRow {
  id: string; project_id: string; kind: string; title: string; content: string; event_date: string; holder: string;
  verdict: string; evidence: string; ai_generated: number; created_at: string; updated_at: string;
}
interface ProjectRow { id: string; title: string; question: string; status: string; notes: string; domain_id: string | null }

const STATUSES = ['collecting', 'analyzing', 'writing', 'done'];
const KINDS = ['claim', 'viewpoint', 'event', 'note'];
const VERDICTS = ['unverified', 'supported', 'disputed', 'refuted'];
const SOURCE_BUDGET = 110_000;

// ── 引用可追溯性：两个纯函数，测试直接覆盖 ─────────────────────

/** 比较前做归一化：去掉所有空白、统一大小写和常见全/半角标点。 */
export function normalizeForQuote(s: string): string {
  return s.toLowerCase()
    .replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'")
    .replace(/，/g, ',').replace(/：/g, ':').replace(/；/g, ';').replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[\s　]+/g, '');
}

/** 引文是否逐字出现在来源原文中。 */
export function quoteAppearsIn(quote: string, sourceText: string): boolean {
  const q = normalizeForQuote(quote).replace(/^[…."']+|[…."']+$/g, '');
  return q.length >= 6 && normalizeForQuote(sourceText).includes(q);
}

/** 找出文本里所有 [S1]、[S1, S2]、【S3】 形式的引用编号，并与真实存在的来源编号比对。 */
export function checkCitations(text: string, validSeqs: number[]) {
  const cited = new Set<number>();
  for (const m of text.matchAll(/[[【]\s*S\s*\d+(?:\s*[,，、;；]\s*S?\s*\d+)*\s*[\]】]/gi)) {
    for (const n of m[0].matchAll(/\d+/g)) cited.add(Number(n[0]));
  }
  const valid = new Set(validSeqs);
  const all_ = [...cited].sort((a, b) => a - b);
  return {
    cited: all_.filter((n) => valid.has(n)),
    invalid: all_.filter((n) => !valid.has(n)),       // 指向不存在的来源 —— 需要人工处理
    unused: validSeqs.filter((n) => !cited.has(n)),   // 已收集但没被用到的来源
  };
}

function sourcesBlock(sources: SourceRow[]) {
  const withText = sources.filter((s) => (s.content || s.note).trim());
  const per = Math.max(2500, Math.floor(SOURCE_BUDGET / Math.max(withText.length, 1)));
  const truncated: number[] = [];
  const text = withText.map((s) => {
    const body = s.content.trim() || `（没有原文快照，仅有笔记）${s.note}`;
    const cut = body.length > per;
    if (cut) truncated.push(s.seq);
    return [
      `<来源 编号="S${s.seq}" 标题="${s.title}"${s.author ? ` 作者="${s.author}"` : ''}${s.published_at ? ` 时间="${s.published_at}"` : ''}${s.url ? ` 链接="${s.url}"` : ''}${cut ? ' 节选="是"' : ''}>`,
      cut ? body.slice(0, per) : body,
      '</来源>',
    ].join('\n');
  }).join('\n\n');
  return { text, used: withText.map((s) => s.seq), truncated };
}

/** 自动生成的来源列表：直接来自数据库，不经过模型，保证可追溯。 */
function referenceList(sources: SourceRow[], seqs: number[]) {
  const picked = sources.filter((s) => seqs.includes(s.seq));
  if (!picked.length) return '';
  return picked.map((s) => {
    const meta = [s.author, s.published_at].filter(Boolean).join('，');
    const where = s.url ? `<${s.url}>` : s.document_id ? '（上传的资料）' : '（手动录入）';
    const accessed = s.accessed_at ? `，收录于 ${s.accessed_at.slice(0, 10)}` : '';
    return `- **[S${s.seq}]** ${s.title}${meta ? `（${meta}）` : ''} ${where}${accessed}`;
  }).join('\n');
}

const presentSource = (s: SourceRow, full = false) => ({
  ...s, content: full ? s.content : undefined, chars: s.content.length, excerpt: s.content.slice(0, 280),
});
const presentFinding = (f: FindingRow) => ({ ...f, ai_generated: !!f.ai_generated, evidence: parseJson<unknown[]>(f.evidence, []) });

function loadProject(id: string) {
  const project = get<ProjectRow>('SELECT * FROM research_projects WHERE id = ?', id);
  if (!project) throw notFound('研究项目');
  const sources = all<SourceRow>('SELECT * FROM research_sources WHERE project_id = ? ORDER BY seq', id);
  return { project, sources };
}

function projectDetail(id: string) {
  const { project, sources } = loadProject(id);
  const findings = all<FindingRow>(`SELECT * FROM research_findings WHERE project_id = ? ORDER BY (event_date = ''), event_date, created_at`, id);
  const reports = all<Record<string, any>>('SELECT * FROM research_reports WHERE project_id = ? ORDER BY created_at DESC', id);
  return {
    ...project,
    sources: sources.map((s) => presentSource(s)),
    findings: findings.map(presentFinding),
    reports: reports.map((r) => ({ ...r, citation_check: parseJson(r.citation_check, {}) })),
  };
}

const touch = (id: string) => run('UPDATE research_projects SET updated_at = ? WHERE id = ?', now(), id);

// ── 项目 ─────────────────────────────────────────────────────
researchRoutes.get('/research', (c) =>
  c.json(all(
    `SELECT p.*,
        (SELECT COUNT(*) FROM research_sources s WHERE s.project_id = p.id) AS source_count,
        (SELECT COUNT(*) FROM research_findings f WHERE f.project_id = p.id) AS finding_count,
        (SELECT COUNT(*) FROM research_reports r WHERE r.project_id = p.id) AS report_count
       FROM research_projects p ORDER BY (p.status = 'done'), p.updated_at DESC`)));

researchRoutes.post('/research', async (c) => {
  const b = await readJson(c);
  const id = newId('rs');
  const title = requireText(b.title, '研究主题', 120);
  insert('research_projects', {
    id, title, question: String(b.question || ''), notes: '', domain_id: b.domain_id || null, created_at: now(), updated_at: now(),
  });
  indexDoc('research', id, title, String(b.question || ''));
  return c.json(projectDetail(id), 201);
});

researchRoutes.get('/research/:id', (c) => c.json(projectDetail(c.req.param('id'))));

researchRoutes.patch('/research/:id', async (c) => {
  const id = c.req.param('id');
  loadProject(id);
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '研究主题', 120);
  for (const f of ['question', 'notes']) if (b[f] !== undefined) patch[f] = String(b[f] ?? '');
  if (b.status !== undefined && STATUSES.includes(b.status)) patch.status = b.status;
  if (b.domain_id !== undefined) patch.domain_id = b.domain_id || null;
  update('research_projects', id, patch, ['title', 'question', 'notes', 'status', 'domain_id'], { updated_at: now() });
  const p = loadProject(id).project;
  indexDoc('research', id, p.title, `${p.question}\n${p.notes}`);
  return c.json(projectDetail(id));
});

researchRoutes.delete('/research/:id', (c) => {
  const id = c.req.param('id');
  tx(() => {
    removeByParent('source', id);
    removeDoc('research', id);
    run('DELETE FROM research_projects WHERE id = ?', id);
  });
  return c.json({ ok: true });
});

// ── 来源 ─────────────────────────────────────────────────────
function addSource(projectId: string, s: Partial<SourceRow>) {
  const id = newId('src');
  const seq = get<{ m: number }>('SELECT COALESCE(MAX(seq), 0) AS m FROM research_sources WHERE project_id = ?', projectId)!.m + 1;
  const row = {
    id, project_id: projectId, seq, title: (s.title || '未命名来源').slice(0, 200), url: s.url || '', author: s.author || '',
    published_at: s.published_at || '', kind: s.kind || 'web', content: s.content || '', note: s.note || '',
    document_id: s.document_id || null, accessed_at: now(), created_at: now(),
  };
  insert('research_sources', row);
  indexDoc('source', id, row.title, `${row.note}\n${row.content.slice(0, 50_000)}`, projectId);
  touch(projectId);
  return id;
}

researchRoutes.post('/research/:id/sources', async (c) => {
  const id = c.req.param('id');
  loadProject(id);
  const b = await readJson(c);
  let content = String(b.content || '');
  let title = String(b.title || '').trim();
  let kind = String(b.kind || 'web');
  if (b.document_id) {
    const doc = getDocument(String(b.document_id));
    if (!doc) throw notFound('资料');
    content = content || doc.text;
    title = title || doc.title;
    kind = 'document';
  }
  if (!title) throw badRequest('请填写来源标题');
  const url = String(b.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw badRequest('链接需要以 http:// 或 https:// 开头');
  addSource(id, {
    title, url, author: String(b.author || ''), published_at: String(b.published_at || ''), kind,
    content: tidy(content), note: String(b.note || ''), document_id: b.document_id || null,
  });
  return c.json(projectDetail(id), 201);
});

/** 抓取网页并保存正文快照作为来源。原文保存在本地，之后的引用校验都以这份快照为准。 */
researchRoutes.post('/research/:id/sources/fetch', async (c) => {
  const id = c.req.param('id');
  loadProject(id);
  const b = await readJson(c);
  const url = String(b.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw badRequest('请填写以 http:// 或 https:// 开头的链接');
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; LearningPlatform/1.0)', accept: 'text/html,text/plain,*/*' },
    });
  } catch (err) {
    throw new HttpError(502, 'fetch_failed', `无法访问这个链接（${(err as Error).message}）。可以改为手动粘贴正文。`);
  }
  if (!res.ok) throw new HttpError(502, 'fetch_failed', `链接返回了 ${res.status}，没有抓到内容。可以改为手动粘贴正文。`);
  const type = res.headers.get('content-type') || '';
  if (!/text\/|json|xml/i.test(type)) throw badRequest(`这个链接不是网页或文本（${type || '未知类型'}）。如果是 PDF，请下载后作为资料上传。`);
  const raw = (await res.text()).slice(0, 3_000_000);
  const parsed = /html/i.test(type) || /<html/i.test(raw.slice(0, 2000)) ? htmlToText(raw) : { title: '', text: tidy(raw) };
  if (parsed.text.length < 80) throw badRequest('没有从这个页面提取到正文（可能需要登录或由脚本渲染）。可以改为手动粘贴正文。');
  addSource(id, { title: String(b.title || parsed.title || url).slice(0, 200), url, kind: 'web', content: parsed.text.slice(0, 400_000) });
  return c.json(projectDetail(id), 201);
});

researchRoutes.get('/research/sources/:sid', (c) => {
  const s = get<SourceRow>('SELECT * FROM research_sources WHERE id = ?', c.req.param('sid'));
  if (!s) throw notFound('来源');
  return c.json(presentSource(s, true));
});

researchRoutes.patch('/research/sources/:sid', async (c) => {
  const s = get<SourceRow>('SELECT * FROM research_sources WHERE id = ?', c.req.param('sid'));
  if (!s) throw notFound('来源');
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '来源标题', 200);
  for (const f of ['url', 'author', 'published_at', 'kind', 'note']) if (b[f] !== undefined) patch[f] = String(b[f] ?? '');
  if (b.content !== undefined) patch.content = tidy(String(b.content ?? ''));
  update('research_sources', s.id, patch, ['title', 'url', 'author', 'published_at', 'kind', 'note', 'content']);
  const next = get<SourceRow>('SELECT * FROM research_sources WHERE id = ?', s.id)!;
  indexDoc('source', s.id, next.title, `${next.note}\n${next.content.slice(0, 50_000)}`, s.project_id);
  touch(s.project_id);
  return c.json(projectDetail(s.project_id));
});

researchRoutes.delete('/research/sources/:sid', (c) => {
  const s = get<SourceRow>('SELECT * FROM research_sources WHERE id = ?', c.req.param('sid'));
  if (!s) throw notFound('来源');
  tx(() => {
    removeDoc('source', s.id);
    run('DELETE FROM research_sources WHERE id = ?', s.id);
  });
  return c.json(projectDetail(s.project_id));
});

// ── 研究发现：陈述 / 观点 / 时间线事件 / 笔记 ───────────────────
function verifyEvidence(input: unknown, sources: SourceRow[]) {
  const bySeq = new Map(sources.map((s) => [s.seq, s]));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const out: { source_id: string; seq: number; quote: string; verified: boolean }[] = [];
  for (const e of Array.isArray(input) ? input : []) {
    const src = byId.get(String(e?.source_id)) ?? bySeq.get(Number(e?.seq ?? e?.source));
    if (!src) continue; // 指向不存在的来源：直接丢弃，不保留无法追溯的证据
    const quote = String(e?.quote || '').trim().slice(0, 600);
    out.push({ source_id: src.id, seq: src.seq, quote, verified: quote ? quoteAppearsIn(quote, `${src.content}\n${src.note}`) : false });
  }
  return out;
}

researchRoutes.post('/research/:id/findings', async (c) => {
  const id = c.req.param('id');
  const { sources } = loadProject(id);
  const b = await readJson(c);
  const fid = newId('fd');
  insert('research_findings', {
    id: fid, project_id: id, kind: KINDS.includes(b.kind) ? b.kind : 'note', title: requireText(b.title, '标题', 300),
    content: String(b.content || ''), event_date: String(b.event_date || '').slice(0, 20), holder: String(b.holder || '').slice(0, 80),
    verdict: VERDICTS.includes(b.verdict) ? b.verdict : 'unverified', evidence: JSON.stringify(verifyEvidence(b.evidence, sources)),
    ai_generated: b.ai_generated ? 1 : 0, created_at: now(), updated_at: now(),
  });
  touch(id);
  return c.json(projectDetail(id), 201);
});

researchRoutes.patch('/research/findings/:fid', async (c) => {
  const f = get<FindingRow>('SELECT * FROM research_findings WHERE id = ?', c.req.param('fid'));
  if (!f) throw notFound('研究发现');
  const { sources } = loadProject(f.project_id);
  const b = await readJson(c);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '标题', 300);
  for (const k of ['content', 'event_date', 'holder']) if (b[k] !== undefined) patch[k] = String(b[k] ?? '');
  if (b.kind !== undefined && KINDS.includes(b.kind)) patch.kind = b.kind;
  if (b.verdict !== undefined && VERDICTS.includes(b.verdict)) patch.verdict = b.verdict;
  if (b.evidence !== undefined) patch.evidence = JSON.stringify(verifyEvidence(b.evidence, sources));
  update('research_findings', f.id, patch, ['title', 'content', 'event_date', 'holder', 'kind', 'verdict', 'evidence'], { updated_at: now() });
  touch(f.project_id);
  return c.json(projectDetail(f.project_id));
});

researchRoutes.delete('/research/findings/:fid', (c) => {
  const f = get<FindingRow>('SELECT * FROM research_findings WHERE id = ?', c.req.param('fid'));
  if (!f) throw notFound('研究发现');
  run('DELETE FROM research_findings WHERE id = ?', f.id);
  return c.json(projectDetail(f.project_id));
});

/**
 * 事实核查：模型只能依据已收集的来源判断，并给出逐字引文；
 * 服务端逐条校验引文确实出现在来源原文里。没有任何一条引文通过校验时，结论强制为「未核实」。
 */
researchRoutes.post('/research/findings/:fid/factcheck', async (c) => {
  const f = get<FindingRow>('SELECT * FROM research_findings WHERE id = ?', c.req.param('fid'));
  if (!f) throw notFound('研究发现');
  const { sources } = loadProject(f.project_id);
  const block = sourcesBlock(sources);
  if (!block.used.length) throw badRequest('这个项目还没有带正文的来源。请先收集资料，再做事实核查。');
  const { data, modelRef } = await completeJson<{ verdict?: string; reasoning?: string; evidence?: unknown }>({
    system: FACTCHECK_SYSTEM,
    messages: [{ role: 'user', content: `待核查陈述：${f.title}${f.content ? `\n补充说明：${f.content}` : ''}\n\n来源：\n${block.text}` }],
    purpose: 'factcheck', refId: f.project_id, maxTokens: 8000,
  });
  const evidence = verifyEvidence(data.evidence, sources);
  const verifiedCount = evidence.filter((e) => e.verified).length;
  let verdict = VERDICTS.includes(String(data.verdict)) ? String(data.verdict) : 'unverified';
  const downgraded = verdict !== 'unverified' && verifiedCount === 0;
  if (downgraded) verdict = 'unverified';
  run('UPDATE research_findings SET verdict = ?, evidence = ?, updated_at = ? WHERE id = ?', verdict, JSON.stringify(evidence), now(), f.id);
  touch(f.project_id);
  return c.json({
    project: projectDetail(f.project_id),
    result: {
      finding_id: f.id, verdict, reasoning: String(data.reasoning || ''), evidence, downgraded,
      truncated_sources: block.truncated, model_ref: modelRef,
    },
  });
});

// ── AI 分析与报告 ────────────────────────────────────────────
function researchSystem(project: ProjectRow, date: string) {
  return `你是严谨的研究助理，正在协助完成一个研究项目。今天是 ${date}。用简体中文和 Markdown 写作。\n\n${RESEARCH_RULES}\n\n研究主题：${project.title}\n研究问题：${project.question || '（未填写，请围绕研究主题）'}`;
}

researchRoutes.get('/research-tasks', (c) => c.json(Object.entries(RESEARCH_TASKS).map(([id, t]) => ({ id, name: t.name }))));

researchRoutes.post('/research/:id/analyze', async (c) => {
  const id = c.req.param('id');
  const { project, sources } = loadProject(id);
  const b = await readJson(c);
  const task = RESEARCH_TASKS[String(b.task)] ?? RESEARCH_TASKS.summary;
  const block = sourcesBlock(sources);
  if (!block.used.length) throw badRequest('这个项目还没有带正文的来源。请先添加来源，AI 只会依据你收集的资料进行分析。');
  const res = await complete({
    system: researchSystem(project, today()),
    messages: [{ role: 'user', content: `${task.prompt}${b.focus ? `\n\n特别关注：${String(b.focus).slice(0, 500)}` : ''}\n\n来源：\n${block.text}` }],
    purpose: 'research', refId: id, maxTokens: 16000,
  });
  return c.json({
    task: task.name, content: res.text.trim(), model_ref: res.modelRef,
    citation_check: checkCitations(res.text, sources.map((s) => s.seq)), truncated_sources: block.truncated,
  });
});

researchRoutes.post('/research/:id/report', async (c) => {
  const id = c.req.param('id');
  const { project, sources } = loadProject(id);
  const block = sourcesBlock(sources);
  if (!block.used.length) throw badRequest('这个项目还没有带正文的来源，无法生成有依据的报告。');
  const findings = all<FindingRow>('SELECT * FROM research_findings WHERE project_id = ? ORDER BY kind, event_date, created_at', id);
  const label: Record<string, string> = { claim: '陈述', viewpoint: '观点', event: '事件', note: '笔记' };
  const verdictLabel: Record<string, string> = { supported: '已有来源支持', disputed: '存在分歧', refuted: '被来源否定', unverified: '未核实' };
  const findingText = findings.length
    ? findings.map((f) => {
        const ev = parseJson<{ seq: number; verified: boolean }[]>(f.evidence, []).filter((e) => e.verified).map((e) => `S${e.seq}`);
        return `- 【${label[f.kind] || f.kind}${f.kind === 'claim' ? `·${verdictLabel[f.verdict]}` : ''}】${f.event_date ? `${f.event_date} ` : ''}${f.holder ? `${f.holder}：` : ''}${f.title}${f.content ? `——${f.content.slice(0, 400)}` : ''}${ev.length ? `（证据：${[...new Set(ev)].join('、')}）` : ''}`;
      }).join('\n')
    : '（暂无）';

  const res = await complete({
    system: researchSystem(project, today()),
    messages: [{
      role: 'user',
      content: `${REPORT_PROMPT}\n\n已整理的研究发现（标为「未核实」的内容只能作为待查问题出现，不能写成结论）：\n${findingText}\n\n来源：\n${block.text}`,
    }],
    purpose: 'report', refId: id, maxTokens: 32000,
  });

  const check = checkCitations(res.text, sources.map((s) => s.seq));
  const refs = referenceList(sources, check.cited);
  const warnings = [
    check.invalid.length && `> ⚠️ 引用校验：正文中出现了不存在的来源编号 ${check.invalid.map((n) => `S${n}`).join('、')}，相关语句没有可追溯的依据，请核对后修改。`,
    !check.cited.length && '> ⚠️ 引用校验：正文没有标注任何来源编号，其中的事实性内容均未经来源支撑。',
    block.truncated.length && `> 说明：来源 ${block.truncated.map((n) => `S${n}`).join('、')} 篇幅较长，生成时只载入了开头部分。`,
  ].filter(Boolean).join('\n\n');
  const content = [res.text.trim(), warnings, refs && `## 来源\n\n${refs}`].filter(Boolean).join('\n\n');
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 120) || `${project.title} 研究报告`;

  const rid = newId('rep');
  insert('research_reports', {
    id: rid, project_id: id, title, content, citation_check: JSON.stringify({ ...check, truncated: block.truncated }),
    model_ref: res.modelRef, created_at: now(),
  });
  touch(id);
  return c.json({ project: projectDetail(id), report_id: rid }, 201);
});

researchRoutes.patch('/research/reports/:rid', async (c) => {
  const r = get<{ id: string; project_id: string }>('SELECT id, project_id FROM research_reports WHERE id = ?', c.req.param('rid'));
  if (!r) throw notFound('研究报告');
  const b = await readJson(c);
  const sources = all<SourceRow>('SELECT * FROM research_sources WHERE project_id = ?', r.project_id);
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) patch.title = requireText(b.title, '报告标题', 120);
  if (b.content !== undefined) {
    patch.content = String(b.content ?? '');
    patch.citation_check = JSON.stringify(checkCitations(String(patch.content), sources.map((s) => s.seq)));
  }
  update('research_reports', r.id, patch, ['title', 'content', 'citation_check']);
  return c.json(projectDetail(r.project_id));
});

researchRoutes.delete('/research/reports/:rid', (c) => {
  const r = get<{ id: string; project_id: string }>('SELECT id, project_id FROM research_reports WHERE id = ?', c.req.param('rid'));
  if (!r) throw notFound('研究报告');
  run('DELETE FROM research_reports WHERE id = ?', r.id);
  return c.json(projectDetail(r.project_id));
});

/** 把研究成果保存进知识库。可以保存一份报告，也可以保存一段分析文本。 */
researchRoutes.post('/research/:id/save-to-knowledge', async (c) => {
  const id = c.req.param('id');
  const { project } = loadProject(id);
  const b = await readJson(c);
  let title = String(b.title || '').trim();
  let content = String(b.content || '').trim();
  if (b.report_id) {
    const r = get<{ id: string; title: string; content: string; knowledge_id: string | null }>('SELECT * FROM research_reports WHERE id = ? AND project_id = ?', b.report_id, id);
    if (!r) throw notFound('研究报告');
    if (r.knowledge_id && get('SELECT id FROM knowledge_items WHERE id = ?', r.knowledge_id)) return c.json({ id: r.knowledge_id, existed: true });
    title = title || r.title;
    content = r.content;
  }
  if (!content) throw badRequest('没有可保存的内容');
  const kid = createKnowledge({
    type: 'research', title: title || `${project.title} 研究笔记`, content, domain_id: project.domain_id,
    source_kind: 'research', source_id: id, tags: ['研究'],
  });
  if (b.report_id) run('UPDATE research_reports SET knowledge_id = ? WHERE id = ?', kid, b.report_id);
  return c.json({ id: kid, existed: false }, 201);
});
