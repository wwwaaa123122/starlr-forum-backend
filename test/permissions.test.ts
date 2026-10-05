/**
 * 权限与越权（IDOR）测试
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, createPost, req } from './helpers';

async function makeAdmin(role: 'admin' | 'moderator' = 'admin') {
  const user = await createUser({ username: `${role}${Math.random().toString(36).slice(2, 7)}` });
  await (env.DB as unknown as D1Database).prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, user.id).run();
  return user;
}

describe('管理员 API 权限', () => {
  it('普通用户访问管理 API → 403', async () => {
    const user = await createUser({ username: 'plainuser' });
    for (const path of [
      '/api/admin/stats',
      '/api/admin/users',
      '/api/admin/posts',
      '/api/admin/reports',
      '/api/admin/audit-logs',
    ]) {
      const res = await req(path, { token: user.accessToken });
      expect(res.status, `${path} 应返回 403`).toBe(403);
    }
  });

  it('未登录访问管理 API → 401', async () => {
    const res = await req('/api/admin/stats');
    expect(res.status).toBe(401);
  });

  it('版主可以处理举报与帖子，但不能改角色/看审计日志', async () => {
    const mod = await makeAdmin('moderator');
    expect((await req('/api/admin/posts', { token: mod.accessToken })).status).toBe(200);
    expect((await req('/api/admin/reports', { token: mod.accessToken })).status).toBe(200);
    // 仅管理员
    expect((await req('/api/admin/audit-logs', { token: mod.accessToken })).status).toBe(403);
    expect(
      (
        await req(`/api/admin/users/${mod.id}/role`, {
          method: 'PATCH',
          token: mod.accessToken,
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(403);
  });

  it('管理员可以封禁用户，被禁用户的 Access Token 立即失效', async () => {
    const admin = await makeAdmin();
    const victim = await createUser({ username: 'victimuser' });

    const ban = await req(`/api/admin/users/${victim.id}/ban`, {
      method: 'POST',
      token: admin.accessToken,
      body: { reason: '违反社区规则', days: 7 },
    });
    expect(ban.status).toBe(200);

    // 用户状态即时校验（不等 Token 过期）
    const me = await req('/api/me', { token: victim.accessToken });
    expect(me.status).toBe(403);

    // Refresh Token 也被撤销
    const refresh = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: victim.refreshToken } });
    expect(refresh.status).toBe(401);

    // 无法再登录
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { identifier: victim.username, password: victim.password },
    });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_BANNED');
  });

  it('管理员不能封禁自己', async () => {
    const admin = await makeAdmin();
    const res = await req(`/api/admin/users/${admin.id}/ban`, {
      method: 'POST',
      token: admin.accessToken,
      body: { reason: 'x' },
    });
    expect(res.status).toBe(400);
  });

  it('禁言用户：可以浏览，但不能发帖/回复', async () => {
    const admin = await makeAdmin();
    const user = await createUser({ username: 'muteduser' });
    const mute = await req(`/api/admin/users/${user.id}/mute`, {
      method: 'POST',
      token: admin.accessToken,
      body: { reason: '刷屏', days: 1 },
    });
    expect(mute.status).toBe(200);

    const post = await createPost(user.accessToken);
    expect(post.status).toBe(403);
    expect((post.body as { error?: { message?: string } }).error?.message).toContain('禁言');

    const list = await req('/api/posts');
    expect(list.status).toBe(200);
  });
});

describe('越权访问（IDOR）', () => {
  it('不能删除他人的回复', async () => {
    const author = await createUser({ username: 'idorpost' });
    const victim = await createUser({ username: 'idorvictim' });
    const attacker = await createUser({ username: 'idorattacker' });
    const { id } = (await createPost(author.accessToken)).body;
    const reply = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: victim.accessToken,
      body: { content: '受害者的回复' },
    });

    const res = await req(`/api/replies/${reply.body.id}`, { method: 'DELETE', token: attacker.accessToken });
    expect(res.status).toBe(403);
  });

  it('不能修改他人的回复', async () => {
    const author = await createUser({ username: 'idorpost2' });
    const victim = await createUser({ username: 'idorvictim2' });
    const attacker = await createUser({ username: 'idorattacker2' });
    const { id } = (await createPost(author.accessToken)).body;
    const reply = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: victim.accessToken,
      body: { content: '原始回复' },
    });
    const res = await req(`/api/replies/${reply.body.id}`, {
      method: 'PATCH',
      token: attacker.accessToken,
      body: { content: '被篡改的回复' },
    });
    expect(res.status).toBe(403);
  });

  it('不能通过引用他人帖子下的回复跨帖引用（IDOR）', async () => {
    const author = await createUser({ username: 'crosspost' });
    const other = await createUser({ username: 'crossother' });
    const postA = (await createPost(author.accessToken)).body.id;
    const postB = (await createPost(author.accessToken)).body.id;
    const replyA = await req(`/api/posts/${postA}/replies`, {
      method: 'POST',
      token: author.accessToken,
      body: { content: 'A 的回复' },
    });
    // 在 B 帖中引用 A 帖的回复 → 必须被拒绝
    const res = await req(`/api/posts/${postB}/replies`, {
      method: 'POST',
      token: other.accessToken,
      body: { content: '跨帖引用', parentReplyId: replyA.body.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REPLY_NOT_FOUND');
  });

  it('不能修改自己的帖子为不存在的分类', async () => {
    const author = await createUser({ username: 'badcatpatch' });
    const { id } = (await createPost(author.accessToken)).body;
    const res = await req(`/api/posts/${id}`, {
      method: 'PATCH',
      token: author.accessToken,
      body: { categoryId: 'nope' },
    });
    expect(res.status).toBe(400);
  });

  it('普通用户不能调用管理端置顶/加精', async () => {
    const author = await createUser({ username: 'pinattempt' });
    const { id } = (await createPost(author.accessToken)).body;
    expect((await req(`/api/admin/posts/${id}/pin`, { method: 'POST', token: author.accessToken })).status).toBe(403);
    expect((await req(`/api/admin/posts/${id}/feature`, { method: 'POST', token: author.accessToken })).status).toBe(403);
    expect((await req(`/api/admin/posts/${id}`, { method: 'DELETE', token: author.accessToken })).status).toBe(403);
  });

  it('普通用户不能创建/删除分类', async () => {
    const user = await createUser({ username: 'catattacker' });
    const create = await req('/api/admin/categories', {
      method: 'POST',
      token: user.accessToken,
      body: { name: '恶意分类', slug: 'evil-cat' },
    });
    expect(create.status).toBe(403);
    const del = await req('/api/admin/categories/cat0tech000000001', { method: 'DELETE', token: user.accessToken });
    expect(del.status).toBe(403);
  });

  it('管理操作写入审计日志', async () => {
    const admin = await makeAdmin();
    const target = await createUser({ username: 'audittarget' });
    await req(`/api/admin/users/${target.id}/mute`, {
      method: 'POST',
      token: admin.accessToken,
      body: { reason: '审计测试', days: 1 },
    });
    const logs = await req('/api/admin/audit-logs?pageSize=50', { token: admin.accessToken });
    const entry = logs.body.logs.find((l: { action: string; targetId: string }) => l.action === 'admin.user.mute' && l.targetId === target.id);
    expect(entry).toBeTruthy();
    expect(entry.actorName).toBeTruthy();
  });
});

describe('管理端内容管理', () => {
  it('版主删除帖子后可恢复', async () => {
    const mod = await makeAdmin('moderator');
    const author = await createUser({ username: 'restoreauthor' });
    const { id } = (await createPost(author.accessToken)).body;

    expect((await req(`/api/admin/posts/${id}`, { method: 'DELETE', token: mod.accessToken })).status).toBe(200);
    let detail = await req(`/api/posts/${id}`, { token: mod.accessToken });
    expect(detail.body.post.isDeleted).toBe(true);
    // 作者本人仍可看到自己的已删除帖子，其他游客看不到
    expect((await req(`/api/posts/${id}`)).status).toBe(404);

    expect((await req(`/api/admin/posts/${id}/restore`, { method: 'POST', token: mod.accessToken })).status).toBe(200);
    detail = await req(`/api/posts/${id}`);
    expect(detail.status).toBe(200);
  });

  it('置顶与加精生效', async () => {
    const mod = await makeAdmin('moderator');
    const author = await createUser({ username: 'featureauthor' });
    const { id } = (await createPost(author.accessToken)).body;
    await req(`/api/admin/posts/${id}/pin`, { method: 'POST', token: mod.accessToken });
    await req(`/api/admin/posts/${id}/feature`, { method: 'POST', token: mod.accessToken });
    const detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.isPinned).toBe(1);
    expect(detail.body.post.isFeatured).toBe(1);
  });

  it('删除回复会回收计数', async () => {
    const mod = await makeAdmin('moderator');
    const author = await createUser({ username: 'replydelauthor' });
    const commenter = await createUser({ username: 'replydelcommenter' });
    const { id } = (await createPost(author.accessToken)).body;
    const reply = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: commenter.accessToken,
      body: { content: '待删除' },
    });
    await req(`/api/admin/replies/${reply.body.id}`, { method: 'DELETE', token: mod.accessToken });
    const detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.replyCount).toBe(0);
  });
});
