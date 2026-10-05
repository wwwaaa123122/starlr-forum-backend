/** 举报处理：带出原内容 + 四种处理动作（无违规/禁言/封禁/删除内容），处理后原内容仍可查看 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

async function makeAdmin(name: string) {
  const u = await createUser({ username: name });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE id=?`).bind(u.id).run();
  return u;
}

describe('举报处理', () => {
  it('举报列表返回被举报内容与作者，处理后原内容仍可见', async () => {
    const admin = await makeAdmin('rptadmin1');
    const author = await createUser({ username: 'rptauthor' });
    const reporter = await createUser({ username: 'rptreporter' });
    const { id } = (await createPost(author.accessToken, { title: '被举报的帖子', content: '违规内容正文' })).body;

    const rep = await req('/api/reports', {
      method: 'POST',
      token: reporter.accessToken,
      body: { targetType: 'post', targetId: id, reason: 'spam', detail: '这是广告' },
    });
    expect(rep.status).toBe(201);

    const list = await req('/api/admin/reports?status=pending', { token: admin.accessToken });
    const row = list.body.reports.find((r: { id: string }) => r.id === rep.body.id);
    expect(row.targetTitle).toBe('被举报的帖子');
    expect(row.targetContent).toContain('违规内容正文');
    expect(row.targetAuthorName).toBe('rptauthor');
    expect(row.targetDeleted).toBe(0);

    // 删除内容处理
    const res = await req(`/api/admin/reports/${rep.body.id}/resolve`, {
      method: 'POST',
      token: admin.accessToken,
      body: { action: 'delete_content', note: '确认广告' },
    });
    expect(res.status).toBe(200);

    // 报告已处理且原内容仍可在举报列表中查看（软删除）
    const after = await req('/api/admin/reports?status=resolved', { token: admin.accessToken });
    const row2 = after.body.reports.find((r: { id: string }) => r.id === rep.body.id);
    expect(row2.status).toBe('resolved');
    expect(row2.resolutionNote).toContain('删除内容');
    expect(row2.targetTitle).toBe('被举报的帖子');
    expect(row2.targetDeleted).toBe(1);
  });

  it('禁言动作：作者被禁言（自定义天数），无违规则关闭举报', async () => {
    const admin = await makeAdmin('rptadmin2');
    const author = await createUser({ username: 'rptauthor2' });
    const reporter = await createUser({ username: 'rptreporter2' });
    const { id } = (await createPost(author.accessToken)).body;
    const rep = await req('/api/reports', {
      method: 'POST',
      token: reporter.accessToken,
      body: { targetType: 'post', targetId: id, reason: 'abuse', detail: '' },
    });

    const res = await req(`/api/admin/reports/${rep.body.id}/resolve`, {
      method: 'POST',
      token: admin.accessToken,
      body: { action: 'mute', days: 5, note: '辱骂他人' },
    });
    expect(res.status).toBe(200);

    // 作者确实被禁言 5 天：不能回复
    const reply = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: author.accessToken,
      body: { content: '被禁言后尝试回复' },
    });
    expect(reply.status).toBe(403);

    const dismissed = await req(`/api/admin/reports?status=resolved`, { token: admin.accessToken });
    const row = dismissed.body.reports.find((r: { id: string }) => r.id === rep.body.id);
    expect(row.resolutionNote).toContain('禁言 5 天');
  });

  it('无违规（dismiss）：状态为已关闭，内容不受影响', async () => {
    const admin = await makeAdmin('rptadmin3');
    const author = await createUser({ username: 'rptauthor3' });
    const reporter = await createUser({ username: 'rptreporter3' });
    const { id } = (await createPost(author.accessToken)).body;
    const rep = await req('/api/reports', {
      method: 'POST',
      token: reporter.accessToken,
      body: { targetType: 'post', targetId: id, reason: 'other', detail: '误报' },
    });
    const res = await req(`/api/admin/reports/${rep.body.id}/resolve`, {
      method: 'POST',
      token: admin.accessToken,
      body: { action: 'dismiss', note: '内容无违规' },
    });
    expect(res.status).toBe(200);
    const list = await req('/api/admin/reports?status=dismissed', { token: admin.accessToken });
    const row = list.body.reports.find((r: { id: string }) => r.id === rep.body.id);
    expect(row.status).toBe('dismissed');
    expect(row.targetDeleted).toBe(0);
  });
});
