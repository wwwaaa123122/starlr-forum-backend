#!/usr/bin/env node
/**
 * 一键初始化：为自部署创建 Cloudflare 资源并生成填好的 Wrangler 配置。
 *
 *   node scripts/setup.mjs                     # 交互式（推荐）
 *   node scripts/setup.mjs --yes \
 *     --site-url https://forum.example.com \
 *     --domain forum.example.com \
 *     --worker my-forum \
 *     --db my-forum-db --kv my-forum-kv --r2 my-forum-uploads \
 *     --mode single                            # 全自动（不询问）
 *
 * 做的事：
 *   1. 检查 wrangler 登录状态（未登录时提示 `npx wrangler login` 或设置 CLOUDFLARE_API_TOKEN）
 *   2. 创建 D1 数据库 / KV 命名空间 / R2 桶（已存在则复用）
 *   3. 生成 RS256 JWT 签名密钥（写入 .dev.vars，供本地开发；生产用 secret put）
 *   4. 用模板生成 wrangler.prod.jsonc（单 Worker 同域）或 wrangler.api.jsonc（纯 API）
 *   5. 打印后续手动步骤（secret 设置、迁移、首个管理员注册）
 *
 * 不会做：不会上传任何密钥到仓库；不会修改你已有的生产配置。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

function arg(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const AUTO = argv.includes('--yes') || argv.includes('-y');

function run(cmd, args, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (allowFail) return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    throw err;
  }
}

const wrangler = (args, opts) => run('npx', ['--no-install', 'wrangler', ...args], opts);

async function ask(question, fallback) {
  if (AUTO) return arg(question.replace(/[^a-z-]/gi, ''), fallback);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}${fallback ? `（默认 ${fallback}）` : ''}: `)).trim();
  rl.close();
  return answer || fallback;
}

function ensureLogin() {
  const who = wrangler(['whoami'], { allowFail: true });
  if (/You are not authenticated|not logged in|Authentication error/i.test(who)) {
    console.error(
      '\n❌ 未登录 Cloudflare。请先执行其中一种：\n' +
        '   npx wrangler login                        # 浏览器授权（推荐）\n' +
        '   export CLOUDFLARE_API_TOKEN=<你的 API Token>   # CI / 无浏览器环境\n' +
        '   Token 需要权限：Workers Scripts:Edit、D1:Edit、Workers KV Storage:Edit、R2:Edit\n',
    );
    process.exit(1);
  }
}

/** wrangler 输出里可能混有日志行，取第一个 [ 到最后一个 ] 之间的 JSON */
function parseJsonLoose(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 从 wrangler 输出里抓资源 id。
 * 兼容两种输出格式：`id = "uuid"`（KV）与 `"database_id": "uuid"`（D1 的 JSON 片段）。
 */
function pickId(output, key) {
  const re = new RegExp(`${key}["']?\\s*[:=]\\s*"([^"]+)"`);
  const m = re.exec(output);
  return m?.[1];
}

function findD1(name) {
  const list = parseJsonLoose(wrangler(['d1', 'list', '--json'], { allowFail: true })) ?? [];
  return list.find((d) => d.name === name)?.uuid;
}

function createD1(name) {
  // 幂等：先查再建（重复执行脚本不会报错，也不会创建多余资源）
  const existing = findD1(name);
  if (existing) return { id: existing, created: false };
  const out = wrangler(['d1', 'create', name], { allowFail: true });
  const id = pickId(out, 'database_id');
  if (id) return { id, created: true };
  const again = findD1(name);
  if (again) return { id: again, created: false };
  throw new Error(`创建 D1 失败：\n${out}`);
}

function findKv(name) {
  const list = wrangler(['kv', 'namespace', 'list'], { allowFail: true });
  const at = list.indexOf(name);
  if (at === -1) return undefined;
  return pickId(list.slice(at, at + 600), 'id');
}

function createKv(name) {
  const existing = findKv(name);
  if (existing) return { id: existing, created: false };
  const out = wrangler(['kv', 'namespace', 'create', name], { allowFail: true });
  const id = pickId(out, 'id');
  if (id) return { id, created: true };
  const again = findKv(name);
  if (again) return { id: again, created: false };
  throw new Error(`创建 KV 命名空间失败：\n${out}`);
}

function createR2(name) {
  const out = wrangler(['r2', 'bucket', 'create', name], { allowFail: true });
  return { created: !/already exists|already owned/i.test(out) };
}

function generateDevKeys() {
  if (existsSync(path.join(ROOT, '.dev.vars'))) {
    console.log('• .dev.vars 已存在，跳过密钥生成（如需重置：node scripts/generate-jwt-keys.mjs）');
    return;
  }
  run('node', ['scripts/generate-jwt-keys.mjs']);
  const devVars = path.join(ROOT, '.dev.vars');
  if (existsSync(devVars)) {
    const content = readFileSync(devVars, 'utf8');
    if (!content.includes('TURNSTILE_DISABLED')) {
      writeFileSync(devVars, `${content.trimEnd()}\nTURNSTILE_DISABLED=true\nMAIL_TRANSPORT=memory\n`);
    }
  }
  console.log('• 已生成 .dev.vars（本地开发密钥，已 gitignore）');
}

function renderConfig({ mode, worker, dbName, dbId, kvId, r2Name, siteUrl, domain }) {
  const templateFile = mode === 'single' ? 'wrangler.example.jsonc' : 'wrangler.api.example.jsonc';
  let text = readFileSync(path.join(ROOT, templateFile), 'utf8');
  text = text
    .replace(/"name": "my-forum(-api)?",/, `"name": "${worker}",`)
    .replace(/"pattern": "(forum|api)\.example\.com"/, `"pattern": "${domain}"`)
    .replace(/"database_name": "my-forum-db", "database_id": "REPLACE_WITH_D1_DATABASE_ID"/, `"database_name": "${dbName}", "database_id": "${dbId}"`)
    .replace(/"binding": "CACHE", "id": "REPLACE_WITH_KV_NAMESPACE_ID"/, `"binding": "CACHE", "id": "${kvId}"`)
    .replace(/"bucket_name": "my-forum-uploads"/, `"bucket_name": "${r2Name}"`)
    .replace(/"SITE_URL": "https:\/\/(forum|api)\.example\.com"/, `"SITE_URL": "${siteUrl}"`)
    .replace(/"JWT_ISSUER": "https:\/\/(forum|api)\.example\.com"/, `"JWT_ISSUER": "${new URL(siteUrl).origin}"`);
  const outFile = mode === 'single' ? 'wrangler.prod.jsonc' : 'wrangler.api.jsonc';
  writeFileSync(path.join(ROOT, outFile), text);
  return outFile;
}

async function main() {
  console.log('\n=== Starlr Forum 自部署初始化 ===\n');
  ensureLogin();

  const mode = (await ask('部署模式 single=单 Worker 同域 / api=独立 API', 'single')) === 'api' ? 'api' : 'single';
  const siteUrlRaw = await ask('站点地址（如 https://forum.example.com）', arg('site-url', 'https://forum.example.com'));
  const siteUrl = siteUrlRaw.replace(/\/+$/, '');
  const domain = await ask('绑定域名（不带协议）', arg('domain', new URL(siteUrl).host));
  const worker = await ask('Worker 名称', arg('worker', domain.replace(/\./g, '-')));
  const dbName = await ask('D1 数据库名', arg('db', `${worker}-db`));
  const kvName = await ask('KV 命名空间名', arg('kv', `${worker}-kv`));
  const r2Name = await ask('R2 桶名', arg('r2', `${worker}-uploads`));

  console.log('\n→ 创建 D1 数据库…');
  const d1 = createD1(dbName);
  console.log(`  ${d1.created ? '已创建' : '已存在'}：${d1.id}`);

  console.log('→ 创建 KV 命名空间…');
  const kv = createKv(kvName);
  console.log(`  ${kv.created ? '已创建' : '已存在'}：${kv.id}`);

  console.log('→ 创建 R2 桶…');
  const r2 = createR2(r2Name);
  console.log(`  ${r2.created ? '已创建' : '已存在'}：${r2Name}`);

  console.log('→ 生成 JWT 签名密钥…');
  generateDevKeys();

  const outFile = renderConfig({ mode, worker, dbName, dbId: d1.id, kvId: kv.id, r2Name, siteUrl, domain });

  console.log(`\n✅ 已生成 ${outFile}\n`);
  console.log('接下来需要手动完成（密钥不进仓库，必须自己执行）：\n');
  console.log(`  1) 设置 JWT 签名密钥（生产）`);
  console.log(`     node scripts/generate-jwt-keys.mjs --print | npx wrangler secret put JWT_SIGNING_KEYS -c ${outFile}`);
  console.log(`  2) 初始化数据库表结构`);
  console.log(`     npx wrangler d1 migrations apply ${dbName} --remote -c ${outFile}`);
  console.log(`  3) 构建前端（在 frontend-x 仓库）`);
  console.log(`     npm ci && ${mode === 'api' ? `VITE_API_BASE=${new URL(siteUrl).origin} npm run build` : 'npm run build'}`);
  console.log(`  4) 部署`);
  console.log(`     npx wrangler deploy -c ${outFile}`);
  console.log(`  5) 打开 ${siteUrl} 注册第一个账号 —— 它会自动成为管理员\n`);
  console.log('可选配置（管理后台 → 站点设置 / 服务配置）：站点名、注册开关、邮件(Resend)、Turnstile、S3、GitHub 登录\n');
}

main().catch((err) => {
  console.error('\n❌ 初始化失败：', err.message);
  process.exit(1);
});
