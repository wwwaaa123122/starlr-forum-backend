/**
 * /api/upload — 图片上传（登录 + 限流 + 大小 + MIME + 魔数字节强校验）
 *   - purpose=avatar  → 头像存入 KV（avatar:{uid}，≤2MB），经 /api/avatars/:uid 读取
 *   - purpose=post|reply → 图片存入 R2，经 /api/files/{key} 读取（长缓存）
 * 路由挂载（见 index.ts）：uploadRoutes → /api/upload；fileRoutes → /api
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { requireAuth, assertNotMuted } from '../middleware/auth';
import { RATE_LIMITS, consumeRateLimit } from '../lib/rate-limit';
import { newId, nowIso } from '../lib/ids';

const uploadRoutes = new Hono<AppEnv>();
const fileRoutes = new Hono<AppEnv>();

export { uploadRoutes, fileRoutes };

const MAX_SIZE = 5 * 1024 * 1024; // 单文件最大 5MB
const MAX_FILES_PER_USER = 300; // 每用户附件总量上限
const DAILY_UPLOAD_QUOTA = 40; // 每用户每 24 小时上传次数上限（KV 计数）
const ALLOWED_PURPOSES = new Set(['avatar', 'post', 'reply']);
const ALLOWED: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  'image/jpeg': {
    ext: 'jpg',
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/png': {
    ext: 'png',
    magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  'image/gif': {
    ext: 'gif',
    magic: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  },
  'image/webp': {
    ext: 'webp',
    magic: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
};

uploadRoutes.post('/', requireAuth, async (c) => {
  await assertNotMuted(c);
  const user = c.get('user')!;
  const rl = await consumeRateLimit(c.env, RATE_LIMITS.upload, user.id);
  if (!rl.ok) throw errors.tooMany('上传过于频繁，请稍后再试');

  // 文件数量限制：24 小时配额（KV 计数，成本极低）
  const quotaKey = `upload-quota:${user.id}:${Math.floor(Date.now() / 86_400_000)}`;
  const used = Number.parseInt((await c.env.CACHE.get(quotaKey)) ?? '0', 10) || 0;
  if (used >= DAILY_UPLOAD_QUOTA) {
    throw errors.tooMany(`每日上传数量已达上限（${DAILY_UPLOAD_QUOTA} 张），请明天再试`, 'UPLOAD_QUOTA_EXCEEDED');
  }

  // 文件数量限制：账号附件总量（索引查询，单次）
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?`)
    .bind(user.id)
    .first<{ n: number }>();
  if ((total?.n ?? 0) >= MAX_FILES_PER_USER) {
    throw errors.badRequest(`附件总量已达上限（${MAX_FILES_PER_USER} 个），请先删除部分图片`, 'ATTACHMENT_LIMIT');
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) throw errors.badRequest('必须使用 multipart/form-data 上传');
  const rawPurpose = String(form.get('purpose') ?? 'post');
  const purpose = ALLOWED_PURPOSES.has(rawPurpose) ? rawPurpose : 'post';
  const file = form.get('file');
  if (!(file instanceof File)) throw errors.badRequest('缺少文件字段 file');
  if (file.size === 0) throw errors.badRequest('文件为空');
  if (file.size > MAX_SIZE) throw errors.badRequest('文件超过 5MB 限制', 'FILE_TOO_LARGE');

  const mime = file.type || 'application/octet-stream';
  const rule = ALLOWED[mime];
  if (!rule) throw errors.badRequest('仅支持 JPG/PNG/GIF/WEBP 图片', 'UNSUPPORTED_TYPE');

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!rule.magic(bytes)) {
    // 魔数与声明 MIME 不符：拒绝（防伪装成图片的可执行/脚本文件）
    throw errors.badRequest('文件内容与图片格式不符，已拒绝', 'INVALID_FILE');
  }

  const ext = rule.ext;
  const d = new Date();
  const key = `uploads/${user.id}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${newId(20)}.${ext}`;

  // 头像：直接存 KV（小图、单值覆盖、按 uid 读取）；帖子/回复图片：存 R2
  if (purpose === 'avatar') {
    if (file.size > 2 * 1024 * 1024) throw errors.badRequest('头像最大 2MB', 'FILE_TOO_LARGE');
    const avatarKey = `avatar:${user.uid ?? user.id}`; // 与 /api/avatars/:uid 读取键保持一致
    const avatarUrl = `/api/avatars/${user.uid ?? user.id}?v=${Date.now()}`;
    await c.env.CACHE.put(avatarKey, bytes, {
      metadata: { contentType: mime, updatedAt: nowIso() },
    });
    await c.env.DB.prepare(`UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?`)
      .bind(avatarUrl, nowIso(), user.id)
      .run();
    await c.env.CACHE.put(quotaKey, String(used + 1), { expirationTtl: 86_400 });
    return ok(
      c,
      {
        url: avatarUrl,
        mimeType: mime,
        size: file.size,
        purpose,
        avatarUpdated: true,
        quotaRemaining: Math.max(0, DAILY_UPLOAD_QUOTA - (used + 1)),
      },
      { status: 201 },
    );
  }

  await c.env.UPLOADS.put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  });

  const attachmentId = newId(16);
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, user_id, r2_key, filename, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(attachmentId, user.id, key, file.name.slice(0, 200) || `image.${ext}`, mime, file.size, nowIso())
    .run();

  await c.env.CACHE.put(quotaKey, String(used + 1), { expirationTtl: 86_400 });

  return ok(
    c,
    {
      id: attachmentId,
      key,
      url: `/api/files/${key}`,
      mimeType: mime,
      size: file.size,
      purpose,
      avatarUpdated: false,
      quotaRemaining: Math.max(0, DAILY_UPLOAD_QUOTA - (used + 1)),
    },
    { status: 201 },
  );
});

/** R2 文件读取（公开；挂载于 /api → GET /api/files/*；键必须位于 uploads/ 前缀下） */
fileRoutes.get('/files/*', async (c) => {
  const key = c.req.path.replace(/^\/api\/files\//, '');
  if (!key.startsWith('uploads/') || key.includes('..')) throw errors.notFound();

  const object = await c.env.UPLOADS.get(key);
  if (!object) throw errors.notFound('文件不存在');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
});

/** 头像读取（KV 存储；挂载于 /api → GET /api/avatars/:uid） */
fileRoutes.get('/avatars/:uid', async (c) => {
  const uid = Number(c.req.param('uid'));
  if (!Number.isInteger(uid) || uid <= 0) throw errors.notFound();
  const { value, metadata } = await c.env.CACHE.getWithMetadata<ArrayBuffer & { contentType?: string }>(
    `avatar:${uid}`,
    { type: 'arrayBuffer' },
  );
  if (!value) throw errors.notFound('头像不存在');
  return new Response(value, {
    headers: {
      'Content-Type': metadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable', // URL 带 ?v= 时间戳做缓存失效
    },
  });
});

export default { uploadRoutes, fileRoutes };
