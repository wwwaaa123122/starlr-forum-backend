/** @ 提及：昵称/用户名匹配、通知、用户搜索、个人主页昵称直达 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

describe('@ 提及', () => {
  it('用昵称 @ 用户：通知送达，主页可用昵称访问，搜索可命中', async () => {
    const author = await createUser({ username: 'mentionauthor', nickname: '夜航星' });
    const target = await createUser({ username: 'mentiontarget', nickname: '拼图者' });

    // 用昵称提及（大小写混合）
    const postId = (await createPost(author.accessToken, { title: '提及测试' })).body.id as string;
    const reply = await req(`/api/posts/${postId}/replies`, {
      method: 'POST',
      token: author.accessToken,
      body: { content: '你好 @拼图者 ，看一下这个帖子' },
    });
    expect(reply.status).toBe(201);

    // 提及通知送达（按昵称匹配）
    const notifs = await req('/api/notifications', { token: target.accessToken });
    const mention = (notifs.body.notifications as Array<Record<string, unknown>>).find((n) => n.type === 'mention');
    expect(mention).toBeTruthy();

    // 用户名提及（大写）同样送达
    const reply2 = await req(`/api/posts/${postId}/replies`, {
      method: 'POST',
      token: author.accessToken,
      body: { content: 'cc @MentionTarget 收到请回答' },
    });
    expect(reply2.status).toBe(201);
    const notifs2 = await req('/api/notifications', { token: target.accessToken });
    expect((notifs2.body.notifications as Array<Record<string, unknown>>).filter((n) => n.type === 'mention').length).toBeGreaterThanOrEqual(2);

    // 昵称直达个人主页
    const profile = await req(`/api/users/${encodeURIComponent('拼图者')}`);
    expect(profile.status).toBe(200);
    expect(profile.body.user.username).toBe('mentiontarget');

    // 搜索补全：昵称与用户名都能搜到
    const byNickname = await req('/api/users/search?q=' + encodeURIComponent('拼图'));
    expect(byNickname.body.users.some((u: { username: string }) => u.username === 'mentiontarget')).toBe(true);
    const byName = await req('/api/users/search?q=mentiont');
    expect(byName.body.users.some((u: { username: string }) => u.username === 'mentiontarget')).toBe(true);

    // 自己 @ 自己不产生通知
    const before = await req('/api/notifications', { token: author.accessToken });
    const selfCount = (before.body.notifications as Array<Record<string, unknown>>).filter((n) => n.type === 'mention').length;
    await req(`/api/posts/${postId}/replies`, {
      method: 'POST',
      token: author.accessToken,
      body: { content: '我自己 @夜航星 ' },
    });
    const after = await req('/api/notifications', { token: author.accessToken });
    const selfAfter = (after.body.notifications as Array<Record<string, unknown>>).filter((n) => n.type === 'mention').length;
    expect(selfAfter).toBe(selfCount);

    void env;
  });
});
