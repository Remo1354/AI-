import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/** 为每个测试文件准备一个干净的数据目录。必须在 import 服务端模块之前调用。 */
export function useTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remo-test-'));
  process.env.DATA_DIR = dir;
  process.env.APP_PASSWORD = '';
  process.env.APP_SECRET = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.NODE_ENV = 'test';
  return dir;
}

export interface MockAi {
  url: string;
  requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[];
  /** 事实核查接口下一次返回的 JSON */
  factcheck: unknown;
  /** 研究分析接口下一次返回的文本 */
  researchText: string;
  failNext: number | null;
  close(): Promise<void>;
}

const sse = (res: http.ServerResponse, lines: string[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const l of lines) res.write(l);
  res.end();
};

function replyFor(mock: MockAi, system: string, lastUser: string): string {
  if (system.includes('"key_points"')) {
    return '```json\n' + JSON.stringify({ summary: '这是一份关于色彩理论的摘要。', key_points: ['补色并置会增强对比', '明度比色相更影响可读性'], tags: ['色彩', '绘画基础'] }) + '\n```';
  }
  if (system.includes('"stages"')) {
    return JSON.stringify({
      title: '色彩基础 4 周计划', goal: '能独立完成一张配色合理的小稿', roadmap: '## 第一阶段\n认识色相、明度、纯度。',
      stages: [
        { name: '认识色彩', weeks: 2, tasks: [{ title: '临摹 3 张色彩小稿', estimate_min: 90, week: 1 }, { title: '做一张 12 色相环', estimate_min: 60, week: 2 }] },
        { name: '配色练习', weeks: 2, tasks: [{ title: '用互补色完成一张静物', estimate_min: 120, week: 3 }] },
      ],
    });
  }
  if (system.includes('"front"')) {
    return JSON.stringify({ cards: [
      { front: '色彩的三个属性是什么？', back: '色相、明度、纯度。' },
      { front: '互补色在色相环上的位置关系？', back: '位于色相环的两端，并置时对比最强。' },
      { front: '没有答案的卡片会被丢弃', back: '' },
    ] });
  }
  if (system.includes('"verdict"')) return JSON.stringify(mock.factcheck);
  if (system.includes('引用规则')) return mock.researchText;
  return `回复：${lastUser}`;
}

/** 同时模拟 OpenAI 兼容接口（/chat/completions、/models）和 Anthropic Messages 接口（/v1/messages、/v1/models）。 */
export async function startMockAi(): Promise<MockAi> {
  const mock: MockAi = {
    url: '', requests: [], factcheck: {}, researchText: '', failNext: null,
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url || '';
      mock.requests.push({ path: url, headers: req.headers, body });
      if (mock.failNext) {
        const status = mock.failNext;
        mock.failNext = null;
        res.writeHead(status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid api key' } }));
      }

      if (url.endsWith('/models') || url.includes('/models?')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-large', type: 'model', display_name: 'Mock Large', created_at: '2026-01-01T00:00:00Z' }, { id: 'mock-small', type: 'model', display_name: 'Mock Small', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'mock-large', last_id: 'mock-small' }));
      }

      if (url.endsWith('/chat/completions')) {
        const system = body.messages.find((m: any) => m.role === 'system')?.content || '';
        const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user')?.content || '';
        const text = replyFor(mock, system, lastUser);
        const parts = [text.slice(0, 2), text.slice(2, 9), text.slice(9)].filter(Boolean);
        return sse(res, [
          ...parts.map((p) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p } }] })}\n\n`),
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }

      if (url.startsWith('/v1/messages')) {
        const system = typeof body.system === 'string' ? body.system : (body.system || []).map((b: any) => b.text).join('\n');
        const last = [...body.messages].reverse().find((m: any) => m.role === 'user');
        const lastUser = typeof last?.content === 'string' ? last.content : (last?.content || []).map((b: any) => b.text).join('');
        const text = `Claude：${replyFor(mock, system, lastUser)}`;
        const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        return sse(res, [
          ev('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } }),
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, 5) } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(5) } }),
          ev('content_block_stop', { index: 0 }),
          ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 11 } }),
          ev('message_stop', {}),
        ]);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}

export function parseSse(text: string): { event: string; data: any }[] {
  return text.split(/\n\n+/).filter((b) => b.trim()).map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1] || 'message';
    const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return { event, data: data ? JSON.parse(data) : null };
  });
}

/** 手写一个只含一行文字的最小 PDF，用来验证 PDF 文字提取。 */
export function tinyPdf(text: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    (() => { const s = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`; return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; })(),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
