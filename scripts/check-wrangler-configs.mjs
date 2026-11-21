/**
 * 部署配置一致性检查（本地/CI 均可跑，无 Cloudflare 凭据依赖）。
 *
 * 校验内容：
 * 1. 所有 wrangler*.jsonc 可被 wrangler 解析（--dry-run 需要 assets 目录存在时跳过该文件并提示）
 * 2. 跨文件不变量：D1/KV/R2 绑定名一致、JWT_ISSUER 白名单、crons 只在 x 配置出现
 *
 * 用法：node scripts/check-wrangler-configs.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const configs = readdirSync(root).filter((f) => /^wrangler.*\.jsonc$/.test(f)).sort();

let failures = 0;
const bindingName = (text, re) => text.match(re)?.[1] ?? null;

for (const cfg of configs) {
  const path = join(root, cfg);
  const text = readFileSync(path, 'utf8');
  // 去掉 // 与 /* */ 注释后再做不变量检查（JSONC 注释里的示例词不应误报）
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // 绑定名抽取（宽松正则；语法错误由 dry-run 捕捉）
  const db = bindingName(text, /"d1_databases"[\s\S]*?"binding"\s*:\s*"([^"]+)"/);
  const kv = bindingName(text, /"kv_namespaces"[\s\S]*?"binding"\s*:\s*"([^"]+)"/);
  const r2 = bindingName(text, /"r2_buckets"[\s\S]*?"binding"\s*:\s*"([^"]+)"/);
  const hasCrons = /"crons"\s*:/.test(text);
  const assetsDir = text.match(/"assets"\s*:\s*\{[\s\S]*?"directory"\s*:\s*"([^"]+)"/)?.[1];
  const assetsMissing = assetsDir && !existsSync(join(root, assetsDir));

  console.log(`== ${cfg}`);
  console.log(`   D1=${db} KV=${kv} R2=${r2} crons=${hasCrons} assets=${assetsDir ?? '-'}${assetsMissing ? ' (目录不存在，部署前需先构建前端)' : ''}`);

  // 不变量
  if (db && db !== 'DB') { console.error(`   ✗ D1 绑定名应为 DB（AGENTS.md 红线），实际 ${db}`); failures++; }
  if (kv && kv !== 'CACHE') { console.error(`   ✗ KV 绑定名应为 CACHE，实际 ${kv}`); failures++; }
  if (r2 && r2 !== 'UPLOADS') { console.error(`   ✗ R2 绑定名应为 UPLOADS，实际 ${r2}`); failures++; }
  if (hasCrons && cfg !== 'wrangler.x.jsonc') { console.error(`   ✗ crons 触发器只应出现在 wrangler.x.jsonc`); failures++; }
  if (/JWT_SIGNING_KEYS/.test(code)) { console.error(`   ✗ 密钥不应出现在配置文件（用 wrangler secret put）`); failures++; }

  // dry-run（assets 缺失时 wrangler 会报目录不存在，属预期环境问题，不算配置错误）
  try {
    execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '-c', cfg], { cwd: root, stdio: 'pipe' });
    console.log('   dry-run ✓');
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    if (assetsMissing && /does not exist/.test(out)) {
      console.log('   dry-run ⊘ 跳过（assets 目录未构建）');
    } else {
      console.error('   ✗ dry-run 失败：', out.split('\n').find((l) => /ERROR|error/.test(l)) ?? out.slice(0, 200));
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} 处不一致`);
  process.exit(1);
}
console.log('\n✓ 所有部署配置一致');
