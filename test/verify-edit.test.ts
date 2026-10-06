/**
 * 邮箱验证流程 + 编辑标记（已编辑）+ 点赞 liked 字段 测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';
import { __clearMailOutbox, __getMailOutbox } from '../src/lib/mail';

function tokenFromLatestMail(): string {
  const mail = __getMailOutbox().at(-1);
  const m = /verify-email\?token=([a-f0-9]+)/.exec(mail?.html ?? '');
  if (!m) throw new Error('激活邮件中未找到 token');
  return m[1];
}

beforeEach(() => {
  __clearMailOutbox();
});

describe('邮箱验证', () => {
  it('新注册账号为未验证：不能发帖，验证后可发帖', async () => {
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'unv1', email: `unv1_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@test.local`, password: 'VerifyPass2026!', nickname: '待验证' },
    });
    if (res.status !== 201) console.log('register failed:', JSON.stringify(res.body));
    expect(res.status).toBe(201);
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.user.accountStatus).toBe('unverified');
    const token = res.body.accessToken as string;

    // 未验证：可以浏览/看自己资料，但不能发帖
    const me = await req('/api/me', { token });
    expect(me.body.user.accountStatus).toBe('unverified');
    const cat = (await req<{ categories: { id: string; slug: string }[] }>('/api/categories')).body.categories.find((x) => x.slug === 'tech')!.id;
    const post = await req('/api/posts', {
      method: 'POST',
      token,
      body: { title: '未验证不该能发帖', content: '内容内容', categoryId: cat },
    });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    // 通过邮件里的激活链接完成验证
    const verifyToken = tokenFromLatestMail();
    const ok = await req('/api/auth/verify-email', { method: 'POST', body: { token: verifyToken } });
    expect(ok.status).toBe(200);
    expect(ok.body.verified).toBe(true);

    const after = await req('/api/me', { token });
    expect(after.body.user.accountStatus).toBe('active');

    const post2 = await req('/api/posts', {
      method: 'POST',
      token,
      body: { title: '验证之后可以发帖了', content: '内容内容', categoryId: cat },
    });
    expect(post2.status).toBe(201);

    // 令牌一次性：再次使用失败
    const reuse = await req('/api/auth/verify-email', { method: 'POST', body: { token: verifyToken } });
    expect(reuse.status).toBe(400);
  });

  it('重新发送验证邮件：验证后提示已验证', async () => {
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'unverified2', email: 'unverified2@test.local', password: 'VerifyPass2026!', nickname: '待验证2' },
    });
    const token = res.body.accessToken as string;

    __clearMailOutbox();
    const resend = await req('/api/auth/resend-verification', { method: 'POST', token });
    expect(resend.status).toBe(200);
    expect(resend.body.sent).toBe(true);
    expect(__getMailOutbox()).toHaveLength(1);

    await req('/api/auth/verify-email', { method: 'POST', body: { token: tokenFromLatestMail() } });
    // 新增的 60 秒冷却：清除冷却键后再测「已验证」分支
    const uid = await (env as unknown as { DB: D1Database }).DB
      .prepare(`SELECT id FROM users WHERE username = 'unverified2'`)
      .first<{ id: string }>();
    await (env as unknown as { CACHE: KVNamespace }).CACHE.delete(`rv-cd:${uid!.id}`);
    const again = await req('/api/auth/resend-verification', { method: 'POST', token });
    expect(again.body.alreadyVerified).toBe(true);
  });

  it('管理员可手动激活用户', async () => {
    const admin = await createUser({ username: 'verifyadmin' });
    await (env as unknown as { DB: D1Database }).DB.prepare(`UPDATE users SET role='admin' WHERE username='verifyadmin'`).run();
    const target = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'manualactivate', email: `manual_${Date.now()}@test.local`, password: 'VerifyPass2026!' },
    });
    expect(target.status).toBe(201);
    const row = await (env as unknown as { DB: D1Database }).DB.prepare(
      `SELECT id FROM users WHERE username = 'manualactivate'`,
    ).first<{ id: string }>();

    const res = await req(`/api/admin/users/${row!.id}/verify`, { method: 'POST', token: admin.accessToken });
    expect(res.status).toBe(200);
    const after = await req('/api/me', { token: target.body.accessToken as string });
    expect(after.body.user.accountStatus).toBe('active');
  });
});

describe('编辑标记「已编辑」', () => {
  it('帖子编辑后返回 editedAt', async () => {
    const user = await createUser({ username: 'editpostuser' });
    const postId = (await createPost(user.accessToken, { title: '原始标题' })).body.id as string;

    const before = await req(`/api/posts/${postId}`);
    expect(before.body.post.editedAt ?? null).toBeNull();

    const edited = await req(`/api/posts/${postId}`, {
      method: 'PATCH',
      token: user.accessToken,
      body: { title: '修改后的标题' },
    });
    expect(edited.status).toBe(200);

    const after = await req(`/api/posts/${postId}`);
    expect(after.body.post.editedAt).toBeTruthy();
    expect(after.body.post.title).toBe('修改后的标题');
  });

  it('回复编辑后列表返回 editedAt，并带 liked 字段', async () => {
    const author = await createUser({ username: 'editreplyauthor' });
    const other = await createUser({ username: 'editreplyother' });
    const postId = (await createPost(author.accessToken, { title: '回复编辑测试' })).body.id as string;

    const replyRes = await req(`/api/posts/${postId}/replies`, {
      method: 'POST',
      token: other.accessToken,
      body: { content: '原始回复内容' },
    });
    expect(replyRes.status).toBe(201);
    const replyId = replyRes.body.id as string;

    // 未登录：liked 为 false
    const anon = await req(`/api/posts/${postId}/replies`);
    expect(anon.body.replies[0].liked).toBe(0);

    // 点赞后 liked 为 1，且重复点赞幂等（计数不变）
    await req(`/api/replies/${replyId}/like`, { method: 'POST', token: author.accessToken });
    const liked = await req(`/api/posts/${postId}/replies`, { token: author.accessToken });
    expect(liked.body.replies[0].liked).toBe(1);
    expect(liked.body.replies[0].likeCount).toBe(1);

    const again = await req(`/api/replies/${replyId}/like`, { method: 'POST', token: author.accessToken });
    expect(again.body.likeCount).toBe(1);

    // 编辑回复 → 出现 editedAt
    const edited = await req(`/api/replies/${replyId}`, {
      method: 'PATCH',
      token: other.accessToken,
      body: { content: '修改后的回复内容' },
    });
    expect(edited.status).toBe(200);
    const after = await req(`/api/posts/${postId}/replies`, { token: author.accessToken });
    expect(after.body.replies[0].editedAt).toBeTruthy();
  });
});
