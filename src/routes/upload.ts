/**
 * /api/upload — R2 图片上传（头像/帖子/回复）
 * 服务端强校验：登录 + 限流 + 大小 + MIME + 魔数字节（禁止伪装与可执行文件）
 * /api/files/:key{...} — 从 R2 读取并附带长缓存头
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { errors, ok } from '../lib/http';
import { requireAuth, assertNotMuted } from '../middleware/auth';
import { RATE_LIMITS, consumeRateLimit } from '../lib/rate-limit';
import { newId, nowIso } from '../lib/ids';

const app = new Hono<AppEnv>();

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

app.post('/', requireAuth, async (c) => {
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

  // 用途：avatar（同时更新头像）/ post / reply（默认 post）
  const rawPurpose = String(form.get('purpose') ?? 'post');
  const purpose = ALLOWED_PURPOSES.has(rawPurpose) ? rawPurpose : 'post';
  let avatarUpdated = false;
  if (purpose === 'avatar') {
    await c.env.DB.prepare(`UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?`)
      .bind(`/api/files/${key}`, nowIso(), user.id)
      .run();
    avatarUpdated = true;
  }

  return ok(
    c,
    {
      id: attachmentId,
      key,
      url: `/api/files/${key}`,
      mimeType: mime,
      size: file.size,
      purpose,
      avatarUpdated,
      quotaRemaining: Math.max(0, DAILY_UPLOAD_QUOTA - (used + 1)),
    },
    { status: 201 },
  );
});

/** R2 文件读取（公开；键必须位于 uploads/ 前缀下） */
app.get('/files/*', async (c) => {
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

export default app;
