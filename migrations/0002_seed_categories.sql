-- 默认分类种子数据（幂等）
INSERT INTO categories (id, name, slug, description, icon, sort_order)
SELECT 'cat0welcome0000001', '站务公告', 'announcements', '论坛公告与站务讨论', '📢', 0
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'announcements');

INSERT INTO categories (id, name, slug, description, icon, sort_order)
SELECT 'cat0tech000000001', '技术分享', 'tech', '编程、架构、云计算与开发经验', '💻', 1
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'tech');

INSERT INTO categories (id, name, slug, description, icon, sort_order)
SELECT 'cat0idle000000001', '闲聊灌水', 'idle', '轻松话题，随意畅聊', '💬', 3
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'idle');

INSERT INTO categories (id, name, slug, description, icon, sort_order)
SELECT 'cat0qa0000000001', '问答求助', 'qa', '提问与互助解答', '❓', 4
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'qa');
