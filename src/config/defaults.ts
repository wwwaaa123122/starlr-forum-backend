/** 默认配置出口：值全部来自 defaults.json（自部署者改 JSON 文件即可） */
import raw from './defaults.json';

export const defaults = raw;

/** 邮件发件人兜底（env MAIL_FROM / 服务配置优先） */
export const mailFromFallback: string = raw.mail.fromFallback;
