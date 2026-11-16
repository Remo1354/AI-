-- Remo AI Learning Platform · 初始数据模型
-- 约定：主键为短随机文本 id；时间为 ISO-8601 UTC 字符串；日期为 YYYY-MM-DD。

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 学习领域（六大方向，可自行增删）────────────────────────────
CREATE TABLE domains (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT 'indigo',
  icon        TEXT NOT NULL DEFAULT 'book',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- ── AI：模型来源、对话、调用记录 ───────────────────────────────
CREATE TABLE providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- anthropic | openai
  base_url    TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT NOT NULL DEFAULT '',   -- AES-256-GCM 密文，永不下发前端
  models      TEXT NOT NULL DEFAULT '[]', -- JSON: [{id,label}]
  max_tokens  INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '新对话',
  mode       TEXT NOT NULL DEFAULT 'general',
  model_ref  TEXT,
  domain_id  TEXT REFERENCES domains(id) ON DELETE SET NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,          -- user | assistant
  content         TEXT NOT NULL DEFAULT '',
  model_ref       TEXT,
  context_note    TEXT,                   -- 本轮注入了哪些资料（JSON）
  error           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE ai_calls (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT,
  provider_name TEXT,
  model         TEXT,
  purpose       TEXT NOT NULL DEFAULT 'chat',
  ref_id        TEXT,
  status        TEXT NOT NULL,            -- ok | error | aborted
  error         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_ai_calls_time ON ai_calls(created_at);

-- ── 资料：上传的原始文件与切片 ────────────────────────────────
CREATE TABLE documents (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  filename   TEXT NOT NULL,
  ext        TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  sha256     TEXT NOT NULL DEFAULT '',
  stored_as  TEXT NOT NULL,               -- uploads 目录下的文件名
  kind       TEXT NOT NULL DEFAULT 'document', -- document | image
  status     TEXT NOT NULL DEFAULT 'ready',    -- ready | no_text | error
  error      TEXT,
  pages      INTEGER,
  text       TEXT NOT NULL DEFAULT '',
  chars      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_documents_sha ON documents(sha256);

CREATE TABLE document_chunks (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  content         TEXT NOT NULL,
  -- 预留：向量检索。写入 Float32 小端字节；embedding_model 记录来源模型。
  embedding       BLOB,
  embedding_model TEXT
);
CREATE INDEX idx_chunks_doc ON document_chunks(document_id, seq);

CREATE TABLE conversation_documents (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, document_id)
);

-- ── 知识库 ───────────────────────────────────────────────────
CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE knowledge_items (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'note',  -- note | document | excerpt | research | summary
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',      -- Markdown
  summary     TEXT NOT NULL DEFAULT '',      -- AI 或手写摘要
  key_points  TEXT NOT NULL DEFAULT '[]',    -- JSON 字符串数组
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  domain_id   TEXT REFERENCES domains(id) ON DELETE SET NULL,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_kind TEXT,                          -- conversation | research | upload | manual
  source_id   TEXT,
  source_url  TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_knowledge_updated ON knowledge_items(updated_at);
CREATE INDEX idx_knowledge_category ON knowledge_items(category_id);

CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE knowledge_tags (
  item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, tag_id)
);

CREATE TABLE knowledge_links (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL DEFAULT '相关',
  created_at TEXT NOT NULL,
  UNIQUE (from_id, to_id)
);

-- 统一全文索引（trigram 分词，中英文子串匹配）。由应用层维护。
CREATE VIRTUAL TABLE search_index USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  parent_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);

-- ── 学习中心 ─────────────────────────────────────────────────
CREATE TABLE plans (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT REFERENCES domains(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  goal        TEXT NOT NULL DEFAULT '',
  roadmap     TEXT NOT NULL DEFAULT '',      -- Markdown 学习路线
  status      TEXT NOT NULL DEFAULT 'active', -- active | paused | done
  start_date  TEXT,
  target_date TEXT,
  ai_generated INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT REFERENCES plans(id) ON DELETE CASCADE,
  domain_id    TEXT REFERENCES domains(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  stage        TEXT NOT NULL DEFAULT '',
  due_date     TEXT,
  estimate_min INTEGER,
  status       TEXT NOT NULL DEFAULT 'todo',  -- todo | done
  completed_at TEXT,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_tasks_due ON tasks(due_date);
CREATE INDEX idx_tasks_plan ON tasks(plan_id, sort);

CREATE TABLE study_logs (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  domain_id  TEXT REFERENCES domains(id) ON DELETE SET NULL,
  plan_id    TEXT REFERENCES plans(id) ON DELETE SET NULL,
  minutes    INTEGER NOT NULL DEFAULT 0,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_logs_date ON study_logs(date);

CREATE TABLE reviews (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  domain_id    TEXT REFERENCES domains(id) ON DELETE SET NULL,
  plan_id      TEXT REFERENCES plans(id) ON DELETE SET NULL,
  period_start TEXT,
  period_end   TEXT,
  content      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE plan_resources (
  plan_id    TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, item_id)
);

-- ── 研究实验室 ───────────────────────────────────────────────
CREATE TABLE research_projects (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  question   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'collecting', -- collecting | analyzing | writing | done
  notes      TEXT NOT NULL DEFAULT '',
  domain_id  TEXT REFERENCES domains(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE research_sources (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,              -- 项目内稳定编号，对应引用标记 [S1]
  title        TEXT NOT NULL,
  url          TEXT NOT NULL DEFAULT '',
  author       TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'web',   -- web | document | book | paper | note
  content      TEXT NOT NULL DEFAULT '',      -- 来源原文快照，引用校验以此为准
  note         TEXT NOT NULL DEFAULT '',
  document_id  TEXT REFERENCES documents(id) ON DELETE SET NULL,
  accessed_at  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_sources_project ON research_sources(project_id, seq);

CREATE TABLE research_findings (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'note',    -- claim | viewpoint | event | note
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL DEFAULT '',        -- 时间线条目
  holder     TEXT NOT NULL DEFAULT '',        -- 观点持有者
  verdict    TEXT NOT NULL DEFAULT 'unverified', -- unverified | supported | disputed | refuted
  evidence   TEXT NOT NULL DEFAULT '[]',      -- JSON: [{source_id, seq, quote, verified}]
  ai_generated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_findings_project ON research_findings(project_id, kind);

CREATE TABLE research_reports (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  citation_check TEXT NOT NULL DEFAULT '{}',  -- JSON: 引用校验结果
  model_ref  TEXT,
  knowledge_id TEXT REFERENCES knowledge_items(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

-- ── 内容创作中心（Remo叠绘）──────────────────────────────────
CREATE TABLE content_topics (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  angle        TEXT NOT NULL DEFAULT '',      -- 切入角度 / 一句话卖点
  series       TEXT NOT NULL DEFAULT '',      -- 栏目 / 系列
  platform     TEXT NOT NULL DEFAULT '',
  format       TEXT NOT NULL DEFAULT '',      -- 视频 / 图文 / 过程分享 …
  status       TEXT NOT NULL DEFAULT 'idea',  -- idea | research | script | production | scheduled | published
  priority     INTEGER NOT NULL DEFAULT 0,
  research_id  TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  notes        TEXT NOT NULL DEFAULT '',      -- 资料与笔记
  outline      TEXT NOT NULL DEFAULT '',
  script       TEXT NOT NULL DEFAULT '',
  publish_date TEXT,
  published_url TEXT NOT NULL DEFAULT '',
  metrics      TEXT NOT NULL DEFAULT '{}',    -- JSON: {views, likes, saves, comments, shares, followers}
  retro        TEXT NOT NULL DEFAULT '',      -- 复盘
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_topics_status ON content_topics(status, updated_at);

CREATE TABLE content_refs (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT REFERENCES content_topics(id) ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',       -- 外部链接来源
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL, -- 上传的图片
  palette     TEXT NOT NULL DEFAULT '[]',     -- JSON: 手动记录的色板
  created_at  TEXT NOT NULL
);
