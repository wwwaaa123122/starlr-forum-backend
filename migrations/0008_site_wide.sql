-- 全站版主：不受版块限制的版主（版主任命的另一种形态）
ALTER TABLE users ADD COLUMN site_wide_moderator INTEGER NOT NULL DEFAULT 0;
