import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env } from '../src/types';

declare module 'cloudflare:test' {
  /** 测试环境注入的绑定（含迁移数据） */
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
