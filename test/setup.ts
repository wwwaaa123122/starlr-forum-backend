/** 测试引导：应用 D1 迁移到隔离的测试数据库 */
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
