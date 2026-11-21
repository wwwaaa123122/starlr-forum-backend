/**
 * 通知已读标记：单条/批量/全部读、跨用户隔离、unread-count 联动。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let authorToken = '';
let readerToken = '';
let readerId = '';
let postId = '';

beforeAll(async () => {
  const author = await createUser({ username: 'notifauthor' });
  authorToken = author.accessToken;
  const reader = await createUser({ username: 'notifreader' });
  readerToken = reader.accessToken;
  readerId = reader.id;

  // author 发帖，reader 回复触发 author 的通知；反过来 author 回复触发 reader 的通知
  const p = (await createPost(authorToken, { title: '通知测试帖' })).body.id as string;
  postId = p;
  await req(`/api/posts/${p}/replies`, {
    method: 'POST',
    token: readerToken,
    body: { content: '触发作者通知的回复 @notifauthor' },
  });
});

const unread = (token: string) => req<{ unread: number }>('/api/notifications/unread-count', { token });

describe('通知已读标记', () => {
  it('被回复后 unread-count > 0', async () => {
    const r = await unread(authorToken);
    expect(r.status).toBe(200);
    expect(r.body.unread).toBeGreaterThan(0);
  });

  it('批量标记指定 id 已读：unread 相应减少', async () => {
    const list = await req<{ notifications: { id: string; isRead: boolean }[] }>('/api/notifications', { token: authorToken });
    const unreadItems = list.body.notifications.filter((n) => !n.isRead);
    expect(unreadItems.length).toBeGreaterThan(0);
    const before = (await unread(authorToken)).body.unread;

    const res = await req('/api/notifications/read', {
      method: 'POST',
      token: authorToken,
      body: { ids: [unreadItems[0].id] },
    });
    expect(res.status).toBe(200);
    const after = (await unread(authorToken)).body.unread;
    expect(after).toBe(before - 1);
  });

  it('不带 ids = 全部已读', async () => {
    const res = await req('/api/notifications/read', { method: 'POST', token: authorToken, body: {} });
    expect(res.status).toBe(200);
    expect((await unread(authorToken)).body.unread).toBe(0);
  });

  it('跨用户隔离：无法标记别人的通知', async () => {
    // author 又有一条未读
    await req(`/api/posts/${postId}/replies`, {
      method: 'POST',
      token: readerToken,
      body: { content: '第二条通知 @notifauthor' },
    });
    const authorList = await req<{ notifications: { id: string }[] }>('/api/notifications', { token: authorToken });
    const authorUnreadId = authorList.body.notifications[0].id;
    expect(authorUnreadId).toBeTruthy();

    // reader 尝试把 author 的通知标记已读 → 影响 0 条（WHERE user_id 隔离）
    const res = await req('/api/notifications/read', { method: 'POST', token: readerToken, body: { ids: [authorUnreadId] } });
    expect(res.status).toBe(200);

    // author 的通知仍是未读
    const after = await req<{ notifications: { id: string; isRead: boolean }[] }>('/api/notifications', { token: authorToken });
    const target = after.body.notifications.find((n) => n.id === authorUnreadId);
    // isRead 序列化为 0/1 数字
    expect(Number(target?.isRead)).toBe(0);
  });

  it('read-all 幂等（无未读时再调也成功）', async () => {
    const res = await req('/api/notifications/read-all', { method: 'POST', token: authorToken });
    expect(res.status).toBe(200);
    expect((await unread(authorToken)).body.unread).toBe(0);
  });

  it('未登录 401', async () => {
    expect((await unread('invalid-token')).status).toBe(401);
  });
});
