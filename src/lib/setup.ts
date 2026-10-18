/**
 * 站点初始化配置（KV `config:setup`，管理后台「服务配置」可改）。
 * - registration_enabled: 是否开放注册（默认 true）
 * - registration_email_required: 注册是否必须邮箱（默认 true；关闭 = 用户名+密码直接注册）
 * - uploads_storage: 图片存储 'r2'（默认，Worker 绑定）| 's3'（config:s3 配置的 S3 兼容存储）
 * 未配置或解析失败时全部走默认值，零配置可启动。
 */
import type { Env } from '../types';

export interface SetupConfig {
  registrationEnabled: boolean;
  emailRequired: boolean;
  uploadsStorage: 'r2' | 's3';
}

const KV_KEY = 'config:setup';

const DEFAULT_SETUP: SetupConfig = {
  registrationEnabled: defaults.setup.registration_enabled,
  emailRequired: defaults.setup.registration_email_required,
  uploadsStorage: defaults.setup.uploads_storage as 'r2' | 's3',
};

export async function getSetupConfig(env: Env): Promise<SetupConfig> {
  try {
    const raw = await env.CACHE.get(KV_KEY);
    if (!raw) return { ...DEFAULT_SETUP };
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    return {
      registrationEnabled: cfg.registration_enabled === undefined ? DEFAULT_SETUP.registrationEnabled : cfg.registration_enabled === true || cfg.registration_enabled === 'true',
      emailRequired: cfg.registration_email_required === undefined ? DEFAULT_SETUP.emailRequired : cfg.registration_email_required === true || cfg.registration_email_required === 'true',
      uploadsStorage: cfg.uploads_storage === 's3' ? 's3' : 'r2',
    };
  } catch {
    return { ...DEFAULT_SETUP };
  }
}

export async function writeSetupConfig(env: Env, cfg: Partial<SetupConfig>): Promise<void> {
  const merged = { ...(await getSetupConfig(env)), ...cfg };
  const raw = JSON.stringify({
    registration_enabled: merged.registrationEnabled,
    registration_email_required: merged.emailRequired,
    uploads_storage: merged.uploadsStorage,
  });
  await env.CACHE.put(KV_KEY, raw);
}

/** 首个注册用户自动成为管理员：users 表为空即视为首次初始化 */
export async function isFirstUser(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

/** 站点信息（KV config:site）——自部署者改名字/昵称/描述，无需改代码 */
export interface SiteInfo {
  siteName: string;
  siteTagline: string;
  siteDescription: string;
  siteFooter: string;
}

const SITE_KV_KEY = 'config:site';

import defaults from '../config/defaults.json';

/** 所有默认配置集中在 src/config/defaults.json，自部署者直接改该文件 */
export const DEFAULTS = defaults;

export const DEFAULT_SITE: SiteInfo = defaults.site;

export async function getSiteInfo(env: Env): Promise<SiteInfo> {
  try {
    const raw = await env.CACHE.get(SITE_KV_KEY);
    if (!raw) return { ...DEFAULT_SITE };
    const cfg = JSON.parse(raw) as Partial<SiteInfo>;
    return {
      siteName: cfg.siteName || DEFAULT_SITE.siteName,
      siteTagline: cfg.siteTagline || DEFAULT_SITE.siteTagline,
      siteDescription: cfg.siteDescription || DEFAULT_SITE.siteDescription,
      siteFooter: cfg.siteFooter || DEFAULT_SITE.siteFooter,
    };
  } catch {
    return { ...DEFAULT_SITE };
  }
}

export async function writeSiteInfo(env: Env, cfg: Partial<SiteInfo>): Promise<void> {
  const merged = { ...(await getSiteInfo(env)), ...cfg };
  await env.CACHE.put(SITE_KV_KEY, JSON.stringify(merged));
}
