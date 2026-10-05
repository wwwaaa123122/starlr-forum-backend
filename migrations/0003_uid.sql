-- 0003: 用户 UID（从 1 开始自增、唯一）+ 计数器表
-- 规则：存量用户按「管理员优先、其余按创建时间」分配；管理员固定为 uid=1
-- 新用户通过 counters 表原子分配（RETURNING value）

ALTER TABLE users ADD COLUMN uid INTEGER;

-- 为存量用户分配：admin 排第一（uid=1），其余按 created_at 顺序
-- （子查询包含自身，故直接用 COUNT(*) 得到 1 起始序号）
UPDATE users SET uid = (
  SELECT COUNT(*) FROM users u2
  WHERE (u2.username = 'admin') > (users.username = 'admin')
     OR ( (u2.username = 'admin') = (users.username = 'admin')
          AND (u2.created_at < users.created_at
               OR (u2.created_at = users.created_at AND u2.rowid <= users.rowid)) )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid);

-- UID 序列计数器（原子自增分配）
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT INTO counters (name, value) SELECT 'user_uid', COALESCE(MAX(uid), 0) FROM users;
