/**
 * 端到端冒烟测试：用真实浏览器把主要流程走一遍。
 *
 *   npm run test:e2e              只跑流程
 *   npm run test:e2e -- --shots   同时把截图存到 test-results/e2e/
 *
 * 自带一个模拟的模型服务和一个使用临时数据目录的应用实例，不会碰到真实数据，也不需要 API Key。
 * 需要本机装有 Playwright（npm i -D playwright && npx playwright install chromium）；
 * Claude Code 云端环境已预装。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startMockAi } from '../helpers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.E2E_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.argv.includes('--shots') ? path.join(ROOT, 'test-results', 'e2e') : '';

// Playwright 不是项目依赖（体积大且只用于这项测试），所以运行时再解析
let playwright: typeof import('playwright');
try {
  playwright = createRequire(import.meta.url)('playwright');
} catch {
  console.error('没有找到 Playwright。安装后再运行：npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remo-e2e-'));
// 以内存文件的形式交给浏览器，文件名用中文，顺便验证中文文件名的上传
const noteFile = {
  name: '印象派笔记.txt', mimeType: 'text/plain',
  buffer: Buffer.from('印象派笔记\n\n印象派画家重视光与色的瞬间变化。莫奈的《日出·印象》是代表作。\n\n补色并置能让画面更明亮，这是印象派常用的手法。'),
};
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const mock = await startMockAi();
mock.factcheck = { verdict: 'supported', reasoning: '来源 1 明确记载了独立展览。', evidence: [{ source: 1, quote: '1874 年，一批被拒绝的画家举办了独立展览' }] };
mock.researchText = '# 印象派与官方沙龙\n\n## 主要结论\n\n- 学院派评审把持沙龙，偏好历史题材与光滑的完成度 [S1]。\n- 1874 年被拒绝的画家举办了独立展览 [S1]。\n\n## 局限与待查\n\n现有来源未涉及当时的评论界反应。';

let app: ChildProcess | null = null;
const problems: string[] = [];
const cleanup = async () => {
  app?.kill('SIGTERM');
  await mock.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(dataDir, { recursive: true, force: true });
};

async function startApp() {
  app = spawn(process.execPath, ['scripts/run-prod.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, APP_PASSWORD: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', AUTO_BACKUP_HOURS: '0' },
  });
  let log = '';
  app.stdout?.on('data', (d) => (log += d));
  app.stderr?.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* 还没起来 */ }
    if (app.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`应用没有启动：\n${log}`);
}

