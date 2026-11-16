import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config';
import { openDb } from './db';
import { seed } from './db/seed';
import { issueSession, passwordMatches, verifySession } from './lib/crypto';
import { HttpError, readJson } from './lib/http';
import { AiError } from './ai/types';
import { MODULES } from './modules';

const COOKIE = 'remo_session';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const hostnameOf = (hostHeader: string) => hostHeader.replace(/:\d+$/, '').toLowerCase();

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function createApp() {
  openDb();
  seed();
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    if (err instanceof AiError) {
      const status = err.code === 'not_configured' ? 409 : err.code === 'bad_request' ? 400 : 502;
      return c.json({ error: { code: `ai_${err.code}`, message: err.message } }, status);
    }
    console.error('[server error]', err);
    return c.json({ error: { code: 'internal', message: '服务器内部错误，请查看终端日志。' } }, 500);
  });

  // ── 安全：本机模式下的来源校验 ──────────────────────────────
  app.use('/api/*', async (c, next) => {
    const host = hostnameOf(c.req.header('host') || '');
    const allowed = (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const anyHost = allowed.includes('*');

    // 只监听本机且未设密码时，拒绝非本机 Host，防止 DNS 重绑定把本地 API 暴露给恶意网页
    if (LOOPBACK.has(config.host) && !config.appPassword && !anyHost && !LOOPBACK.has(host) && !allowed.includes(host)) {
      return c.json({ error: { code: 'forbidden_host', message: '不允许通过这个域名访问。如需开放，请在 .env 中设置 ALLOWED_HOSTS 和 APP_PASSWORD。' } }, 403);
    }
    // 写操作必须来自同源页面，防止其他网站向本地服务发起跨站请求
    const origin = c.req.header('origin');
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      let originHost = '';
      try { originHost = new URL(origin).hostname.toLowerCase(); } catch { /* invalid origin */ }
      const same = originHost === host || (LOOPBACK.has(originHost) && LOOPBACK.has(host));
      if (!same && !anyHost && !allowed.includes(originHost)) {
        return c.json({ error: { code: 'forbidden_origin', message: '跨站请求已被拒绝。' } }, 403);
      }
    }
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'same-origin');
    await next();
  });

  // ── 可选的访问密码 ──────────────────────────────────────────
  const api = new Hono();
  api.get('/health', (c) => c.json({ ok: true, name: 'remo-ai-workspace', modules: MODULES.map((m) => m.id), time: new Date().toISOString() }));
  api.get('/auth/status', (c) =>
    c.json({ required: !!config.appPassword, authenticated: !config.appPassword || verifySession(getCookie(c, COOKIE)) }));
  api.post('/auth/login', async (c) => {
    if (!config.appPassword) return c.json({ ok: true });
    const { password } = await readJson(c);
    if (typeof password !== 'string' || !passwordMatches(password)) {
      await new Promise((r) => setTimeout(r, 600)); // 降低暴力尝试速度
      throw new HttpError(401, 'bad_password', '密码不正确');
    }
    // 经由 HTTPS（含反向代理）访问时，Cookie 只允许走加密连接
    const https = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:');
    setCookie(c, COOKIE, issueSession(), { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400, secure: https });
    return c.json({ ok: true });
  });
  api.post('/auth/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });
  api.use('*', async (c, next) => {
    if (config.appPassword && !verifySession(getCookie(c, COOKIE))) {
      throw new HttpError(401, 'unauthorized', '请先登录');
    }
    await next();
  });

  for (const m of MODULES) api.route('/', m.routes);
  api.all('*', (c) => c.json({ error: { code: 'not_found', message: '接口不存在' } }, 404));
  app.route('/api', api);

  // ── 静态页面（生产模式：由同一个进程提供前端）────────────────
  app.get('*', (c) => {
    const dist = config.webDist;
    const index = path.join(dist, 'index.html');
    if (!fs.existsSync(index)) {
      return c.text('前端尚未构建。请运行 npm run build（或直接使用 scripts/start 脚本），开发时请访问 Vite 的地址 http://127.0.0.1:5173', 503);
    }
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const file = path.normalize(path.join(dist, urlPath));
    if (file.startsWith(dist + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file).toLowerCase();
      return new Response(fs.readFileSync(file), {
        headers: {
          'content-type': STATIC_MIME[ext] || 'application/octet-stream',
          'cache-control': urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    }
    if (path.extname(urlPath)) return c.text('Not found', 404);
    return new Response(fs.readFileSync(index), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  });

  return app;
}
