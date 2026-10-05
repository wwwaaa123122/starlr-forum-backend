-- 0004: 编辑标记 + 邮箱验证状态
-- edited_at：帖子/回复被作者编辑的时间（前端显示「已编辑」）
-- email_verified：邮箱验证状态（1=已验证；存量用户默认已验证，新注册用户为 0）
ALTER TABLE posts ADD COLUMN edited_at TEXT;
ALTER TABLE replies ADD COLUMN edited_at TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;
