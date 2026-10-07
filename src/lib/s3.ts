/**
 * S3 兼容存储最小客户端（AWS SigV4，Web Crypto 实现，无第三方依赖）。
 * 管理后台配置（config:s3）→ 连通测试；后续备份/存储扩展直接复用。
 */
import type { Env } from '../types';
import { getServiceRaw } from './service-config';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  path_style?: boolean;
  public_base_url?: string;
}

export async function getS3Config(env: Env): Promise<S3Config | null> {
  const raw = await getServiceRaw(env, 's3');
  if (!raw) return null;
  const cfg = raw as unknown as Record<string, string> & Partial<S3Config>;
  if (!cfg.endpoint || !cfg.bucket || !cfg.access_key_id || !cfg.secret_access_key) return null;
  return {
    endpoint: cfg.endpoint,
    region: cfg.region || 'auto',
    bucket: cfg.bucket,
    access_key_id: cfg.access_key_id,
    secret_access_key: cfg.secret_access_key,
    path_style: String(cfg.path_style ?? 'true') !== 'false',
    public_base_url: cfg.public_base_url || undefined,
  };
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', raw as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sigV4(method: string, url: URL, cfg: S3Config, amzDate: string): Promise<string> {
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const emptyPayload = await sha256Hex('');
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': emptyPayload,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join('');
  const canonicalRequest = [method, url.pathname, url.search.replace(/^\?/, ''), canonicalHeaders, signedHeaders, emptyPayload].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(new TextEncoder().encode(`AWS4${cfg.secret_access_key}`), date);
  const kRegion = await hmac(kDate, cfg.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = [...new Uint8Array(await hmac(kSigning, stringToSign))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `AWS4-HMAC-SHA256 Credential=${cfg.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function s3ObjectUrl(cfg: S3Config, key = ''): URL {
  const base = cfg.endpoint.replace(/\/+$/, '');
  if (cfg.path_style) return new URL(`${base}/${cfg.bucket}${key ? `/${key}` : ''}`);
  const u = new URL(base);
  return new URL(`${u.protocol}//${cfg.bucket}.${u.host}${u.pathname}${key ? `/${key}` : ''}`);
}

/** 签名请求（GET/HEAD/PUT/DELETE，空载荷） */
export async function s3Request(env: Env, method: 'GET' | 'HEAD' | 'PUT' | 'DELETE', key = '', query = '', body?: ArrayBuffer | string): Promise<Response> {
  const cfg = await getS3Config(env);
  if (!cfg) throw new Error('S3 未配置');
  const url = s3ObjectUrl(cfg, key);
  if (query) url.search = query;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const authorization = await sigV4(method, url, cfg, amzDate);
  return fetch(url.toString(), {
    method,
    headers: { Authorization: authorization, 'x-amz-date': amzDate, 'x-amz-content-sha256': await sha256Hex('') },
    body: body as BodyInit | undefined,
  });
}

export interface S3TestResult {
  ok: boolean;
  message: string;
}

/** 连通测试：PUT 写探针对象 → GET 校验 → DELETE 清理 */
export async function s3Test(env: Env): Promise<S3TestResult> {
  const cfg = await getS3Config(env);
  if (!cfg) return { ok: false, message: '配置不完整（endpoint / bucket / 密钥）' };
  const probe = `.starlr-probe/${Date.now()}.txt`;
  try {
    const put = await s3Request(env, 'PUT', probe, '', 'ok');
    if (!put.ok) {
      const text = (await put.text()).slice(0, 200);
      return { ok: false, message: `写入失败（HTTP ${put.status}）${text ? `: ${text}` : ''}` };
    }
    const get = await s3Request(env, 'GET', probe);
    const got = get.ok ? await get.text() : null;
    await s3Request(env, 'DELETE', probe);
    if (got !== 'ok') return { ok: false, message: `读回校验失败（HTTP ${get.status}）` };
    return { ok: true, message: `连接正常：${s3ObjectUrl(cfg).origin} / ${cfg.bucket}（写入-读回-清理均成功）` };
  } catch (e) {
    return { ok: false, message: `连接失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
