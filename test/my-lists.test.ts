/** 我的点赞 / 我的收藏 列表 */
import { describe, it, expect } from 'vitest';
import { createPost, createUser, req } from './helpers';

describe('我的点赞 / 收藏列表', () => {
  it('点赞与收藏分别出现在对应列表，且仅自己可见', async () => {
    const me = await createUser({ username: 'listme' });
    const other = await createUser({ username: 'listother' });
    const likedPost = (await createPost(other.accessToken, { title: '我点赞的帖子', content: '**正文**内容' })).body.id as string;
    const favPost = (await createPost(other.accessToken, { title: '我收藏的帖子' })).body.id as string;

    await req(`/api/posts/${likedPost}/like`, { method: 'POST', token: me.accessToken });
    await req(`/api/posts/${favPost}/favorite`, { method: 'POST', token: me.accessToken });

    const likes = await req('/api/me/likes', { token: me.accessToken });
    expect(likes.status).toBe(200);
    expect(likes.body.posts).toHaveLength(1);
    expect(likes.body.posts[0].id).toBe(likedPost);
    expect(likes.body.posts[0].title).toBe('我点赞的帖子');
    expect(likes.body.posts[0].excerpt).toContain('正文');
    expect(likes.body.posts[0].authorName).toBe('listother');
    expect(likes.body.pagination.total).toBe(1);

    const favs = await req('/api/me/favorites', { token: me.accessToken });
    expect(favs.body.posts).toHaveLength(1);
    expect(favs.body.posts[0].id).toBe(favPost);
    // 列表卡片所需字段齐全
    expect(favs.body.posts[0]).toMatchObject({ likeCount: 0, replyCount: 0, viewCount: 0 });
    expect(favs.body.posts[0].categorySlug).toBeTruthy();

    // 他人不可见
    const others = await req('/api/me/likes', { token: other.accessToken });
    expect(others.body.posts).toHaveLength(0);

    // 取消点赞后从列表移除
    await req(`/api/posts/${likedPost}/like`, { method: 'DELETE', token: me.accessToken });
    const after = await req('/api/me/likes', { token: me.accessToken });
    expect(after.body.posts).toHaveLength(0);

    // 未登录 401
    const anon = await req('/api/me/likes');
    expect(anon.status).toBe(401);
  });

  it('删除的帖子不出现在列表中', async () => {
    const me = await createUser({ username: 'listme2' });
    const author = await createUser({ username: 'listauthor2' });
    const postId = (await createPost(author.accessToken, { title: '将被删除' })).body.id as string;
    await req(`/api/posts/${postId}/like`, { method: 'POST', token: me.accessToken });
    await req(`/api/posts/${postId}`, { method: 'DELETE', token: author.accessToken });

    const likes = await req('/api/me/likes', { token: me.accessToken });
    expect(likes.body.posts).toHaveLength(0);
    expect(likes.body.pagination.total).toBe(0);
  });
});
