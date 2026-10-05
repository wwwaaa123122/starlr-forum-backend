/**
 * 管理后台通知广播 + 分类图标（emoji / 图片 URL）测试
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';
import app from '../src/index';
import type { Env } from '../src/types';

const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function makeAdmin(username: string) {
  const user = await createUser({ username });
  // 直接提权（跳过按 UID 授权流程，聚焦通知逻辑）
  await (env as unknown as { DB: { prepare: (q: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } } })
    .DB.prepare(`UPDATE users SET role = 'admin' WHERE username = ?`)
    .bind(username)
    .run();
  return user;
}

describe('管理后台发送通知', () => {
  it('广播给全部用户（每人一条 system 通知）', async () => {
    const admin = await makeAdmin('notifyadmin');
    const u1 = await createUser({ username: 'notifyu1' });
    const u2 = await createUser({ username: 'notifyu2' });

    const res = await req('/api/admin/notifications', {
      method: 'POST',
      token: admin.accessToken,
      body: { title: '停机维护', body: '今晚 02:00–03:00 例行维护', link: '/categories/announcements', target: 'all' },
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBeGreaterThanOrEqual(3);

    for (const u of [u1, u2]) {
      const list = await req('/api/notifications', { token: u.accessToken });
      const sys = (list.body.notifications as Array<Record<string, unknown>>).find((n) => n.type === 'system');
      expect(sys).toBeTruthy();
      const payload = JSON.parse(String(sys!.content)) as { title: string; body: string; link: string };
      expect(payload.title).toBe('停机维护');
      expect(payload.link).toBe('/categories/announcements');
      expect(sys!.isRead).toBe(0);
    }
  });

  it('定向发给指定 UID，只有该用户收到', async () => {
    const admin = await makeAdmin('notifyadmin2');
    const target = await createUser({ username: 'notifytarget' });
    const other = await createUser({ username: 'notifyother' });

    const res = await req('/api/admin/notifications', {
      method: 'POST',
      token: admin.accessToken,
      body: { title: '你好呀', body: '这是一条私信通知', target: target.uid },
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);

    const mine = await req('/api/notifications', { token: target.accessToken });
    expect((mine.body.notifications as Array<Record<string, unknown>>).some((n) => n.type === 'system')).toBe(true);
    const others = await req('/api/notifications', { token: other.accessToken });
    expect((others.body.notifications as Array<Record<string, unknown>>).some((n) => n.type === 'system')).toBe(false);
  });

  it('无效 UID 返回 404；版主无权发送；非法链接被拒绝', async () => {
    const admin = await makeAdmin('notifyadmin3');
    const mod = await createUser({ username: 'notifymod' });
    await (env as unknown as { DB: { prepare: (q: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } } })
      .DB.prepare(`UPDATE users SET role = 'moderator' WHERE username = ?`)
      .bind('notifymod')
      .run();

    const bad = await req('/api/admin/notifications', {
      method: 'POST',
      token: admin.accessToken,
      body: { title: 'x', target: 999999 },
    });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('UID_NOT_FOUND');

    const forbidden = await req('/api/admin/notifications', {
      method: 'POST',
      token: mod.accessToken,
      body: { title: 'x', target: 'all' },
    });
    expect(forbidden.status).toBe(403);

    const badLink = await req('/api/admin/notifications', {
      method: 'POST',
      token: admin.accessToken,
      body: { title: 'x', link: 'javascript:alert(1)' },
    });
    expect(badLink.status).toBe(400);
  });
});

describe('分类图标（emoji 或图片 URL）', () => {
  it('接受 emoji 与图片 URL；拒绝非法长字符串', async () => {
    const admin = await makeAdmin('iconadmin');

    const emoji = await req('/api/admin/categories', {
      method: 'POST',
      token: admin.accessToken,
      body: { name: '图标测试A', slug: 'icon-test-a', icon: '🚀' },
    });
    expect(emoji.status).toBe(201);

    const url = await req('/api/admin/categories', {
      method: 'POST',
      token: admin.accessToken,
      body: { name: '图标测试B', slug: 'icon-test-b', icon: '/api/files/uploads/x/y.png' },
    });
    expect(url.status).toBe(201);

    const bad = await req('/api/admin/categories', {
      method: 'POST',
      token: admin.accessToken,
      body: { name: '图标测试C', slug: 'icon-test-c', icon: '这不是图标也不是链接的一串文字啊' },
    });
    expect(bad.status).toBe(400);
  });

  it('purpose=category 图片上传走 R2 并返回文件地址', async () => {
    const admin = await makeAdmin('iconupload');
    const form = new FormData();
    form.append('file', new File([PNG_1PX as unknown as BlobPart], 'icon.png', { type: 'image/png' }));
    form.append('purpose', 'category');
    const res = await req('/api/upload', { method: 'POST', token: admin.accessToken, body: form });
    expect(res.status).toBe(201);
    expect((res.body as { url: string }).url).toMatch(/^\/api\/files\/uploads\//);
  });
});
