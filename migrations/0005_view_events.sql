-- 浏览事件记录（管理后台「浏览统计」数据源；保留 30 天，聚合趋势由此计算）
CREATE TABLE IF NOT EXISTS view_events (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    TEXT,
  country    TEXT DEFAULT '',
  city       TEXT DEFAULT '',
  colo       TEXT DEFAULT '',
  device     TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_view_events_created ON view_events (created_at);
CREATE INDEX IF NOT EXISTS idx_view_events_post ON view_events (post_id, created_at);
