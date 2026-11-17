import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { parseSse, startMockAi, tinyPdf, useTempDataDir, type MockAi } from './helpers';

const dataDir = useTempDataDir();
const { reloadConfig } = await import('../server/config');
reloadConfig();
const { createApp } = await import('../server/app');
const { closeDb } = await import('../server/db');

const app = createApp();
let mock: MockAi;
const state: Record<string, any> = {};

const json = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({
  method, headers: { 'content-type': 'application/json', host: 'localhost', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function api<T = any>(method: string, url: string, body?: unknown, expect = 200): Promise<T> {
  const res = await app.request(`/api${url}`, json(method, body));
  const text = await res.text();
  assert.equal(res.status, expect, `${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : (null as T);
}
function upload(url: string, fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app.request(`/api${url}`, { method: 'POST', body: form, headers: { host: 'localhost' } });
}

before(async () => { mock = await startMockAi(); });
after(async () => { await mock.close(); closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('基础：健康检查、默认学习方向与分类', async () => {
  const health = await api('GET', '/health');
  assert.equal(health.ok, true);
  assert.ok(health.modules.includes('learning') && health.modules.includes('studio'), '模块注册表生效');
  const domains = await api('GET', '/domains');
  assert.equal(domains.length, 6);
  assert.ok(domains.some((d: any) => d.name === '艺术理论与艺术史'));
  assert.ok((await api('GET', '/categories')).length >= 5);
  assert.ok(fs.existsSync(path.join(dataDir, 'remo.sqlite')), '数据库文件应落在 DATA_DIR');
});

test('AI 未配置时：明确报错，且不写入任何消息', async () => {
  assert.equal((await api('GET', '/ai/models')).configured, false);
  const conv = await api('POST', '/conversations', {}, 201);
  const res = await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { content: '你好' }));
  assert.equal(res.status, 409);
  const err = await res.json();
  assert.equal(err.error.code, 'ai_not_configured');
  assert.match(err.error.message, /设置/);
  assert.equal((await api('GET', `/conversations/${conv.id}`)).messages.length, 0);
  await api('DELETE', `/conversations/${conv.id}`);
});

test('模型来源：密钥加密保存、永不下发、可测试连通与获取模型列表', async () => {
  const secret = 'sk-test-SECRET-1234567890';
  const p = await api('POST', '/ai/providers', { name: '测试服务', kind: 'openai', base_url: `${mock.url}/`, api_key: secret, models: 'mock-large, mock-small' }, 201);
  state.providerId = p.id;
  assert.equal(p.has_key, true);
  assert.ok(!JSON.stringify(p).includes(secret), '接口响应不应包含明文密钥');
  assert.equal(p.key_hint, 'sk-t••••7890');
  assert.equal(p.models.length, 2);

  const raw = new DatabaseSync(path.join(dataDir, 'remo.sqlite'), { readOnly: true });
  const row = raw.prepare('SELECT api_key_enc FROM providers WHERE id = ?').get(p.id) as { api_key_enc: string };
  raw.close();
  assert.ok(row.api_key_enc.startsWith('v1:') && !row.api_key_enc.includes(secret), '数据库中应为密文');

  const tested = await api('POST', `/ai/providers/${p.id}/test`, {});
  assert.equal(tested.ok, true);
  assert.equal(mock.requests.at(-1)!.headers.authorization, `Bearer ${secret}`, '服务端调用时使用解密后的密钥');

  assert.deepEqual((await api('POST', '/ai/discover', { id: p.id })).models, ['mock-large', 'mock-small']);
  const models = await api('GET', '/ai/models');
  assert.equal(models.configured, true);
  assert.equal(models.default, `${p.id}::mock-large`);

  // 更新其他字段不会清掉密钥
  await api('PATCH', `/ai/providers/${p.id}`, { name: '测试服务 2' });
  assert.equal((await api('GET', '/ai/providers'))[0].has_key, true);
});

test('对话：流式回复、消息持久化、调用记录', async () => {
  const conv = await api('POST', '/conversations', { mode: 'tutor' }, 201);
  state.convId = conv.id;
  const res = await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { content: '什么是补色？' }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const events = parseSse(await res.text());
  assert.equal(events[0].event, 'meta');
  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.equal(text, '回复：什么是补色？');
  const done = events.find((e) => e.event === 'done')!;
  assert.equal(done.data.message.content, text);
  assert.equal(done.data.message.input_tokens, 42);

  const sent = mock.requests.at(-1)!.body;
  assert.match(sent.messages[0].content, /零基础讲解/, '系统提示词应包含所选教学模式');

  const saved = await api('GET', `/conversations/${conv.id}`);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.title, '什么是补色？', '首条消息自动成为标题');

  // 多轮：历史会带上
  await (await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { content: '举个例子' }))).text();
  const second = mock.requests.at(-1)!.body.messages;
  assert.deepEqual(second.map((m: any) => m.role), ['system', 'user', 'assistant', 'user']);

  const calls = await api('GET', '/ai/calls');
  assert.ok(calls.calls.some((c: any) => c.purpose === 'chat' && c.status === 'ok' && c.output_tokens === 7));

  // 重新生成：不新增提问，只替换最后一条回答
  const before = (await api('GET', `/conversations/${conv.id}`)).messages;
  const regen = parseSse(await (await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { regenerate: true }))).text());
  assert.equal(regen[0].data.user_message_id, before[2].id, '沿用原来的提问');
  assert.ok(regen.find((e) => e.event === 'done'));
  const after = (await api('GET', `/conversations/${conv.id}`)).messages;
  assert.equal(after.length, 4);
  assert.deepEqual(after.slice(0, 3).map((m: any) => m.id), before.slice(0, 3).map((m: any) => m.id));
  assert.notEqual(after[3].id, before[3].id, '旧回答被新回答取代');
  assert.equal(mock.requests.at(-1)!.body.messages.at(-1).content, '举个例子', '模型收到的仍是原问题');
  const empty = await api('POST', '/conversations', {}, 201);
  assert.equal((await app.request(`/api/conversations/${empty.id}/messages`, json('POST', { regenerate: true }))).status, 400);
  await api('DELETE', `/conversations/${empty.id}`);
});

test('Anthropic 适配器：通过官方 SDK 走通流式调用', async () => {
  const p = await api('POST', '/ai/providers', { name: 'Claude（模拟）', kind: 'anthropic', base_url: mock.url, api_key: 'sk-ant-test', models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] }, 201);
  const ref = `${p.id}::claude-opus-5-5`;
  const conv = await api('POST', '/conversations', {}, 201);
  const res = await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { content: '你好', model_ref: ref }));
  const events = parseSse(await res.text());
  const done = events.find((e) => e.event === 'done');
  assert.ok(done, `应正常完成：${JSON.stringify(events.at(-1))}`);
  assert.equal(done!.data.message.content, 'Claude：回复：你好');
  assert.equal(done!.data.message.output_tokens, 11);
  const req = mock.requests.at(-1)!;
  assert.equal(req.path, '/v1/messages');
  assert.equal(req.headers.authorization ?? `Bearer ${req.headers['x-api-key']}`, 'Bearer sk-ant-test', '密钥由服务端 SDK 附加');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.temperature, undefined, '不应发送采样参数');
  assert.equal((await api('GET', `/conversations/${conv.id}`)).model_ref, ref, '对话记住所用模型');

  // 服务商报错时：错误被记录并以 error 事件返回
  mock.failNext = 401;
  const bad = parseSse(await (await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { content: '再来', model_ref: ref }))).text());
  const err = bad.find((e) => e.event === 'error')!;
  assert.equal(err.data.code, 'auth');
  await api('DELETE', `/ai/providers/${p.id}`);
  await api('DELETE', `/conversations/${conv.id}`);
});

test('资料：TXT / GBK / DOCX / PDF 上传与文字提取，去重', async () => {
  const txt = await (await upload('/documents', { file: new File(['印象派画家重视光与色的瞬间变化。莫奈的《日出·印象》是代表作。\n\n补色并置能让画面更明亮。'], '印象派笔记.txt'), to_knowledge: '1', tags: '艺术史,色彩' })).json();
  assert.equal(txt.document.status, 'ready');
  assert.ok(txt.knowledge_id);
  state.docId = txt.document.id;
  state.docKnowledgeId = txt.knowledge_id;

  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xe0, 0xc2, 0xeb, 0xb2, 0xe2, 0xca, 0xd4]); // “中文编码测试” GBK
  const g = await (await upload('/documents', { file: new File([gbk as BlobPart], 'gbk.txt') })).json();
  assert.equal((await api('GET', `/documents/${g.document.id}?full=1`)).text, '中文编码测试');

  const docx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>构图的三分法则</w:t></w:r></w:p></w:body></w:document>'),
  });
  const d = await (await upload('/documents', { file: new File([docx as BlobPart], '构图.docx') })).json();
  assert.equal(d.document.status, 'ready', d.document.error);
  assert.match((await api('GET', `/documents/${d.document.id}?full=1`)).text, /构图的三分法则/);

  const pdf = await (await upload('/documents', { file: new File([tinyPdf('Perspective basics for beginners') as BlobPart], 'perspective.pdf') })).json();
  assert.equal(pdf.document.status, 'ready', pdf.document.error);
  assert.equal(pdf.document.pages, 1);
  assert.match((await api('GET', `/documents/${pdf.document.id}?full=1`)).text, /Perspective basics/);

  const dup = await (await upload('/documents', { file: new File([tinyPdf('Perspective basics for beginners') as BlobPart], 'again.pdf') })).json();
  assert.equal(dup.duplicate, true);
  assert.equal(dup.document.id, pdf.document.id);

  const bad = await upload('/documents', { file: new File(['x'], 'virus.exe') });
  assert.equal(bad.status, 400);

  const file = await app.request(`/api/documents/${state.docId}/file`, { headers: { host: 'localhost' } });
  assert.equal(file.status, 200);
  assert.match(await file.text(), /莫奈/);
});

test('对话附加资料：资料内容进入模型上下文', async () => {
  await api('POST', `/conversations/${state.convId}/documents`, { document_id: state.docId });
  const res = await app.request(`/api/conversations/${state.convId}/messages`, json('POST', { content: '这份资料讲了什么？' }));
  const events = parseSse(await res.text());
  assert.equal(events[0].data.context.mode, 'full');
  assert.match(mock.requests.at(-1)!.body.messages[0].content, /莫奈的《日出·印象》/);
});

test('知识库：创建、标签、中文全文检索、关联、AI 提炼、保存对话、导出', async () => {
  const a = await api('POST', '/knowledge', { title: '色彩构成基础', content: '色相、明度、纯度是色彩的三个属性。互补色位于色相环的两端。', tags: ['色彩', '基础'], category_id: 'cat1', domain_id: 'digital-art' }, 201);
  const b = await api('POST', '/knowledge', { title: '透视入门', content: '一点透视只有一个消失点，常用于表现纵深。', tags: ['透视'] }, 201);
  assert.deepEqual(a.tags, ['基础', '色彩']);

  const find = async (q: string) => (await api('GET', `/knowledge?q=${encodeURIComponent(q)}`)).items.map((i: any) => i.title);
  assert.deepEqual(await find('互补色'), ['色彩构成基础'], '三字及以上走 FTS 索引');
  assert.deepEqual(await find('透视'), ['透视入门'], '两字词走 LIKE 回退');
  assert.deepEqual(await find('莫奈'), ['印象派笔记'], '能搜到上传资料的正文');
  assert.deepEqual(await find('量子力学'), []);
  assert.equal((await api('GET', '/knowledge?tag=' + encodeURIComponent('透视'))).items.length, 1);
  assert.equal((await api('GET', '/knowledge?category_id=cat1')).items.length, 1);

  const linked = await api('POST', `/knowledge/${a.id}/links`, { to_id: b.id, relation: '延伸' });
  assert.equal(linked.links[0].title, '透视入门');
  assert.equal((await api('GET', `/knowledge/${b.id}`)).links[0].direction, 'in', '反向链接可见');

  const summarized = await api('POST', `/knowledge/${a.id}/summarize`, {});
  assert.match(summarized.summary, /色彩理论/);
  assert.equal(summarized.key_points.length, 2);
  assert.ok(summarized.tags.includes('绘画基础'), 'AI 标签与原有标签合并');

  const conv = await api('GET', `/conversations/${state.convId}`);
  const assistant = conv.messages.find((m: any) => m.role === 'assistant');
  const saved = await api('POST', `/messages/${assistant.id}/save`, { title: '关于补色的回答' }, 201);
  const item = await api('GET', `/knowledge/${saved.id}`);
  assert.equal(item.type, 'excerpt');
  assert.equal(item.source_id, state.convId, '保留对话来源');

  const zipRes = await app.request('/api/knowledge/export', { headers: { host: 'localhost' } });
  const files = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
  const names = Object.keys(files);
  assert.ok(names.includes('概念与原理/色彩构成基础.md'), names.join(', '));
  assert.match(new TextDecoder().decode(files['概念与原理/色彩构成基础.md']), /tags: \[/);

  const hits = await api('GET', '/search?q=' + encodeURIComponent('补色'));
  assert.ok(hits.results.some((r: any) => r.url.startsWith('/assistant/')), '全站搜索覆盖对话');
  assert.ok(hits.results.some((r: any) => r.url.startsWith('/knowledge/')));
  state.knowledgeId = a.id;
});

test('学习中心：计划、任务、记录、统计、AI 生成计划与阶段总结', async () => {
  const gen = await api('POST', '/plans/generate', { topic: '色彩基础', domain_id: 'digital-art', weeks: 4, hours_per_week: 5, start_date: '2026-03-02' });
  assert.equal(gen.draft.tasks.length, 3);
  assert.equal(gen.draft.tasks[0].due_date, '2026-03-08', '第 1 周任务落在第一周末');
  assert.equal(gen.draft.tasks[2].stage, '配色练习');

  const plan = await api('POST', '/plans', gen.draft, 201);
  assert.equal(plan.tasks_total, 3);
  assert.equal(plan.ai_generated, 1);
  state.planId = plan.id;

  assert.equal((await api('GET', '/tasks?scope=today&date=2026-03-08')).length, 1);
  const done = await api('PATCH', `/tasks/${plan.tasks[0].id}`, { status: 'done', date: '2026-03-08' });
  assert.equal(done.status, 'done');
  assert.equal((await api('GET', `/plans/${plan.id}`)).tasks_done, 1);

  await api('POST', '/tasks', { title: '整理笔记', due_date: '2026-03-09' }, 201);
  assert.equal((await api('GET', '/tasks?scope=today&date=2026-03-10')).filter((t: any) => t.status !== 'done').length, 1, '逾期任务仍出现在今日');

  for (const date of ['2026-03-06', '2026-03-07', '2026-03-08']) {
    await api('POST', '/logs', { date, minutes: 45, content: `${date} 练习色彩小稿`, plan_id: plan.id }, 201);
  }
  await api('POST', '/logs', { minutes: 0, content: '' }, 400);
  const stats = await api('GET', '/learning/stats?date=2026-03-08');
  assert.equal(stats.streak, 3);
  assert.equal(stats.minutes_today, 45);
  assert.equal(stats.minutes_7d, 135);
  const art = stats.domains.find((d: any) => d.id === 'digital-art');
  assert.equal(art.minutes_total, 135, '记录继承计划所属方向');
  assert.equal(art.tasks_done, 1);
  assert.equal((await api('GET', '/learning/stats?date=2026-03-09')).streak, 3, '今天还没学不清零');
  assert.equal((await api('GET', '/learning/stats?date=2026-03-10')).streak, 0);

  await api('POST', `/plans/${plan.id}/resources`, { item_id: state.knowledgeId });
  assert.equal((await api('GET', `/plans/${plan.id}`)).resources.length, 1);

  const review = await api('POST', '/reviews/generate', { period_start: '2026-03-02', period_end: '2026-03-08' });
  assert.equal(review.basis.logs, 3);
  assert.match(mock.requests.at(-1)!.body.messages[1].content, /练习色彩小稿/, '总结只依据真实记录');
  await api('POST', '/reviews/generate', { period_start: '2020-01-01', period_end: '2020-01-07' }, 400);
  await api('POST', '/reviews', review.draft, 201);

  const dash = await api('GET', '/dashboard?date=2026-03-08');
  assert.equal(dash.plans[0].title, '色彩基础 4 周计划');
  assert.equal(dash.ai.configured, true);
  assert.ok(dash.knowledge.total >= 4);
});

test('复习卡片：间隔重复排程、到期队列、AI 出卡草稿', async () => {
  const { schedule } = await import('../server/routes/cards');
  const fresh = { interval_days: 0, ease: 2.5, reps: 0, lapses: 0 };
  assert.deepEqual(schedule(fresh, 'good', '2026-03-01'), { interval_days: 1, ease: 2.5, reps: 1, lapses: 0, due_date: '2026-03-02' });
  assert.equal(schedule(fresh, 'easy', '2026-03-01').due_date, '2026-03-05');
  const second = schedule({ interval_days: 1, ease: 2.5, reps: 1, lapses: 0 }, 'good', '2026-03-02');
  assert.equal(second.interval_days, 3);
  const third = schedule({ ...second }, 'good', '2026-03-05');
  assert.equal(third.interval_days, 8, '之后按难度系数成倍增长（3 × 2.5 四舍五入）');
  const lapse = schedule({ ...third }, 'again', '2026-03-13');
  assert.deepEqual([lapse.interval_days, lapse.reps, lapse.lapses, lapse.due_date], [0, 0, 1, '2026-03-13'], '忘了：当天重来');
  assert.equal(lapse.ease, 2.3);
  assert.equal(schedule({ interval_days: 300, ease: 3.2, reps: 9, lapses: 0 }, 'easy', '2026-03-01').interval_days, 365, '间隔封顶一年');

  // AI 起草：只返回草稿，不落库；没有答案的卡片被过滤
  const draft = await api('POST', '/cards/generate', { knowledge_id: state.knowledgeId });
  assert.equal(draft.cards.length, 2);
  assert.match(mock.requests.at(-1)!.body.messages[1].content, /色相、明度、纯度/, '依据知识条目的内容出题');
  assert.equal((await api('GET', '/cards')).length, 0);

  const saved = await api('POST', '/cards', { cards: draft.cards, knowledge_id: state.knowledgeId, ai_generated: true, date: '2026-03-01' }, 201);
  assert.equal(saved.created, 2);
  await api('POST', '/cards', { front: 'ephemeral', back: '短暂的；例：Fame is ephemeral.', domain_id: 'english', date: '2026-03-01' }, 201);
  await api('POST', '/cards', { front: '  ' }, 400);

  let due = await api('GET', '/cards?scope=due&date=2026-03-01');
  assert.equal(due.length, 3);
  assert.equal(due[0].domain_id, 'digital-art', '卡片继承知识条目的学习方向');
  assert.deepEqual(due[0].next, { again: 0, hard: 1, good: 1, easy: 4 }, '附带每个评分对应的下次间隔');
  assert.equal(due[0].knowledge_title, '色彩构成基础');

  const r1 = await api('POST', `/cards/${due[0].id}/review`, { rating: 'good', date: '2026-03-01' });
  assert.equal(r1.card.due_date, '2026-03-02');
  assert.equal(r1.stats.due, 2);
  assert.equal(r1.stats.reviewed_today, 1);
  await api('POST', `/cards/${due[1].id}/review`, { rating: 'again', date: '2026-03-01' });
  assert.equal((await api('GET', '/cards/stats?date=2026-03-01')).due, 2, '忘了的卡片今天还要再过一遍');
  await api('POST', `/cards/${due[1].id}/review`, { rating: 'bogus' }, 400);

  await api('PATCH', `/cards/${due[2].id}`, { suspended: true });
  assert.equal((await api('GET', '/cards/stats?date=2026-03-01')).due, 1, '暂停的卡片不进入队列');
  assert.equal((await api('GET', '/cards/stats?date=2026-03-02')).due, 2);
  assert.equal((await api('GET', `/cards?knowledge_id=${state.knowledgeId}`)).length, 2);
  assert.equal((await api('GET', '/dashboard?date=2026-03-02')).cards.due, 2, '总览带上待复习数量');

  const again = await api('POST', '/cards/generate', { knowledge_id: state.knowledgeId });
  assert.ok(again.cards.length > 0);
  assert.match(mock.requests.at(-1)!.body.messages[1].content, /不要重复[\s\S]*色彩的三个属性是什么/, '再次出题时告知已有卡片');
});

test('研究实验室：来源、引用校验、事实核查（引文必须逐字可追溯）、报告', async () => {
  const { checkCitations, quoteAppearsIn } = await import('../server/routes/research');
  assert.deepEqual(checkCitations('事实 A [S1]，事实 B [S2, S3]，事实 C【S9】。', [1, 2, 3, 4]), { cited: [1, 2, 3], invalid: [9], unused: [4] });
  assert.equal(quoteAppearsIn('光与色的 瞬间变化', '印象派画家重视光与色的瞬间变化。'), true);
  assert.equal(quoteAppearsIn('印象派起源于 1850 年的伦敦', '印象派画家重视光与色的瞬间变化。'), false);

  let p = await api('POST', '/research', { title: '印象派为何在当时被排斥', question: '官方沙龙拒绝印象派的原因是什么？' }, 201);
  const pid = p.id;
  p = await api('POST', `/research/${pid}/sources`, { title: '沙龙制度概述', url: 'https://example.org/salon', author: '张三', published_at: '2019', content: '十九世纪的巴黎官方沙龙由学院派评审把持，偏好历史题材与光滑的完成度。1874 年，一批被拒绝的画家举办了独立展览。' }, 201);
  p = await api('POST', `/research/${pid}/sources`, { document_id: state.docId }, 201);
  assert.deepEqual(p.sources.map((s: any) => s.seq), [1, 2]);
  assert.equal(p.sources[1].kind, 'document');
  await api('POST', `/research/${pid}/sources`, { title: '坏链接', url: 'ftp://x' }, 400);

  p = await api('POST', `/research/${pid}/findings`, { kind: 'claim', title: '1874 年被拒绝的画家举办了独立展览' }, 201);
  const fid = p.findings[0].id;

  // 模型给出一条真实引文和一条编造引文：只有真实的那条通过校验
  mock.factcheck = { verdict: 'supported', reasoning: '来源 1 明确记载。', evidence: [
    { source: 1, quote: '1874 年，一批被拒绝的画家举办了独立展览' },
    { source: 1, quote: '莫奈亲自租下了纳达尔的工作室' },
    { source: 7, quote: '不存在的来源' },
  ] };
  let fc = await api('POST', `/research/findings/${fid}/factcheck`, {});
  assert.equal(fc.result.verdict, 'supported');
  assert.deepEqual(fc.result.evidence.map((e: any) => e.verified), [true, false], '指向不存在来源的证据被丢弃');
  assert.equal(fc.result.downgraded, false);

  // 模型声称「支持」但引文全是编造的：结论被强制降级为未核实
  mock.factcheck = { verdict: 'supported', reasoning: '…', evidence: [{ source: 2, quote: '这句话在资料里根本没有出现过' }] };
  fc = await api('POST', `/research/findings/${fid}/factcheck`, {});
  assert.equal(fc.result.verdict, 'unverified');
  assert.equal(fc.result.downgraded, true);
  assert.equal(fc.project.findings[0].verdict, 'unverified');

  mock.researchText = '# 印象派与沙龙\n\n## 主要结论\n\n学院派评审把持沙龙 [S1]。印象派重视光色变化 [S2]。有人认为还与政治有关 [S5]。';
  const analysis = await api('POST', `/research/${pid}/analyze`, { task: 'compare' });
  assert.deepEqual(analysis.citation_check.invalid, [5]);
  const sys = mock.requests.at(-1)!.body.messages;
  assert.match(sys[0].content, /引用规则/);
  assert.match(sys[1].content, /编号="S1"[\s\S]*学院派评审/, '来源正文连同编号一起提供给模型');

  const rep = await api('POST', `/research/${pid}/report`, {}, 201);
  const report = rep.project.reports[0];
  assert.match(report.content, /不存在的来源编号 S5/, '无效引用被显式标出');
  assert.match(report.content, /## 来源[\s\S]*\*\*\[S1\]\*\* 沙龙制度概述（张三，2019） <https:\/\/example\.org\/salon>/, '来源列表由数据库生成');
  assert.ok(!/\*\*\[S5\]\*\*/.test(report.content));
  assert.equal(report.title, '印象派与沙龙');

  const saved = await api('POST', `/research/${pid}/save-to-knowledge`, { report_id: report.id }, 201);
  assert.equal((await api('GET', `/knowledge/${saved.id}`)).type, 'research');
  assert.equal((await api('POST', `/research/${pid}/save-to-knowledge`, { report_id: report.id })).existed, true);

  const empty = await api('POST', '/research', { title: '空项目' }, 201);
  await api('POST', `/research/${empty.id}/analyze`, { task: 'summary' }, 400);
  state.researchId = pid;
});

test('内容创作中心：选题流转、AI 起草、视觉参考、发布数据', async () => {
  const t = await api('POST', '/studio/topics', { title: '为什么你的配色总是脏', series: '色彩课', platform: '小红书', research_id: state.researchId }, 201);
  assert.equal(t.status, 'idea');
  const moved = await api('PATCH', `/studio/topics/${t.id}`, { status: 'script', publish_date: '2026-04-01', metrics: { views: 1200, likes: '88', bad: -1 } });
  assert.equal(moved.status, 'script');
  assert.deepEqual(moved.metrics, { views: 1200, likes: 88 });
  assert.equal(moved.research.title, '印象派为何在当时被排斥');

  const draft = await api('POST', `/studio/topics/${t.id}/draft`, { task: 'outline' });
  assert.equal(draft.field, 'outline');
  const prompt = mock.requests.at(-1)!.body.messages;
  assert.match(prompt[0].content, /Remo叠绘/);
  assert.match(prompt[1].content, /关联研究报告/, '关联的研究报告进入创作上下文');
  await api('POST', `/studio/topics/${t.id}/draft`, { task: 'nope' }, 400);

  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
  const refRes = await upload('/studio/refs', { file: new File([png as BlobPart], 'ref.png', { type: 'image/png' }), topic_id: t.id, palette: '#B5432B, #2F4A73, nope' });
  assert.equal(refRes.status, 201);
  const ref = await refRes.json();
  assert.deepEqual(ref.palette, ['#B5432B', '#2F4A73']);
  const img = await app.request(ref.image_url, { headers: { host: 'localhost' } });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await upload('/studio/refs', { file: new File(['text'], 'a.txt') })).status, 400);
  await api('POST', '/studio/refs', { url: 'https://example.org/ref', title: '外链参考' }, 201);
  assert.equal((await api('GET', `/studio/topics/${t.id}`)).refs.length, 1);
  assert.equal((await api('GET', '/studio/refs')).length, 2);
});

test('备份与恢复：导出不含密钥，恢复后数据完整', async () => {
  const before = await api('GET', '/backup/info');
  const res = await app.request('/api/backup/export', { headers: { host: 'localhost' } });
  assert.equal(res.status, 200);
  const zip = new Uint8Array(await res.arrayBuffer());
  const entries = unzipSync(zip);
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  assert.equal(manifest.app, 'remo-ai-learning-platform');
  assert.ok(Object.keys(entries).some((n) => n.startsWith('uploads/')));
  const snapshotPath = path.join(dataDir, 'snapshot-check.sqlite');
  fs.writeFileSync(snapshotPath, entries['remo.sqlite']);
  const snap = new DatabaseSync(snapshotPath, { readOnly: true });
  assert.equal((snap.prepare("SELECT COUNT(*) AS n FROM providers WHERE api_key_enc != ''").get() as { n: number }).n, 0, '备份中不包含 API Key');
  snap.close();

  // 破坏性修改后恢复
  await api('DELETE', `/knowledge/${state.knowledgeId}`);
  await api('DELETE', `/plans/${state.planId}`);
  assert.notEqual((await api('GET', '/backup/info')).counts.plans, before.counts.plans);

  const refuse = await upload('/backup/import', { file: new File([zip as BlobPart], 'b.zip') });
  assert.equal(refuse.status, 400, '未确认时拒绝恢复');
  const junk = await upload('/backup/import', { file: new File(['not a zip'], 'b.zip'), confirm: 'yes' });
  assert.equal(junk.status, 400);

  const ok = await upload('/backup/import', { file: new File([zip as BlobPart], 'b.zip'), confirm: 'yes' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const afterInfo = await api('GET', '/backup/info');
  assert.deepEqual(afterInfo.counts, before.counts);
  assert.equal((await api('GET', `/knowledge/${state.knowledgeId}`)).title, '色彩构成基础');
  assert.deepEqual((await api('GET', '/knowledge?q=' + encodeURIComponent('互补色'))).items.map((i: any) => i.title), ['色彩构成基础'], '全文索引随备份恢复');
  assert.equal((await api('GET', '/ai/providers'))[0].has_key, true, '同机恢复保留已填写的密钥');
  assert.ok(fs.readdirSync(dataDir).some((f) => f.includes('.before-restore-')), '恢复前的数据被保留');
});

test('自动备份：生成、轮转、下载，文件名严格校验', async () => {
  const { runAutoBackup, listAutoBackups } = await import('../server/lib/backup');
  const { config } = await import('../server/config');
  config.autoBackupKeep = 2;
  fs.mkdirSync(config.backupDir, { recursive: true });
  for (const stamp of ['20200101-000000', '20200102-000000', '20200103-000000']) {
    fs.writeFileSync(path.join(config.backupDir, `auto-remo-backup-${stamp}.zip`), 'old');
  }
  fs.writeFileSync(path.join(config.backupDir, 'my-own-file.zip'), 'keep me');
  runAutoBackup();
  const files = listAutoBackups();
  assert.equal(files.length, 2, '只保留最近 2 份');
  assert.ok(files[0].bytes > 1000 && files[1].name.includes('20200103'));
  assert.ok(fs.existsSync(path.join(config.backupDir, 'my-own-file.zip')), '不触碰非自动备份文件');
  assert.equal((await api('GET', '/backup/info')).auto_backup.files.length, 2);

  const ok = await app.request(`/api/backup/auto/${files[0].name}`, { headers: { host: 'localhost' } });
  assert.equal(ok.status, 200);
  assert.ok(unzipSync(new Uint8Array(await ok.arrayBuffer()))['manifest.json']);
  for (const bad of ['my-own-file.zip', '..%2Fremo.sqlite', 'auto-remo-backup-x.zip']) {
    assert.equal((await app.request(`/api/backup/auto/${bad}`, { headers: { host: 'localhost' } })).status, 404, bad);
  }
});

test('安全：跨站写请求与陌生 Host 被拒绝', async () => {
  const cross = await app.request('/api/conversations', json('POST', {}, { origin: 'https://evil.example' }));
  assert.equal(cross.status, 403);
  const same = await app.request('/api/conversations', json('POST', {}, { origin: 'http://127.0.0.1:5173' }));
  assert.equal(same.status, 201, '本机开发端口视为同源');
  const rebinding = await app.request('/api/health', { headers: { host: 'attacker.example:8787' } });
  assert.equal(rebinding.status, 403);
});
