# 默认配置

`defaults.json` 集中了后端所有默认配置值。**自部署者直接改这个文件**即可定制默认值（改完需重新部署 Worker）。

| 分组 | 说明 | 运行时可覆盖 |
|---|---|---|
| `site` | 站点名/标语/描述/页脚 | ✓ 管理后台 → 站点设置（KV `config:site`） |
| `setup` | 注册开关/邮箱必填/图片存储 | ✓ 管理后台 → 站点设置（KV `config:setup`） |
| `seo` | canonical 域名、SEO 标语兜底 | ✓ env `SITE_URL` 优先，其次服务配置 |
| `mail` | 发件人兜底 | ✓ env `MAIL_FROM` 优先，其次服务配置 |
| `app` | APP 更新检查兜底 | ✓ KV `config:app`（发布流程写入） |

优先级：**KV/管理后台 > 环境变量 > defaults.json > 代码内兜底**。
