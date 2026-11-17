-- 复习卡片（间隔重复）。一张卡片 = 一个问题 + 答案，按记忆情况安排下次复习日期。

CREATE TABLE cards (
  id            TEXT PRIMARY KEY,
  front         TEXT NOT NULL,               -- 问题 / 提示
  back          TEXT NOT NULL DEFAULT '',    -- 答案
  domain_id     TEXT REFERENCES domains(id) ON DELETE SET NULL,
  knowledge_id  TEXT REFERENCES knowledge_items(id) ON DELETE SET NULL, -- 出自哪条知识
  ai_generated  INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT NOT NULL,               -- 下次复习日期 YYYY-MM-DD
  interval_days INTEGER NOT NULL DEFAULT 0,  -- 当前间隔
  ease          REAL NOT NULL DEFAULT 2.5,   -- 难度系数，越大间隔增长越快
  reps          INTEGER NOT NULL DEFAULT 0,  -- 连续记住的次数
  lapses        INTEGER NOT NULL DEFAULT 0,  -- 忘记的次数
  suspended     INTEGER NOT NULL DEFAULT 0,  -- 暂停复习
  last_reviewed_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_cards_due ON cards(suspended, due_date);
CREATE INDEX idx_cards_knowledge ON cards(knowledge_id);

CREATE TABLE card_reviews (
  id            TEXT PRIMARY KEY,
  card_id       TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  rating        TEXT NOT NULL,               -- again | hard | good | easy
  interval_days INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_card_reviews_date ON card_reviews(date);
