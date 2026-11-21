/**
 * 计数一致性审计：reply 删除/恢复、posts 软删的各路径计数语义。
 * 第 47 轮在 categories.post_count 抓到作者自删漏扣减（已修），
 * 本文件系统排查 reply_count 与 users.reply_count 的全部增减路径。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let adminToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'cntaudadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='cntaudadmin'`).run();
  adminToken = admin.accessToken;
});

const postCounters = (postId: string) =>
  env.DB.prepare(`SELECT reply_count, last_reply_at FROM posts WHERE id = ?`).bind(postId).first<{ reply_count: number; last_reply_at: string | null }>();
const userReplyCount = (userId: string) =>
  env.DB.prepare(`SELECT reply_count FROM users WHERE id = ?`).bind(userId).first<{ reply_count: number }>();

describe('计数一致性：reply 路径', () => {
  it('作者自删回复：post.reply_count 与 user.reply_count 同步扣减', async () => {
    const author = await createUser({ username: 'cntdelauthor' });
    const replier = await createUser({ username: 'cntdelreplier' });
    const postId = (await createPost(author.accessToken, { title: '计数验证帖', content: 'x' })).body.id as string;
    const r = (await req<{ id: string }>(`/api/posts/${postId}/replies`, { method: 'POST', token: replier.accessToken, body: { content: 'x' } })).body.id as string;

    await req(`/api/replies/${r}`, { method: 'DELETE', token: replier.accessToken });

    const p = await postCounters(postId);
    expect(p?.reply_count).toBe(0);
    expect((await userReplyCount(replier.id))?.reply_count).toBe(0);
  });

  it('admin 恢复回复：计数同步加回', async () => {
    const author = await createUser({ username: 'cntresauthor' });
    const replier = await createUser({ username: 'cntresreplier' });
    const postId = (await createPost(author.accessToken, { title: '计数验证帖', content: 'x' })).body.id as string;
    const r = (await req<{ id: string }>(`/api/posts/${postId}/replies`, { method: 'POST', token: replier.accessToken, body: { content: 'x' } })).body.id as string;
    await req(`/api/replies/${r}`, { method: 'DELETE', token: replier.accessToken });

    const restore = await req(`/api/admin/replies/${r}/restore`, { method: 'POST', token: adminToken });
    expect(restore.status).toBe(200);

    const p = await postCounters(postId);
    expect(p?.reply_count).toBe(1);
    expect((await userReplyCount(replier.id))?.reply_count).toBe(1);
  });

  it('admin 删除回复与作者自删计数语义一致', async () => {
    const author = await createUser({ username: 'cntadmauthor' });
    const replier = await createUser({ username: 'cntadmreplier' });
    const postId = (await createPost(author.accessToken, { title: '计数验证帖', content: 'x' })).body.id as string;
    const r = (await req<{ id: string }>(`/api/posts/${postId}/replies`, { method: 'POST', token: replier.accessToken, body: { content: 'x' } })).body.id as string;

    await req(`/api/admin/replies/${r}`, { method: 'DELETE', token: adminToken });
    const p = await postCounters(postId);
    expect(p?.reply_count).toBe(0);
    expect((await userReplyCount(replier.id))?.reply_count).toBe(0);
  });

  it('like 计数：点赞/取消对称（posts.like_count）', async () => {
    const author = await createUser({ username: 'cntlikeauthor' });
    const liker = await createUser({ username: 'cntlikeliker' });
    const postId = (await createPost(author.accessToken, { title: '计数验证帖', content: 'x' })).body.id as string;

    await req(`/api/posts/${postId}/like`, { method: 'POST', token: liker.accessToken });
    let row = await env.DB.prepare(`SELECT like_count FROM posts WHERE id = ?`).bind(postId).first<{ like_count: number }>();
    expect(row?.like_count).toBe(1);

    await req(`/api/posts/${postId}/like`, { method: 'DELETE', token: liker.accessToken });
    row = await env.DB.prepare(`SELECT like_count FROM posts WHERE id = ?`).bind(postId).first<{ like_count: number }>();
    expect(row?.like_count).toBe(0);
  });

  it('favorite 计数：收藏/取消对称（posts.favorite_count）', async () => {
    const author = await createUser({ username: 'cntfavauthor' });
    const favUser = await createUser({ username: 'cntfavuser' });
    const postId = (await createPost(author.accessToken, { title: '计数验证帖', content: 'x' })).body.id as string;

    await req(`/api/posts/${postId}/favorite`, { method: 'POST', token: favUser.accessToken });
    let row = await env.DB.prepare(`SELECT favorite_count FROM posts WHERE id = ?`).bind(postId).first<{ favorite_count: number }>();
    expect(row?.favorite_count).toBe(1);

    await req(`/api/posts/${postId}/favorite`, { method: 'DELETE', token: favUser.accessToken });
    row = await env.DB.prepare(`SELECT favorite_count FROM posts WHERE id = ?`).bind(postId).first<{ favorite_count: number }>();
    expect(row?.favorite_count).toBe(0);
  });
});
