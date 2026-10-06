-- 版块发布权限：everyone = 所有用户；staff = 仅版主及以上（公告类版块）
ALTER TABLE categories ADD COLUMN post_policy TEXT NOT NULL DEFAULT 'everyone' CHECK (post_policy IN ('everyone', 'staff'));
UPDATE categories SET post_policy = 'staff' WHERE slug = 'announcements';
