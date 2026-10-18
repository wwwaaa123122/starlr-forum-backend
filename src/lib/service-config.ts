/**
 * 第三方服务配置框架 —— 配置全部存 KV（config:<key>），管理后台可视化维护。
 *
 * 设计：
 *  - 每个服务一份 JSON 配置；secret 字段在管理接口里做掩码（保留末 4 位）
 *  - 读取方（mail / s3 / oauth）各自解析，KV 优先，env 变量兜底
 *  - 新增服务：在 SERVICES 里登记 schema + 在 admin-services.ts 的 test 分支加连通测试
 */
import type { Env } from '../types';

export interface ServiceField {
  name: string;
  label: string;
  /** 密钥类字段：管理接口返回掩码，写入时传空串表示保持不变 */
  secret?: boolean;
  /** 环境变量兜底名（历史上用 wrangler vars/secret 配过的） */
  envName?: string;
  placeholder?: string;
  hint?: string;
}

export interface ServiceDef {
  key: string;
  /** KV 键名 */
  kvKey: string;
  label: string;
  description: string;
  fields: ServiceField[];
  /** 有无连通测试 */
  testable: boolean;
}

export const SERVICES: ServiceDef[] = [
  {
    key: 'mail',
    kvKey: 'config:mail',
    label: '邮件（Resend）',
    description: '注册验证、找回密码、管理告警邮件。支持多发件账号轮询（分摊限额），某账号失败自动切换到下一个；环境变量里的 RESEND_API_KEY 会作为兜底账号自动加入轮询池。',
    fields: [],
    testable: true,
  },
  {
    key: 's3',
    kvKey: 'config:s3',
    label: 'S3 兼容存储',
    description: 'S3 兼容对象存储（AWS S3 / Cloudflare R2 S3 API / Backblaze B2 / 阿里云 OSS 等），用于后续备份与存储扩展。',
    fields: [
      { name: 'endpoint', label: 'Endpoint', placeholder: 'https://<account_id>.r2.cloudflarestorage.com' },
      { name: 'region', label: 'Region', placeholder: 'auto', hint: 'R2 填 auto' },
      { name: 'bucket', label: 'Bucket', placeholder: 'bucket 名' },
      { name: 'access_key_id', label: 'Access Key ID', placeholder: '...' },
      { name: 'secret_access_key', label: 'Secret Access Key', secret: true, placeholder: '...' },
      { name: 'path_style', label: 'Path-style 访问', placeholder: 'true / false', hint: 'R2 / B2 / OSS 填 true；AWS 官方 S3 填 false' },
      { name: 'public_base_url', label: '公开访问基址', placeholder: 'https://cdn.example.com', hint: '可选；对象对外访问 URL 前缀' },
    ],
    testable: true,
  },
  {
    key: 'seo',
    kvKey: 'config:seo',
    label: 'SEO / 搜索引擎',
    description: 'canonical 主域（唯一对外收录域名）、站长平台验证码、百度主动推送 token。留空即用 SITE_URL 的域名。',
    fields: [
      { name: 'canonical_host', label: 'canonical 主域', placeholder: 'forum.example.com', hint: '不带协议；多个域指向同一站点时，canonical 与 sitemap 都归并到这里' },
      { name: 'baidu_verify', label: '百度站长验证码', placeholder: 'code-xxxx', hint: 'baidu-site-verification 的 content 值' },
      { name: 'google_verify', label: 'Google Search Console', placeholder: 'xxxx', hint: 'google-site-verification 的 content 值' },
      { name: 'bing_verify', label: 'Bing 站长验证', placeholder: 'xxxx', hint: 'msvalidate.01 的 content 值' },
      { name: 'baidu_push_token', label: '百度主动推送 token', secret: true, placeholder: '...', hint: '填后每次发帖自动推送 URL（实时收录）' },
    ],
    testable: true,
  },
  {
    key: 'oauth-github',
    kvKey: 'config:oauth:github',
    label: 'GitHub OAuth 登录',
    description: 'GitHub OAuth App 凭据（github.com/settings/developers），回调地址填 <你的站点>/oauth/callback/github。',
    fields: [
      { name: 'client_id', label: 'Client ID', placeholder: 'Ov23li...' },
      { name: 'client_secret', label: 'Client Secret', secret: true, placeholder: '...' },
      { name: 'callback_origin', label: '回调基址', placeholder: 'https://api.example.com', hint: '留空则用 SITE_URL；前后端分离部署时填 API 所在域名' },
    ],
    testable: true,
  },
];

export function serviceDef(key: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.key === key);
}

export async function getServiceRaw(env: Env, key: string): Promise<Record<string, string> | null> {
  const def = serviceDef(key);
  if (!def) return null;
  const raw = await env.CACHE.get(def.kvKey);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return typeof obj === 'object' && obj ? (obj as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export async function putServiceRaw(env: Env, key: string, value: Record<string, string>): Promise<void> {
  const def = serviceDef(key);
  if (!def) throw new Error(`unknown service ${key}`);
  await env.CACHE.put(def.kvKey, JSON.stringify(value));
}

export async function deleteServiceRaw(env: Env, key: string): Promise<void> {
  const def = serviceDef(key);
  if (!def) throw new Error(`unknown service ${key}`);
  await env.CACHE.delete(def.kvKey);
}

function mask(value: string): string {
  if (value.length <= 4) return '••••';
  return `••••••••${value.slice(-4)}`;
}

export interface ServiceView {
  key: string;
  label: string;
  description: string;
  testable: boolean;
  configured: boolean;
  requiredMissing: boolean;
  fields: { name: string; label: string; secret: boolean; hint: string | null; placeholder: string | null; value: string | null; source: string | null }[];
  /** 邮件服务专用：账号池视图 */
  accounts?: { from: string; source: string; api_key_masked: string }[];
}

/** 管理接口展示视图：secret 掩码 + 标注每字段的配置来源（kv / env / 无） */
export async function describeService(env: Env, def: ServiceDef): Promise<ServiceView> {
  const kv = (await getServiceRaw(env, def.key)) ?? {};
  const fields = def.fields.map((f) => {
    const kvVal = kv[f.name];
    const envVal = f.envName ? (env as unknown as Record<string, string | undefined>)[f.envName] : undefined;
    const effective = kvVal !== undefined && kvVal !== '' ? kvVal : envVal;
    return {
      name: f.name,
      label: f.label,
      secret: Boolean(f.secret),
      hint: f.hint ?? null,
      placeholder: f.placeholder ?? null,
      /** 有效值：secret 掩码，普通字段明文（便于核对） */
      value: effective ? (f.secret ? mask(effective) : effective) : null,
      source: kvVal !== undefined && kvVal !== '' ? 'kv' : envVal ? 'env' : null,
    };
  });
  const requiredMissing = def.fields.filter((f) => !f.secret || f.name !== 'callback_origin').length > 0;
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    testable: def.testable,
    configured: fields.some((f) => f.source !== null),
    fields,
    requiredMissing,
  };
}
