/**
 * JWT 测试助手（仅用于本地安全验证）
 *
 *   node scripts/jwt-helper.mjs sign   '<JWT_SIGNING_KEYS JSON>' <kid> '<payload-json>'
 *   node scripts/jwt-helper.mjs tamper '<jwt>' '<new-sub>'          # 改 payload 保留原签名
 *   node scripts/jwt-helper.mjs rotate-sign '<throwaway-key.json>' <kid> '<payload-json>'
 *
 * rotate-sign 用的 throwaway key 由 --gen 子命令生成：
 *   node scripts/jwt-helper.mjs gen > key.json   # {kid, jwk:{private, public}}
 */
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signRS256(privateJwk, kid, payload) {
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createSign('RSA-SHA256').update(input).sign(key);
  return `${input}.${sig.toString('base64url')}`;
}

const [, , cmd, arg1, arg2, arg3] = process.argv;

if (cmd === 'sign') {
  const keys = JSON.parse(arg1);
  const entry = keys.find((k) => k.kid === arg2) ?? keys[0];
  process.stdout.write(signRS256(entry.jwk, entry.kid, JSON.parse(arg3)));
} else if (cmd === 'tamper') {
  const [h, p, s] = arg1.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  payload.sub = arg2;
  process.stdout.write(`${h}.${b64url(JSON.stringify(payload))}.${s}`);
} else if (cmd === 'gen') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  process.stdout.write(JSON.stringify({ kid: 'rotated-old-key', jwk: { private: privJwk, public: pubJwk } }));
} else if (cmd === 'rotate-sign') {
  const { jwk } = JSON.parse(arg1);
  process.stdout.write(signRS256(jwk.private, arg2, JSON.parse(arg3)));
} else {
  console.error('unknown command');
  process.exit(1);
}
