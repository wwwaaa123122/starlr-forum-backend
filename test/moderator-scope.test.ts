/** 版主按版块授权：帖子/评论/举报的辖区隔离，用户处置仅经辖区举报 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';

interface TestUser { id: string; accessToken: string; username: string }

async function makeModerator(username: string, categoryIds: string[]): Promise<TestUser> {
  const u = await createUser({ username });
  await env.DB.prepare(`UPDATE users SET role = 'moderator' WHERE id = ?`).bind(u.id).run();
  for (const cid of categoryIds) {
    await env.DB.prepare(`INSERT INTO moderators (user_id, category_id) VALUES (?, ?)`).bind(u.id, cid).run();
  }
  return u as TestUser;
}

async function createPostIn(token: string, categoryId: string, title: string): Promise<string> {
  const res = await req('/api/posts', { method: 'POST', token, body: { title, content: '正文', categoryId, tags: [] } });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('版主辖区权限', () => {
  it('帖子列表/操作只限所辖版；其他版 403', async () => {
    const admin = await createUser({ username: 'scopeadmin' });
    await env.DB.prepare(`UPDATE users SET role='admin' WHERE id=?`).bind(admin.id).run();
    const cats = await req('/api/categories');
    const [catA, catB] = (cats.body.categories as { id: string; name: string; postPolicy: string }[]).filter((c) => c.postPolicy === 'everyone');

    const author = await createUser({ username: 'scopeauthor' });
    const postA = await createPostIn(author.accessToken, catA.id, 'A版帖子');
    const postB = await createPostIn(author.accessToken, catB.id, 'B版帖子');

    const mod = await makeModerator('scopemod', [catA.id]);

    // 列表只见 A 版
    const list = await req('/api/admin/posts', { token: mod.accessToken });
    expect(list.status).toBe(200);
    expect(list.body.moderatorScope).toEqual([catA.id]);
    const ids = (list.body.posts as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(postA);
    expect(ids).not.toContain(postB);

    // 辖区内可置顶，辖区外 403
    const pinA = await req(`/api/admin/posts/${postA}/pin`, { method: 'POST', token: mod.accessToken });
    expect(pinA.status).toBe(200);
    const pinB = await req(`/api/admin/posts/${postB}/pin`, { method: 'POST', token: mod.accessToken });
    expect(pinB.status).toBe(403);
    expect(pinB.body.error?.message).toContain('版块');

    // 辖区内可删，辖区外不可
    const delB = await req(`/api/admin/posts/${postB}`, { method: 'DELETE', token: mod.accessToken });
    expect(delB.status).toBe(403);
    const delA = await req(`/api/admin/posts/${postA}`, { method: 'DELETE', token: mod.accessToken });
    expect(delA.status).toBe(200);

    // 管理员不受限
    const adminPin = await req(`/api/admin/posts/${postB}/pin`, { method: 'POST', token: admin.accessToken });
    expect(adminPin.status).toBe(200);
  });

  it('回复删除只限所辖版（按帖子所属版判定）', async () => {
    const cats = await req('/api/categories');
    const [catA, catB] = (cats.body.categories as { id: string; postPolicy: string }[]).filter((c) => c.postPolicy === 'everyone');
    const author = await createUser({ username: 'replyauthor' });
    const postA = await createPostIn(author.accessToken, catA.id, '回复测试A');
    const postB = await createPostIn(author.accessToken, catB.id, '回复测试B');
    const r1 = await req(`/api/posts/${postA}/replies`, { method: 'POST', token: author.accessToken, body: { content: 'A版回复' } });
    const r2 = await req(`/api/posts/${postB}/replies`, { method: 'POST', token: author.accessToken, body: { content: 'B版回复' } });

    const mod = await makeModerator('replymod', [catA.id]);
    const delB = await req(`/api/admin/replies/${r2.body.id}`, { method: 'DELETE', token: mod.accessToken });
    expect(delB.status).toBe(403);
    const delA = await req(`/api/admin/replies/${r1.body.id}`, { method: 'DELETE', token: mod.accessToken });
    expect(delA.status).toBe(200);
  });

  it('举报列表与处理只限所辖版；经举报可禁言作者；用户列表 403', async () => {
    const cats = await req('/api/categories');
    const [catA, catB] = (cats.body.categories as { id: string; postPolicy: string }[]).filter((c) => c.postPolicy === 'everyone');
    const reporter = await createUser({ username: 'rep reporter'.replace(' ', '') });
    const badA = await createUser({ username: 'baduserA' });
    const badB = await createUser({ username: 'baduserB' });
    const postA = await createPostIn(badA.accessToken, catA.id, '被举报A');
    const postB = await createPostIn(badB.accessToken, catB.id, '被举报B');
    const repA = await req('/api/reports', { method: 'POST', token: reporter.accessToken, body: { targetType: 'post', targetId: postA, reason: 'spam', detail: 'x' } });
    const repB = await req('/api/reports', { method: 'POST', token: reporter.accessToken, body: { targetType: 'post', targetId: postB, reason: 'spam', detail: 'x' } });
    expect(repA.status).toBe(201);

    const mod = await makeModerator('repmod', [catA.id]);

    // 列表只见 A 版举报
    const list = await req('/api/admin/reports?status=pending', { token: mod.accessToken });
    const ids = (list.body.reports as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(repA.body.id);
    expect(ids).not.toContain(repB.body.id);

    // 处理辖区外举报 403
    const out = await req(`/api/admin/reports/${repB.body.id}/resolve`, {
      method: 'POST', token: mod.accessToken, body: { action: 'dismiss', note: '' },
    });
    expect(out.status).toBe(403);

    // 经辖区举报禁言作者 → 成功且生效
    const mute = await req(`/api/admin/reports/${repA.body.id}/resolve`, {
      method: 'POST', token: mod.accessToken, body: { action: 'mute', note: '版规禁言测试', days: 3 },
    });
    expect(mute.status).toBe(200);
    const banned = await req(`/api/posts/${postA}/replies`, { method: 'POST', token: badA.accessToken, body: { content: '还能回复吗' } });
    expect(banned.status).toBe(403);

    // 版主不能访问用户管理列表
    const users = await req('/api/admin/users', { token: mod.accessToken });
    expect(users.status).toBe(403);
  });

  it('管理员可任命/移除版主；任命后自动升级角色并通知', async () => {
    const admin = await createUser({ username: 'assignadmin' });
    await env.DB.prepare(`UPDATE users SET role='admin' WHERE id=?`).bind(admin.id).run();
    const cats = await req('/api/categories');
    const catA = (cats.body.categories as { id: string }[])[0];
    const newbie = await createUser({ username: 'futuremod' });

    const assign = await req('/api/admin/moderators', {
      method: 'POST', token: admin.accessToken, body: { username: 'futuremod', categoryId: catA.id },
    });
    expect(assign.status).toBe(200);
    expect(assign.body.upgraded).toBe(true);
    const role = await env.DB.prepare(`SELECT role FROM users WHERE id = ?`).bind(newbie.id).first<{ role: string }>();
    expect(role?.role).toBe('moderator');

    const list = await req('/api/admin/moderators', { token: admin.accessToken });
    expect((list.body.moderators as { userId: string }[]).some((m) => m.userId === newbie.id)).toBe(true);

    const remove = await req(`/api/admin/moderators/${newbie.id}/${catA.id}`, { method: 'DELETE', token: admin.accessToken });
    expect(remove.status).toBe(200);

    // 版主无权访问版主任命接口
    const mod = await makeModerator('noassign', [catA.id]);
    const forbidden = await req('/api/admin/moderators', { token: mod.accessToken });
    expect(forbidden.status).toBe(403);
  });
});
