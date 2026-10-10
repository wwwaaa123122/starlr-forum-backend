/**
 * 登录会话信息采集。
 *
 * 数据来源：Cloudflare Workers 请求对象
 *   - `cf-connecting-ip`：真实客户端 IP（Cloudflare 边缘注入，不可伪造）
 *   - `request.cf`（Cloudflare IP 库）：国家/地区/城市/时区/ASN/边缘节点
 * 以紧凑 JSON 存入 refresh_tokens.device_info，读取时兼容历史纯 UA 字符串。
 */
import type { Context } from 'hono';
import type { AppEnv } from '../types';

export interface SessionInfo {
  /** 原始 User-Agent */
  ua: string;
  /** 客户端 IP */
  ip: string;
  /** 国家/地区代码，如 CN、US、HK */
  country: string;
  /** 省/州 */
  region: string;
  /** 城市 */
  city: string;
  /** Cloudflare 边缘节点（如 LAX、SJC） */
  colo: string;
  /** 自治系统号 */
  asn: number | null;
}

/**
 * 采集当前请求的会话信息（Cloudflare IP 库）。
 * override：服务器对服务器调用（如 SSO 兑换）时透传终端用户在「签发请求」里的真实信息。
 */
export function sessionInfoFrom(c: Context<AppEnv>, override?: Partial<SessionInfo>): string {
  const cf = (c.req.raw as unknown as { cf?: IncomingRequestCfProperties }).cf;
  const info: SessionInfo = {
    ua: override?.ua ?? (c.req.header('user-agent') ?? '').slice(0, 200),
    ip: override?.ip ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '',
    country: override?.country ?? (cf?.country as string) ?? '',
    region: override?.region ?? (cf?.region as string) ?? '',
    city: override?.city ?? (cf?.city as string) ?? '',
    colo: override?.colo ?? (cf?.colo as string) ?? '',
    asn: override?.asn ?? (typeof cf?.asn === 'number' ? cf.asn : null),
  };
  return JSON.stringify(info).slice(0, 500);
}

/** 解析 device_info 字段（兼容历史版本仅存 UA 的情况） */
export function parseSessionInfo(raw: string | null | undefined): SessionInfo {
  const empty: SessionInfo = { ua: '', ip: '', country: '', region: '', city: '', colo: '', asn: null };
  if (!raw) return empty;
  if (!raw.startsWith('{')) return { ...empty, ua: raw };
  try {
    const parsed = JSON.parse(raw) as Partial<SessionInfo>;
    return {
      ua: typeof parsed.ua === 'string' ? parsed.ua : '',
      ip: typeof parsed.ip === 'string' ? parsed.ip : '',
      country: typeof parsed.country === 'string' ? parsed.country : '',
      region: typeof parsed.region === 'string' ? parsed.region : '',
      city: typeof parsed.city === 'string' ? parsed.city : '',
      colo: typeof parsed.colo === 'string' ? parsed.colo : '',
      asn: typeof parsed.asn === 'number' ? parsed.asn : null,
    };
  } catch {
    return { ...empty, ua: raw };
  }
}

/** 组合展示用位置文本（城市, 省/州, 国家代码） */
export function formatLocation(info: SessionInfo): string {
  return [info.city, info.region, info.country].filter(Boolean).join(', ');
}
