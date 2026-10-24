-- 搜索引擎推送记录（后台「推送记录」页数据源；90 天前的记录自动清理）
CREATE TABLE IF NOT EXISTS seo_push_log (
  id            TEXT PRIMARY KEY,
  post_id       TEXT NOT NULL,
  url           TEXT NOT NULL,
  channel       TEXT NOT NULL,             -- baidu | indexnow
  event         TEXT NOT NULL DEFAULT 'create', -- create | edit | delete | retry | cron
  status        TEXT NOT NULL,             -- ok | failed
  http_code     INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 1,
  message       TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_seo_push_post ON seo_push_log (post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_seo_push_created ON seo_push_log (created_at);
