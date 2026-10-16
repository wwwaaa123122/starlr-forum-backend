/**
 * /api/app/* — Android 客户端版本信息（启动静默更新检测）
 *
 * 版本数据存 KV `config:app`（无需重新部署即可发版提示）：
 *   {"versionCode":11,"versionName":"0.1.10","hash":"<git短哈希>","notes":"更新说明","url":"下载页地址"}
 *
 * 未配置或数据损坏时返回 versionCode: 0（客户端视为无更新），接口永不报错。
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { ok } from '../lib/http';

const app = new Hono<AppEnv>();

const APP_KV_KEY = 'config:app';

app.get('/latest', async (c) => {
  try {
    const raw = await c.env.CACHE.get(APP_KV_KEY);
    if (!raw) return ok(c, { versionCode: 0 });
    const d = JSON.parse(raw) as {
      versionCode?: unknown;
      versionName?: unknown;
      hash?: unknown;
      notes?: unknown;
      url?: unknown;
    };
    return ok(c, {
      versionCode: typeof d.versionCode === 'number' && d.versionCode > 0 ? d.versionCode : 0,
      versionName: typeof d.versionName === 'string' ? d.versionName : '',
      hash: typeof d.hash === 'string' ? d.hash : '',
      notes: typeof d.notes === 'string' ? d.notes : '',
      url: typeof d.url === 'string' ? d.url : '',
    });
  } catch {
    return ok(c, { versionCode: 0 });
  }
});

export default app;
