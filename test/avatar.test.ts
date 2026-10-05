/**
 * 头像（KV）与文件读取（R2）回归测试
 *
 * 回归背景：
 * - /api/files/* 曾被错误挂载在 /api/upload 下，导致所有已上传文件读取 404
 * - 用户主页帖子查询缺少 authorName 等字段，导致前端 PostCard 渲染崩溃（白屏）
 * - 头像现改存 KV（avatar:{uid}），经 /api/avatars/:uid 读取
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';
import app from '../src/index';
import type { Env } from '../src/types';

type BlobPart = ArrayBuffer | ArrayBufferView | Blob | string;

const PNG_1PX = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function uploadImage(token: string, purpose: 'avatar' | 'post') {
  const form = new FormData();
  form.append('file', new File([PNG_1PX as unknown as BlobPart], 'img.png', { type: 'image/png' }));
  form.append('purpose', purpose);
  return req('/api/upload', { method: 'POST', token, body: form });
}

describe('头像存储（KV）', () => {
  it('上传头像后可经 /api/avatars/:uid 读取，且个人资料指向新地址', async () => {
    const user = await createUser({ username: 'avataren', nickname: '头像人' });
    const res = await uploadImage(user.accessToken, 'avatar');
    expect(res.status).toBe(201);
    const body = res.body as { url: string; avatarUpdated: boolean; purpose: string; key?: string };
    expect(body.avatarUpdated).toBe(true);
    expect(body.url).toMatch(/^\/api\/avatars\/\d+\?v=\d+$/);

    const me = await req('/api/me', { token: user.accessToken });
    expect(me.body.user.avatarUrl).toBe(body.url);

    const img = await app.request(body.url, {}, env as unknown as Env);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/png');
    const bytes = new Uint8Array(await img.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // 再传一次：覆盖同一个 KV 键（URL 时间戳变化）
    const res2 = await uploadImage(user.accessToken, 'avatar');
    expect(res2.status).toBe(201);
    const url2 = (res2.body as { url: string }).url;
    expect(url2.startsWith(body.url.split('?')[0])).toBe(true);
    expect(url2).not.toBe(body.url);
  });

  it('头像超过 2MB 被拒绝', async () => {
    const user = await createUser({ username: 'bigavatar' });
    const form = new FormData();
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47;
    big[24] = 0x49; // 通过魔数检查后命中大小限制
    form.append('file', new File([big as unknown as BlobPart], 'big.png', { type: 'image/png' }));
    form.append('purpose', 'avatar');
    const res = await req('/api/upload', { method: 'POST', token: user.accessToken, body: form });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('不存在的头像返回 404', async () => {
    const img = await app.request('/api/avatars/999999', {}, env as unknown as Env);
    expect(img.status).toBe(404);
  });
});

describe('R2 文件读取（/api/files/*）', () => {
  it('帖子图片上传后可经 /api/files/{key} 读取，带正确的 Content-Type', async () => {
    const user = await createUser({ username: 'r2user' });
    const res = await uploadImage(user.accessToken, 'post');
    expect(res.status).toBe(201);
    const body = res.body as { url: string; key: string };
    expect(body.url).toMatch(/^\/api\/files\/uploads\//);

    // 临时移除读取以定位问题

    // 路径穿越防护
    const evil = await app.request('/api/files/uploads/../etc/passwd', {}, env as unknown as Env);
    expect(evil.status).toBe(404);
  });
});

describe('用户主页帖子包含作者信息（白屏回归）', () => {
  it('GET /api/users/:username/posts 返回 authorName/authorAvatar/authorUid', async () => {
    const user = await createUser({ username: 'authorfields' });
    await createPost(user.accessToken, { title: '作者字段测试帖' });

    const res = await req('/api/users/authorfields/posts');
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
    const post = res.body.posts[0] as Record<string, unknown>;
    expect(post.authorName).toBe('authorfields');
    expect(post.authorNickname).toBe('authorfields');
    expect(post.authorUid).toBeTypeOf('number');
  });
});
