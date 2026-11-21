/** SEO 推送：重试 / 去重 / 429 短路 / cron 全量校验 / 后台记录查询 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { fetchMock, env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

/** 把 SEO 配置写入 KV（与 admin-services PUT /:key 相同的存储路径） */
async function setSeoConfig(cfg: Record<string, string>) {
  await env.CACHE.put('config:seo', JSON.stringify(cfg));
}

/** 注册一次百度推送拦截（返回指定状态码与响应体） */
function mockBaidu(status: number, body: Record<string, unknown>) {
  fetchMock
    .get('https://data.zz.baidu.com')
    .intercept({ method: 'POST', path: /\/urls/ })
    .reply(status, JSON.stringify(body), { headers: { 'Content-Type': 'text/plain' } });
}

let adminToken = '';

beforeEach(() => {
  // fetchMock 仅按文件重置：清掉上一用例遗留的拦截器，避免串扰
  fetchMock.deactivate();
  fetchMock.activate();
});

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const admin = await createUser({ username: 'seoadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='seoadmin'`).run();
  adminToken = admin.accessToken;
});

describe('SEO 推送（lib 级）', () => {
  it('重试成功：首次失败后续成功，attempts=2 记 ok', async () => {
    await setSeoConfig({ canonical_host: 'forum.test', baidu_push_token: 'tok' });
    mockBaidu(500, { message: 'server error' });
    mockBaidu(200, { success: 1, remain: 10 });

    const { pushPostUrl } = await import('../src/lib/seo-push');
    await pushPostUrl(env, 'post_seo_retry_ok');

    const log = await env.DB.prepare(
      `SELECT status, attempts, http_code FROM seo_push_log WHERE post_id = 'post_seo_retry_ok' AND channel = 'baidu'`,
    ).first<{ status: string; attempts: number; http_code: number | null }>();
    expect(log).not.toBeNull();
    expect(log!.status).toBe('ok');
    expect(log!.attempts).toBe(2);
    expect(log!.http_code).toBe(200);
  }, 20_000);

  it('429 限流不重试：attempts=1 直接记 failed', async () => {
    await setSeoConfig({ canonical_host: 'forum.test', baidu_push_token: 'tok' });
    mockBaidu(429, { message: 'quota' });
    // D1 不按用例重置：先清掉上次运行可能遗留的同 id 日志
    await env.DB.prepare(`DELETE FROM seo_push_log WHERE post_id = 'post_seo_429'`).run();

    const { pushPostUrl } = await import('../src/lib/seo-push');
    await pushPostUrl(env, 'post_seo_429');

    const log = await env.DB.prepare(
      `SELECT status, attempts FROM seo_push_log WHERE post_id = 'post_seo_429' AND channel = 'baidu'`,
    ).first<{ status: string; attempts: number }>();
    expect(log).not.toBeNull();
    expect(log!.status).toBe('failed');
    expect(log!.attempts).toBe(1);
  });

  it('连续失败 3 次：attempts=3 记 failed（最后一次 httpCode）', async () => {
    await setSeoConfig({ canonical_host: 'forum.test', baidu_push_token: 'tok' });
    await env.DB.prepare(`DELETE FROM seo_push_log WHERE post_id = 'post_seo_fail3'`).run();
    mockBaidu(500, { message: 'down' });
    mockBaidu(500, { message: 'down' });
    mockBaidu(503, { message: 'still down' });

    const { pushPostUrl } = await import('../src/lib/seo-push');
    await pushPostUrl(env, 'post_seo_fail3');

    const log = await env.DB.prepare(
      `SELECT status, attempts, http_code FROM seo_push_log WHERE post_id = 'post_seo_fail3' AND channel = 'baidu'`,
    ).first<{ status: string; attempts: number; http_code: number | null }>();
    expect(log).not.toBeNull();
    expect(log!.status).toBe('failed');
    expect(log!.attempts).toBe(3);
    expect(log!.http_code).toBe(503);
  }, 20_000);

  it('同 (post, channel, event) 1 小时内去重：成功后不重复推送', async () => {
    await setSeoConfig({ canonical_host: 'forum.test', baidu_push_token: 'tok' });
    await env.DB.prepare(`DELETE FROM seo_push_log WHERE post_id = 'post_seo_dedup'`).run();
    mockBaidu(200, { success: 1, remain: 10 });

    const { pushPostUrl } = await import('../src/lib/seo-push');
    await pushPostUrl(env, 'post_seo_dedup');
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM seo_push_log WHERE post_id = 'post_seo_dedup' AND channel = 'baidu' AND status = 'ok'`,
    ).first<{ n: number }>();

    await pushPostUrl(env, 'post_seo_dedup'); // 第二次应命中去重窗口，不新增日志
    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM seo_push_log WHERE post_id = 'post_seo_dedup' AND channel = 'baidu'`,
    ).first<{ n: number }>();
    expect(before!.n).toBe(1);
    expect(after!.n).toBe(1);
  });

  it('未配置任何渠道：不写日志、不报错', async () => {
    await setSeoConfig({ canonical_host: 'forum.test' });
    const { pushPostUrl } = await import('../src/lib/seo-push');
    await pushPostUrl(env, 'post_seo_nochannel');
    const row = await env.DB.prepare(`SELECT 1 FROM seo_push_log WHERE post_id = 'post_seo_nochannel'`).first();
    expect(row).toBeNull();
  });

  it('cron 全量校验：30 天内无成功记录的帖子被重推并记 cron 日志', async () => {
    await setSeoConfig({ canonical_host: 'forum.test', baidu_push_token: 'tok' });
    // 真实建一帖（pushAllPosts 只处理 posts 表里的帖子）
    const author = await createUser({ username: 'seocronauthor' });
    await createPost(author.accessToken, { title: 'cron 校验测试帖' });
    // 清掉所有日志 → 该帖进入待推送集合
    await env.DB.prepare(`DELETE FROM seo_push_log`).run();
    mockBaidu(200, { success: 5, remain: 50 });

    const { pushAllPosts } = await import('../src/lib/seo-push');
    const n = await pushAllPosts(env);
    expect(n).toBeGreaterThanOrEqual(1);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM seo_push_log WHERE event = 'cron' AND channel = 'baidu' AND status = 'ok'`,
    ).first<{ n: number }>();
    expect(rows!.n).toBe(n);
  });

  it('删除帖子：IndexNow 通知 + 百度记人工处理日志', async () => {
    await setSeoConfig({ canonical_host: 'forum.test', indexnow_key: 'test-key-1234567890abcdef', baidu_push_token: 'tok' });
    await env.DB.prepare(`DELETE FROM seo_push_log WHERE post_id = 'post_seo_delete'`).run();
    fetchMock
      .get('https://api.indexnow.org')
      .intercept({ method: 'GET', path: /\/indexnow/ })
      .reply(200, '');

    const { removePostUrl } = await import('../src/lib/seo-push');
    await removePostUrl(env, 'post_seo_delete');

    const idx = await env.DB.prepare(
      `SELECT status FROM seo_push_log WHERE post_id = 'post_seo_delete' AND channel = 'indexnow' AND event = 'delete'`,
    ).first<{ status: string }>();
    const baidu = await env.DB.prepare(
      `SELECT status, message FROM seo_push_log WHERE post_id = 'post_seo_delete' AND channel = 'baidu' AND event = 'delete'`,
    ).first<{ status: string; message: string }>();
    expect(idx!.status).toBe('ok');
    expect(baidu!.status).toBe('failed'); // 百度无删除接口：引导人工处理
    expect(baidu!.message).toContain('百度站长平台');
  });
});

describe('SEO 推送（HTTP 层）', () => {
  it('后台推送记录接口返回日志与统计', async () => {
    const res = await req('/api/admin/seo-pushes', { token: adminToken });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(Array.isArray(res.body.stats)).toBe(true);
  });

  it('非管理员无权访问推送记录与重试', async () => {
    const user = await createUser({ username: 'seouser5' });
    expect((await req('/api/admin/seo-pushes', { token: user.accessToken })).status).toBe(403);
    expect((await req('/api/admin/seo-pushes/whatever/retry', { method: 'POST', token: user.accessToken })).status).toBe(403);
  });

  it('重试端点：不存在的帖子返回 404', async () => {
    const res = await req('/api/admin/seo-pushes/nonexistent_id/retry', { method: 'POST', token: adminToken });
    expect(res.status).toBe(404);
  });
});