let activePage: import('playwright').Page | null = null;
let failures = 0;

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0];
    problems.push(`${name}：${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
    // 失败时留一张现场截图，方便定位
    if (SHOTS && activePage) await activePage.screenshot({ path: path.join(SHOTS, `fail-${++failures}.png`) }).catch(() => {});
  }
}

try {
  await startApp();
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', acceptDownloads: true });
  const page = await ctx.newPage();
  activePage = page;
  page.on('console', (m: import('playwright').ConsoleMessage) => { if (m.type() === 'error') problems.push(`浏览器控制台报错：${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e: Error) => problems.push(`页面脚本异常：${e.message.slice(0, 200)}`));
  page.on('response', (r: import('playwright').Response) => { if (r.status() >= 500) problems.push(`接口 ${r.status()}：${r.url()}`); });
  const shot = async (name: string, target = page) => { if (SHOTS) await target.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  console.log(`\n端到端冒烟测试（${BASE}）\n`);

  await step('总览：空状态与 AI 未配置提示', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.dash-grid');
    if (!(await page.locator('.banner.warn').first().isVisible())) throw new Error('没有显示「未配置模型」提示');
    await page.waitForTimeout(500);
    await shot('01-dashboard-empty');
  });

  await step('AI 助手：未配置模型时不能发送', async () => {
    await page.goto(`${BASE}/assistant`);
    await page.fill('.composer textarea', '你好');
    if (!(await page.locator('.composer .btn.accent').isDisabled())) throw new Error('发送按钮应处于禁用状态');
  });

  await step('设置：添加模型服务、获取模型列表、测试连接，页面不出现明文密钥', async () => {
    await page.goto(`${BASE}/settings`);
    await page.click('text=添加第一个模型服务');
    await page.selectOption('.modal select >> nth=0', 'custom');
    await page.fill('.modal input >> nth=0', '本地模拟模型');
    await page.fill('.modal input[placeholder^="https://…/v1"]', mock.url);
    await page.fill('.modal input[type=password]', 'sk-e2e-secret-key-123456');
    await page.click('text=从服务商获取模型列表');
    await page.click('.modal .tag:has-text("mock-large")');
    await page.click('.modal-foot .btn.primary');
    await page.waitForSelector('.provider');
    await page.click('text=测试连接');
    await page.waitForSelector('.provider .banner.ok');
    await page.reload();
    await page.waitForSelector('.provider');
    if ((await page.content()).includes('sk-e2e-secret-key-123456')) throw new Error('页面中出现了明文密钥');
    await shot('02-settings-models');
  });

  await step('AI 助手：选择教学模式、流式对话、自动标题、存入知识库', async () => {
    await page.goto(`${BASE}/assistant`);
    await page.click('.mode-card:has-text("零基础讲解")');
    await page.fill('.composer textarea', '用初学者能懂的方式讲讲什么是补色');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.assistant .msg-actions', { timeout: 15000 });
    const reply = await page.locator('.msg.assistant .prose').innerText();
    if (!reply.includes('回复：用初学者能懂的方式讲讲什么是补色')) throw new Error(`回复内容不符：${reply}`);
    await page.waitForSelector('.chat-title:has-text("用初学者能懂")');
    await page.click('text=存入知识库');
    await page.fill('.modal input >> nth=0', '补色是什么');
    await page.click('.modal-foot .btn.primary');
    await page.waitForSelector('.toast:has-text("已保存到知识库")');
  });

  await step('AI 助手：上传资料并基于资料提问', async () => {
    await page.click('text=附加资料');
    await page.setInputFiles('.modal input[type=file]', noteFile);
    await page.waitForSelector('.doc-chip');
    await page.fill('.composer textarea', '这份资料讲了什么？');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg-note:has-text("已载入资料全文")', { timeout: 15000 });
    const sent = mock.requests.at(-1)!.body.messages[0].content as string;
    if (!sent.includes('莫奈的《日出·印象》')) throw new Error('资料正文没有进入模型上下文');
    await page.waitForTimeout(300);
    await shot('03-assistant');
  });

  let planUrl = '';
  await step('学习中心：AI 生成计划草稿 → 确认保存 → 完成任务 → 记录学习', async () => {
    await page.goto(`${BASE}/learning?tab=plans`);
    await page.click('.page-actions >> text=新建学习计划');
    await page.fill('.modal input >> nth=0', '数字绘画色彩基础');
    await page.selectOption('.modal select >> nth=0', 'digital-art');
    await page.click('text=生成计划草稿');
    await page.waitForSelector('text=确认学习计划');
    await page.click('text=保存计划');
    await page.waitForURL(/learning\/plans\//);
    planUrl = page.url();
    await page.locator('.task-row .check').first().click();
    await page.waitForSelector('.check.done');
    await page.click('.page-actions >> text=记录学习');
    await page.fill('.modal textarea', '临摹了三张莫奈的色彩小稿，注意到阴影里其实有很多冷色。');
    await page.click('.modal-foot .btn.primary');
    await page.waitForSelector('.toast:has-text("已记录")');
    await page.waitForTimeout(300);
    await shot('04-plan-detail');
  });

  await step('学习中心：快速添加今日任务，刷新后仍在', async () => {
    await page.goto(`${BASE}/learning`);
    await page.fill('.inline-add input >> nth=0', '背 20 个艺术史英语词汇');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.task-row:has-text("背 20 个")');
    await page.reload();
    await page.waitForSelector('.task-row:has-text("背 20 个")');
    await shot('05-learning-today');
  });

  await step('知识库：新建笔记、AI 提炼、中文全文检索（含上传资料正文）', async () => {
    await page.goto(`${BASE}/knowledge`);
    await page.click('text=新建笔记');
    await page.fill('.modal input >> nth=0', '色彩构成基础');
    await page.fill('.modal textarea', '色相、明度、纯度是色彩的三个属性。\n\n互补色位于色相环的两端，并置时对比最强。');
    await page.click('.modal-foot .btn.primary');
    await page.waitForURL(/knowledge\/kn_/);
    await page.click('aside >> text=AI 提炼');
    await page.waitForSelector('.point');
    await shot('06-knowledge-detail');
    await page.goto(`${BASE}/knowledge`);
    await page.fill('.search-box input', '莫奈');
    await page.waitForSelector('.k-item mark', { timeout: 8000 });
    const first = await page.locator('.k-item h3').first().innerText();
    if (!first.includes('印象派笔记')) throw new Error(`搜索「莫奈」应命中上传的资料，实际是：${first}`);
    await page.fill('.search-box input', '');
    await page.waitForTimeout(600);
    await shot('07-knowledge-list');
  });

  await step('研究实验室：来源 → 陈述 → 事实核查（引文校验）→ 报告（自动来源列表）', async () => {
    await page.goto(`${BASE}/research`);
    await page.click('.page-actions >> text=新建研究项目');
    await page.fill('.modal input >> nth=0', '印象派为何在当时被排斥');
    await page.fill('.modal textarea', '官方沙龙拒绝印象派的原因是什么？');
    await page.click('.modal-foot .btn.primary');
    await page.waitForURL(/research\/rs_/);
    await page.click('text=粘贴文本');
    await page.fill('.modal input >> nth=0', '沙龙制度概述');
    await page.fill('.modal input >> nth=1', 'https://example.org/salon');
    await page.fill('.modal textarea >> nth=0', '十九世纪的巴黎官方沙龙由学院派评审把持，偏好历史题材与光滑的完成度。1874 年，一批被拒绝的画家举办了独立展览。');
    await page.click('.modal-foot .btn.primary');
    await page.waitForSelector('.source-card');
    await page.click('.tab:has-text("发现与核查")');
    await page.click('text=记录发现');
    await page.fill('.modal input >> nth=0', '1874 年被拒绝的画家举办了独立展览');
    await page.click('.modal-foot .btn.primary');
    await page.click('text=对照来源核查');
    await page.waitForSelector('.evidence.verified', { timeout: 15000 });
    await shot('08-research-factcheck');
    await page.click('.tab:has-text("研究报告")');
    await page.click('text=生成研究报告');
    await page.waitForSelector('article .prose', { timeout: 15000 });
    const text = await page.locator('article').innerText();
    if (!text.includes('沙龙制度概述') || !text.includes('example.org/salon')) throw new Error('报告末尾缺少自动生成的来源列表');
    await shot('09-research-report');
  });

  await step('内容创作：记录灵感 → 推进阶段 → AI 起草大纲并采用 → 出现在发布日历', async () => {
    await page.goto(`${BASE}/studio`);
    await page.fill('input[placeholder^="记下一个选题灵感"]', '为什么你的配色总是脏');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.topic-card');
    await shot('10-studio-board');
    await page.click('.topic-card');
    await page.waitForURL(/studio\/tp_/);
    await page.selectOption('aside select >> nth=0', 'script');
    await page.fill('aside input[type=date]', new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10));
    await page.click('text=起草大纲');
    await page.waitForSelector('text=AI 草稿');
    await page.click('text=采用（替换大纲）');
    await page.waitForSelector('.toast:has-text("已保存")');
    await shot('11-studio-topic');
    await page.goto(`${BASE}/studio?tab=calendar`);
    await page.waitForTimeout(500);
    if (!(await page.locator('.cal-item').count())) {
      await page.click('[aria-label="下个月"]'); // 5 天后可能落在下个月
      await page.waitForSelector('.cal-item');
    }
  });

  await step('总览：汇总各模块数据；全站搜索可用', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.dash-grid');
    const text = await page.locator('.dash-grid').innerText();
    for (const expected of ['背 20 个艺术史英语词汇', '色彩基础 4 周计划', '色彩构成基础', '印象派为何在当时被排斥', '印象派笔记']) {
      if (!text.includes(expected)) throw new Error(`总览缺少：${expected}`);
    }
    await page.waitForTimeout(500);
    await shot('12-dashboard');
    await page.keyboard.press('Control+k');
    await page.fill('.palette input', '补色');
    await page.waitForSelector('.palette-results .list-row', { timeout: 8000 });
    await page.keyboard.press('Escape');
  });

  await step('设置：调用记录有数据；深色主题；下载完整备份', async () => {
    await page.goto(`${BASE}/settings?tab=calls`);
    await page.waitForSelector('.table tbody tr');
    await page.goto(`${BASE}/settings?tab=appearance`);
    await page.click('text=墨（深色）');
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') throw new Error('深色主题没有生效');
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.dash-grid');
    await page.waitForTimeout(400);
    await shot('13-dashboard-dark');
    await page.goto(`${BASE}/settings?tab=appearance`);
    await page.click('text=纸（浅色）');
    await page.goto(`${BASE}/settings?tab=data`);
    await page.waitForSelector('text=数据存放在哪里');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=下载完整备份')]);
    const file = await download.path();
    if (!file || fs.statSync(file).size < 1000) throw new Error('备份文件异常');
  });

  await step('手机与平板：页面不出现横向溢出', async () => {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    const mp = await mobile.newPage();
    for (const [name, url] of [['m1-dashboard', '/'], ['m2-assistant', '/assistant'], ['m3-knowledge', '/knowledge'], ['m4-learning', '/learning'], ['m5-research', '/research'], ['m6-studio', '/studio'], ['m7-settings', '/settings']]) {
      await mp.goto(BASE + url);
      await mp.waitForTimeout(700);
      await shot(name, mp);
      const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`${url} 在手机宽度下横向溢出 ${overflow}px`);
    }
    const tablet = await browser.newContext({ viewport: { width: 900, height: 1100 }, locale: 'zh-CN' });
    const tp = await tablet.newPage();
    for (const [name, url] of [['t1-dashboard', BASE + '/'], ['t2-plan', planUrl]]) {
      await tp.goto(url);
      await tp.waitForTimeout(600);
      await shot(name, tp);
      const overflow = await tp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`${url} 在平板宽度下横向溢出 ${overflow}px`);
    }
  });

  await browser.close();
} catch (err) {
  problems.push(`测试未能完成：${(err as Error).message}`);
} finally {
  await cleanup();
}

const unique = [...new Set(problems)];
if (unique.length) {
  console.log(`\n发现 ${unique.length} 个问题：\n${unique.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`\n全部通过。${SHOTS ? `截图在 ${SHOTS}` : ''}\n`);
process.exit(0);
