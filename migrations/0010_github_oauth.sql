-- GitHub OAuth 登录：users 表新增 github 绑定列
ALTER TABLE users ADD COLUMN github_id TEXT;
-- 仅非 NULL 唯一（SQLite 支持部分索引）
CREATE UNIQUE INDEX idx_users_github_id ON users (github_id) WHERE github_id IS NOT NULL;
