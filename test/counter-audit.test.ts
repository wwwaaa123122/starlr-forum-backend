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

  it('回复点赞只影响 replies.like_count，不污染 posts.like_count', async () => {
    const author = await createUser({ username: 'cntrlauthor' });
    const replier = await createUser({ username: 'cntrlreplier' });
    const liker = await createUser({ username: 'cntrlliker' });
    const postId = (await createPost(author.accessToken, { title: '回复点赞计数帖', content: 'x' })).body.id as string;
    const replyId = (await req<{ id: string }>(`/api/posts/${postId}/replies`, {
      method: 'POST',
      token: replier.accessToken,
      body: { content: 'x' },
    })).body.id as string;

    const like = await req<{ likeCount: number }>(`/api/replies/${replyId}/like`, { method: 'POST', token: liker.accessToken });
    expect(like.body.likeCount).toBe(1);

    const post = await env.DB.prepare(`SELECT like_count FROM posts WHERE id = ?`).bind(postId).first<{ like_count: number }>();
    expect(post?.like_count).toBe(0); // 帖子赞数不受回复点赞影响

    const unlike = await req<{ likeCount: number }>(`/api/replies/${replyId}/like`, { method: 'DELETE', token: liker.accessToken });
    expect(unlike.body.likeCount).toBe(0);
  });

  it('admin 删除再恢复帖子：categories / users 的 post_count 对称还原', async () => {
    const author = await createUser({ username: 'cntpostrestore' });
    const postId = (await createPost(author.accessToken, { title: '帖子恢复计数验证', content: 'x' })).body.id as string;
    const cat = await env.DB.prepare(`SELECT category_id FROM posts WHERE id = ?`).bind(postId).first<{ category_id: string }>();
    const beforeUser = await env.DB.prepare(`SELECT post_count FROM users WHERE id = ?`).bind(author.id).first<{ post_count: number }>();
    const beforeCat = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(cat!.category_id).first<{ post_count: number }>();

    expect((await req(`/api/admin/posts/${postId}`, { method: 'DELETE', token: adminToken })).status).toBe(200);
    expect((await req(`/api/admin/posts/${postId}/restore`, { method: 'POST', token: adminToken })).status).toBe(200);

    const afterUser = await env.DB.prepare(`SELECT post_count FROM users WHERE id = ?`).bind(author.id).first<{ post_count: number }>();
    const afterCat = await env.DB.prepare(`SELECT post_count FROM categories WHERE id = ?`).bind(cat!.category_id).first<{ post_count: number }>();
    expect(afterUser?.post_count).toBe(beforeUser?.post_count);
    expect(afterCat?.post_count).toBe(beforeCat?.post_count);
  });
});
