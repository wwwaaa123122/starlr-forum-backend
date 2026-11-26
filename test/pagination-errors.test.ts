/**
 * 分页参数校验：非法 page/pageSize 必须返回 400 VALIDATION_ERROR，
 * 而不是让 ZodError 冒到 onError 变成 500（历史问题：6 处直接用 schema.parse）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createPost, createUser, req } from './helpers';

let authorToken = '';
let username = '';
let postId = '';

beforeAll(async () => {
  const author = await createUser({ username: 'pageauthor' });
  authorToken = author.accessToken;
  username = author.username;
  postId = (await createPost(authorToken, { title: '分页校验帖', content: 'x' })).body.id as string;
});

describe('分页参数非法时返回 400', () => {
  it('回复列表 page=abc', async () => {
    const res = await req(`/api/posts/${postId}/replies?page=abc`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('用户帖子 page=0', async () => {
    const res = await req(`/api/users/${username}/posts?page=0`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('用户喜欢列表 pageSize 超上限（本人可见时进入分页校验）', async () => {
    const res = await req(`/api/users/${username}/likes?pageSize=9999`, { token: authorToken });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('我的收藏 page 超上限', async () => {
    const res = await req('/api/me/favorites?page=99999', { token: authorToken });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('我的点赞 page=1.5', async () => {
    const res = await req('/api/me/likes?page=1.5', { token: authorToken });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
