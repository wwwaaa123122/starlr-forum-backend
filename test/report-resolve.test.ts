/**
 * 举报处理：delete_content 动作（内容删除 + 状态流转）与 dismiss 端点。
 * mute/ban 已有覆盖（report-actions / permissions），此处不重复。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let adminToken = '';
let authorToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'rptadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='rptadmin'`).run();
  adminToken = admin.accessToken;
  const author = await createUser({ username: 'rptauthor' });
  authorToken = author.accessToken;
});

/** 举报一篇帖子 */
async function reportPost(postId: string): Promise<string> {
  const reporter = await createUser({ username: `reporter${Math.floor(Math.random() * 100000)}` });
  const res = await req<{ id: string }>('/api/reports', {
    method: 'POST',
    token: reporter.accessToken,
    body: { targetType: 'post', targetId: postId, reason: 'spam', detail: '测试举报' },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

const pendingReports = () =>
  req<{ reports: { id: string; targetId: string }[] }>('/api/admin/reports?status=pending', { token: adminToken });

describe('举报处理：delete_content', () => {
  it('删除被举报帖子：内容软删除 + 举报状态 resolved', async () => {
    const postId = (await createPost(authorToken, { title: '待删违规帖', content: '违规内容' })).body.id as string;
    const reportId = await reportPost(postId);

    const res = await req(`/api/admin/reports/${reportId}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: { action: 'delete_content', note: '确认违规' },
    });
    expect(res.status).toBe(200);

    // 帖子已软删除（作者视角 404）
    expect((await req(`/api/posts/${postId}`, { token: authorToken })).status).toBe(404);

    // 举报状态流转
    const resolved = await req<{ reports: { id: string; status: string }[] }>('/api/admin/reports?status=resolved', { token: adminToken });
    expect(resolved.body.reports.some((r) => r.id === reportId)).toBe(true);
  });

  it('重复处理同一举报：400（已处理过）', async () => {
    const postId = (await createPost(authorToken, { title: '重复处理验证帖', content: 'x' })).body.id as string;
    const reportId = await reportPost(postId);
    await req(`/api/admin/reports/${reportId}/resolve`, { method: 'POST', token: adminToken, body: { action: 'dismiss' } });
    const again = await req(`/api/admin/reports/${reportId}/resolve`, { method: 'POST', token: adminToken, body: { action: 'dismiss' } });
    expect(again.status).toBe(400);
  });

  it('不存在的举报：404', async () => {
    expect((await req('/api/admin/reports/nonexistent/resolve', { method: 'POST', token: adminToken, body: { action: 'dismiss' } })).status).toBe(404);
  });
});

describe('POST /api/admin/reports/:id/dismiss', () => {
  it('dismiss 后举报进入 dismissed 状态，内容不受影响', async () => {
    const postId = (await createPost(authorToken, { title: '误报帖', content: '正常内容' })).body.id as string;
    const reportId = await reportPost(postId);

    const res = await req(`/api/admin/reports/${reportId}/dismiss`, { method: 'POST', token: adminToken, body: {} });
    expect(res.status).toBe(200);

    const dismissed = await req<{ reports: { id: string }[] }>('/api/admin/reports?status=dismissed', { token: adminToken });
    expect(dismissed.body.reports.some((r) => r.id === reportId)).toBe(true);

    // 内容仍在（作者可见 200）
    expect((await req(`/api/posts/${postId}`, { token: authorToken })).status).toBe(200);
  });

  it('非管理员（普通用户）403', async () => {
    const postId = (await createPost(authorToken, { title: '权限验证帖', content: 'x' })).body.id as string;
    const reportId = await reportPost(postId);
    const user = await createUser({ username: 'rptuser' });
    expect((await req(`/api/admin/reports/${reportId}/dismiss`, { method: 'POST', token: user.accessToken, body: {} })).status).toBe(403);
  });
});
