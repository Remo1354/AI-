import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir } from './helpers';

const dataDir = useTempDataDir();
process.env.APP_PASSWORD = 'correct horse';
const { reloadConfig } = await import('../server/config');
reloadConfig();
const { createApp } = await import('../server/app');
const { closeDb } = await import('../server/db');
const app = createApp();
const headers = { host: 'localhost', 'content-type': 'application/json' };

after(() => { closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('设置访问密码后：未登录无法读取数据，登录后可以', async () => {
  assert.equal((await app.request('/api/health', { headers })).status, 200, '健康检查无需登录');
  assert.deepEqual(await (await app.request('/api/auth/status', { headers })).json(), { required: true, authenticated: false });
  assert.equal((await app.request('/api/dashboard', { headers })).status, 401);
  assert.equal((await app.request('/api/backup/export', { headers })).status, 401);

  const wrong = await app.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(wrong.status, 401);

  const ok = await app.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password: 'correct horse' }) });
  assert.equal(ok.status, 200);
  const cookie = (ok.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^remo_session=/);
  assert.match(ok.headers.get('set-cookie') || '', /HttpOnly/);

  assert.equal((await app.request('/api/dashboard', { headers: { ...headers, cookie } })).status, 200);
  assert.equal((await app.request('/api/dashboard', { headers: { ...headers, cookie: 'remo_session=9999999999999.forged' } })).status, 401, '伪造的会话无效');
});
