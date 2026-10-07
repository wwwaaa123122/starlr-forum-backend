-- 0009: 个人资料偏好
-- 1) likes_public：喜欢（点赞列表）是否公开（0 = 仅自己可见，默认）
-- 2) background_url：主页背景图（经 /api/upload purpose=background 上传）
ALTER TABLE users ADD COLUMN likes_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN background_url TEXT;
