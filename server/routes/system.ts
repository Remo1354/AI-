import { Hono } from 'hono';
import { all, get } from '../db';
import { badRequest, isDate, today } from '../lib/http';
import fs from 'node:fs';
import { autoBackupPath, createBackup, dataInfo, restoreBackup } from '../lib/backup';
import { notFound } from '../lib/http';
import { DOC_PUBLIC_COLUMNS } from '../lib/documents';
import { defaultModelRef, listModelOptions } from '../ai/registry';
import { learningStats, tasksForDay } from './learning';
import { cardStats } from './cards';
import { config } from '../config';

export const systemRoutes = new Hono();

/** 首页总览：一次请求取回所有区块需要的数据。 */
systemRoutes.get('/dashboard', (c) => {
  const q = c.req.query('date');
  const date = isDate(q) ? q : today();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const options = listModelOptions();
  const def = defaultModelRef();
  return c.json({
    date,
    ai: { configured: options.length > 0, default: options.find((o) => o.ref === def) ?? null },
    stats: learningStats(date),
    tasks_today: tasksForDay(date),
    cards: cardStats(date),
    plans: all(
      `SELECT p.id, p.title, p.domain_id, p.target_date,
          (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id) AS tasks_total,
          (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id AND t.status = 'done') AS tasks_done,
          (SELECT t.title FROM tasks t WHERE t.plan_id = p.id AND t.status != 'done' ORDER BY t.sort LIMIT 1) AS next_task
         FROM plans p WHERE p.status = 'active' ORDER BY p.updated_at DESC LIMIT 5`),
    recent_logs: all(
      `SELECT l.id, l.date, l.minutes, l.content, l.domain_id, p.title AS plan_title
         FROM study_logs l LEFT JOIN plans p ON p.id = l.plan_id ORDER BY l.date DESC, l.created_at DESC LIMIT 6`),
    knowledge: {
      total: get<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_items')!.n,
      added_7d: get<{ n: number }>('SELECT COUNT(*) AS n FROM knowledge_items WHERE created_at >= ?', weekAgo)!.n,
      recent: all(`SELECT id, title, type, domain_id, substr(summary, 1, 90) AS summary, created_at FROM knowledge_items ORDER BY created_at DESC LIMIT 6`),
    },
    research: all(
      `SELECT p.id, p.title, p.status, p.updated_at,
          (SELECT COUNT(*) FROM research_sources s WHERE s.project_id = p.id) AS source_count,
          (SELECT COUNT(*) FROM research_findings f WHERE f.project_id = p.id) AS finding_count,
          (SELECT COUNT(*) FROM research_reports r WHERE r.project_id = p.id) AS report_count
         FROM research_projects p WHERE p.status != 'done' ORDER BY p.updated_at DESC LIMIT 4`),
    conversations: all('SELECT id, title, mode, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 4'),
    documents: all(
      `SELECT ${DOC_PUBLIC_COLUMNS} FROM documents WHERE kind = 'document'
        ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 5`),
    studio: {
      upcoming: all(`SELECT id, title, status, publish_date, platform FROM content_topics WHERE status != 'published' AND publish_date IS NOT NULL AND publish_date >= ? ORDER BY publish_date LIMIT 3`, date),
      in_progress: get<{ n: number }>(`SELECT COUNT(*) AS n FROM content_topics WHERE status NOT IN ('idea', 'published')`)!.n,
      ideas: get<{ n: number }>(`SELECT COUNT(*) AS n FROM content_topics WHERE status = 'idea'`)!.n,
    },
  });
});

// ── 数据：备份、恢复与概况 ─────────────────────────────────────
systemRoutes.get('/backup/info', (c) =>
  c.json({ ...dataInfo(), host: config.host, password_protected: !!config.appPassword, max_upload_mb: Math.round(config.maxUploadBytes / 1048576) }));

systemRoutes.get('/backup/export', (c) => {
  const { zip, filename } = createBackup();
  return new Response(zip as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(zip.length),
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
});

systemRoutes.post('/backup/import', async (c) => {
  const form = await c.req.parseBody();
  if (!(form.file instanceof File)) throw badRequest('请选择备份文件（.zip）');
  if (form.confirm !== 'yes') throw badRequest('恢复会替换当前全部数据，请在界面上确认后再试。');
  return c.json(restoreBackup(new Uint8Array(await form.file.arrayBuffer())));
});

/** 下载一份自动备份（文件名严格校验）。 */
systemRoutes.get('/backup/auto/:name', (c) => {
  const file = autoBackupPath(c.req.param('name'));
  if (!file) throw notFound('备份文件');
  const buf = fs.readFileSync(file);
  return new Response(buf as BodyInit, {
    headers: { 'content-type': 'application/zip', 'content-length': String(buf.length), 'content-disposition': `attachment; filename="${c.req.param('name')}"` },
  });
});
