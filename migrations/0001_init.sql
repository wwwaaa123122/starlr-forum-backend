-- 星辰旅人论坛 · 初始数据库结构 (D1 / SQLite)
-- 原则：所有表使用稳定 ID（TEXT）、必要索引、唯一约束、外键。

PRAGMA foreign_keys = ON;

-- ============================================================
-- 用户
-- ============================================================
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- 稳定随机 ID（nanoid），JWT sub 使用此 ID
  username      TEXT NOT NULL,               -- 登录名，小写存储
  username_raw  TEXT NOT NULL,               -- 原始大小写展示名
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,               -- pbkdf2$sha256$<iter>$<salt>$<hash>
  nickname      TEXT NOT NULL,
  avatar_url    TEXT,
  bio           TEXT DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  post_count    INTEGER NOT NULL DEFAULT 0,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_users_username ON users (username);
CREATE UNIQUE INDEX idx_users_email    ON users (email);

-- ============================================================
-- Refresh Token（只存哈希；支持 Rotation / 撤销 / Replay 检测）
-- ============================================================
CREATE TABLE refresh_tokens (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL,              -- SHA-256 hex
  parent_id      TEXT REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  root_id        TEXT,                       -- Token 链根 ID（Replay 时整链撤销）
  device_info    TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT NOT NULL,
  last_used_at   TEXT,
  rotated_at     TEXT,                       -- 已被轮换的时间（旧 Token 出现即 Replay）
  replaced_by_id TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT
);
CREATE UNIQUE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_root ON refresh_tokens (root_id);

-- ============================================================
-- 分类
-- ============================================================
CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon        TEXT DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  post_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_categories_slug ON categories (slug);

-- ============================================================
-- 帖子
-- ============================================================
CREATE TABLE posts (
  id             TEXT PRIMARY KEY,
  category_id    TEXT NOT NULL REFERENCES categories(id),
  author_id      TEXT NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,              -- Markdown 原文（渲染在客户端，严格 sanitize）
  is_pinned      INTEGER NOT NULL DEFAULT 0,
  is_featured    INTEGER NOT NULL DEFAULT 0,
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT,
  deleted_by     TEXT,
  view_count     INTEGER NOT NULL DEFAULT 0,
  reply_count    INTEGER NOT NULL DEFAULT 0,
  like_count     INTEGER NOT NULL DEFAULT 0,
  favorite_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_posts_category   ON posts (category_id, is_deleted, last_reply_at DESC);
CREATE INDEX idx_posts_author     ON posts (author_id, created_at DESC);
CREATE INDEX idx_posts_latest     ON posts (is_deleted, is_pinned DESC, last_reply_at DESC);
CREATE INDEX idx_posts_created    ON posts (created_at DESC);

-- ============================================================
-- 标签
-- ============================================================
CREATE TABLE tags (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_tags_name ON tags (name);

CREATE TABLE post_tags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX idx_post_tags_tag ON post_tags (tag_id);

-- ============================================================
-- 回复
-- ============================================================
CREATE TABLE replies (
  id                TEXT PRIMARY KEY,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id         TEXT NOT NULL REFERENCES users(id),
  parent_id         TEXT REFERENCES replies(id) ON DELETE SET NULL,  -- 引用/回复某条回复
  reply_to_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,    -- 回复的用户（楼中楼）
  content           TEXT NOT NULL,
  like_count        INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  deleted_at        TEXT,
  deleted_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_replies_post ON replies (post_id, is_deleted, created_at);
CREATE INDEX idx_replies_author ON replies (author_id, created_at DESC);

-- ============================================================
-- 点赞 / 收藏（唯一约束防重复）
-- ============================================================
CREATE TABLE likes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','reply')),
  target_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX idx_likes_target ON likes (target_type, target_id);

CREATE TABLE favorites (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, post_id)
);
CREATE INDEX idx_favorites_post ON favorites (post_id);

-- ============================================================
-- 通知
-- ============================================================
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 接收者
  actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,          -- 触发者
  type       TEXT NOT NULL CHECK (type IN ('reply','reply_reply','mention','like','like_reply','favorite','system','moderation')),
  post_id    TEXT,
  reply_id   TEXT,
  content    TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notifications_user ON notifications (user_id, is_read, created_at DESC);

-- ============================================================
-- 举报
-- ============================================================
CREATE TABLE reports (
  id             TEXT PRIMARY KEY,
  reporter_id    TEXT NOT NULL REFERENCES users(id),
  target_type    TEXT NOT NULL CHECK (target_type IN ('post','reply','user')),
  target_id      TEXT NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('spam','abuse','porn','illegal','other')),
  detail         TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
  handled_by     TEXT,
  handled_at     TEXT,
  resolution_note TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reports_status ON reports (status, created_at DESC);

-- ============================================================
-- 封禁 / 禁言
-- ============================================================
CREATE TABLE bans (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('ban','mute')),
  reason     TEXT NOT NULL,
  expires_at TEXT,                            -- NULL = 永久
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  lifted_at  TEXT,
  lifted_by  TEXT
);
CREATE INDEX idx_bans_user ON bans (user_id, type);

-- ============================================================
-- 附件（R2）
-- ============================================================
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  post_id    TEXT,
  reply_id   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attachments_user ON attachments (user_id, created_at DESC);

-- ============================================================
-- 管理操作审计
-- ============================================================
CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT DEFAULT '',
  ip          TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs (action, created_at DESC);

-- ============================================================
-- OAuth / OIDC 预留（第一阶段不启用，结构先行）
-- ============================================================
CREATE TABLE oauth_clients (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL,
  client_secret_hash TEXT,
  name              TEXT NOT NULL,
  homepage_url      TEXT DEFAULT '',
  logo_url          TEXT DEFAULT '',
  redirect_uris     TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，严格匹配
  grant_types       TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  scope             TEXT NOT NULL DEFAULT 'openid profile',
  owner_id          TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_oauth_clients_client_id ON oauth_clients (client_id);

CREATE TABLE oauth_authorization_codes (
  id                      TEXT PRIMARY KEY,
  code_hash               TEXT NOT NULL,
  client_id               TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  redirect_uri            TEXT NOT NULL,
  scope                   TEXT NOT NULL DEFAULT '',
  code_challenge          TEXT,
  code_challenge_method   TEXT,
  expires_at              TEXT NOT NULL,
  used_at                 TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_oauth_codes_hash ON oauth_authorization_codes (code_hash);

CREATE TABLE oauth_consents (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '',
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  UNIQUE (user_id, client_id)
);

-- ============================================================
-- 搜索（FTS5 trigram：支持中文子串匹配；不兼容时 API 回退 LIKE）
-- ============================================================
CREATE VIRTUAL TABLE posts_fts USING fts5(
  title,
  content,
  content='posts',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER posts_fts_update AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO posts_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
