#!/usr/bin/env bash
# ==============================================================
# 安全检查清单：OAuth 回调与 CSRF / JWT 验证 / 会话与缓存 / 第三方应用
#
#   bash scripts/security-checklist.sh
#
# 前置：本地 dev 已启动 —— 论坛 i 站 :8787、x 站 :8789
#       本地 KV 需有测试用 GitHub 配置（脚本自动注入，键 config:oauth:github）
# 说明：全部断言只打本地；涉及 JWT 私钥的仅使用 .dev.vars 的本地开发密钥
# ==============================================================
set -uo pipefail

API="${API:-http://127.0.0.1:8787}"
API_X="${API_X:-http://127.0.0.1:8789}"
DEVVARS="$(cd "$(dirname "$0")/.." && pwd)/.dev.vars"
PASS=0; FAIL=0; FAILED=()

pass() { PASS=$((PASS+1)); echo "  ✔ $1"; }
fail() { FAIL=$((FAIL+1)); FAILED+=("$1"); echo "  ✘ $1"; }
section() { echo ""; echo "[$1] $2"; }
assert() { # assert <名称> <实际> <期望子串>
  if [[ "$2" == *"$3"* ]]; then pass "$1"; else fail "$1（期望含 \"$3\"，实际：${2:0:150}）"; fi
}
assert_ne() {
  if [[ "$2" != *"$3"* ]]; then pass "$1"; else fail "$1（不应含 \"$3\"）"; fi
}
assert_re() { # assert_re <名称> <文本> <扩展正则>
  if echo "$2" | grep -qE "$3"; then pass "$1"; else fail "$1（期望匹配 $3，实际：${2:0:150}）"; fi
}
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
jget() { python3 -c "
import json,sys
try:
    d = json.loads(sys.argv[1])
    print(eval(sys.argv[2]))
except Exception:
    print('')" "$1" "$2" 2>/dev/null; }

KV() { (cd "$(dirname "$0")/.." && npx wrangler kv key "$@" --binding CACHE --local >/dev/null 2>&1); }

# ---------- 准备 ----------
echo "=============================================================="
echo " 安全检查清单（OAuth / JWT / 会话 / 第三方应用）"
echo "=============================================================="

UA="seccheck-$$-$(date +%s%N)"
U1=$(curl -s -A "$UA" -X POST -H "Content-Type: application/json" -d '{"identifier":"nebula","password":"nebula12345"}' "$API/api/auth/login")
U1_TOK=$(jget "$U1" "d['accessToken']"); U1_REF=$(jget "$U1" "d['refreshToken']")
U1_ID=$(jget "$U1" "d['user']['id']")
U2=$(curl -s -A "$UA" -X POST -H "Content-Type: application/json" -d '{"identifier":"smk-smoke-u1","password":"smoke-test-12345"}' "$API/api/auth/login")
U2_TOK=$(jget "$U2" "d['accessToken']")
KEYS=$(grep -oP 'JWT_SIGNING_KEYS=\K.*' "$DEVVARS")
if [[ -z "$U1_TOK" || -z "$KEYS" ]]; then echo "❌ 准备失败（登录或密钥读取）"; exit 1; fi

# ==============================================================
section "A" "OAuth 回调与 CSRF（GitHub 登录消费端）"
# 本地注入测试用 GitHub 配置（不调用 GitHub，全部在回调校验层拦截）
KV put "config:oauth:github" '{"client_id":"sec-check-client","client_secret":"sec-check-secret"}'

# A1 redirect_uri 篡改：/start 不接受任意 redirect，授权 URL 的 redirect_uri 固定指向 callback_origin
LOC=$(curl -s -o /dev/null -w "%{redirect_url}" "$API/oauth/start/github?redirect=https://evil.example.com/")
assert "A1a 授权跳转仍指向固定 callback_origin" "$LOC" "redirect_uri=http"
assert_ne "A1b 恶意 redirect 未进入授权地址" "$LOC" "evil.example.com"
REDIR_RECORDED=$(python3 -c "
from urllib.parse import urlparse, parse_qs
q = parse_qs(urlparse('$LOC').query)
print(q.get('state', [''])[0])")
[[ -n "$REDIR_RECORDED" ]] && pass "A1c 已获取签发的 state" || fail "A1c 未获取到 state"

# A2 state 伪造
R=$(curl -s "$API/oauth/callback/github?state=forged-state-123456&code=whatever")
assert "A2 伪造 state 被拒" "$R" "登录状态已失效"

# A3 state 重放（一次性）：首次回调即烧毁 state，第二次同样被拒
R1=$(curl -s "$API/oauth/callback/github?state=$REDIR_RECORDED&code=fake-code-1")
R2=$(curl -s "$API/oauth/callback/github?state=$REDIR_RECORDED&code=fake-code-2")
assert_re "A3a 首次使用后失效（状态一次性）" "$R1" "登录状态已失效|授权失败"
assert "A3b state 重放被拒" "$R2" "登录状态已失效"

# A4 PKCE：GitHub OAuth App（机密客户端）以 client_secret 服务端换码，PKCE 不适用；
#      预留 Provider 端点保持 501
assert "A4 预留 /oauth/token 未启用（501）" "$(code -X POST "$API/oauth/token" -H 'Content-Type: application/json' -d '{"code_verifier":"x"}')" "501"

# A5 授权码（一次性 code）重复提交
NEBULA_JSON=$(python3 -c "import json;print(json.dumps({'userId':'$U1_ID'}))")
CODE1="seccheck-code-$(date +%s)"
KV put "oauth:gh:code:$CODE1" "$NEBULA_JSON"
EX1=$(curl -s -A "$UA" -X POST -H "Content-Type: application/json" -d "{\"code\":\"$CODE1\"}" "$API/api/auth/oauth/exchange")
EX2=$(curl -s -A "$UA" -X POST -H "Content-Type: application/json" -d "{\"code\":\"$CODE1\"}" "$API/api/auth/oauth/exchange")
assert "A5a 首次兑换成功" "$EX1" "accessToken"
assert "A5b 重复提交第二次失败" "$EX2" "OAUTH_CODE_INVALID"

# A6 伪造/未知 provider
assert "A6 未知 provider 回调 404" "$(code "$API/oauth/callback/gitlab?state=x&code=y")" "404"

# ==============================================================
section "B" "JWT 验证"
NOW=$(date +%s)

# B1 篡改 sub（保留原签名 → 签名校验失败）
TAMPERED=$(node "$(dirname "$0")/jwt-helper.mjs" tamper "$U1_TOK" "attacker-user-id")
R=$(curl -s -H "Authorization: Bearer $TAMPERED" "$API/api/me")
assert_re "B1 篡改 sub 被拒" "$R" "AUTH_INVALID|UNAUTHORIZED|INVALID_TOKEN"

# B2 过期令牌（真实本地密钥签名）
EXP=$(node "$(dirname "$0")/jwt-helper.mjs" sign "$KEYS" "202610-lny7" "{\"iss\":\"https://i.182030.xyz\",\"sub\":\"$U1_ID\",\"aud\":\"api\",\"typ\":\"access\",\"exp\":$((NOW-3600)),\"iat\":$((NOW-7200))}")
R=$(curl -s -H "Authorization: Bearer $EXP" "$API/api/me")
assert_re "B2 过期令牌被拒" "$R" "AUTH_INVALID|UNAUTHORIZED|TOKEN_EXPIRED"

# B3 错误 iss（真实签名）
WISS=$(node "$(dirname "$0")/jwt-helper.mjs" sign "$KEYS" "202610-lny7" "{\"iss\":\"https://evil.example.com\",\"sub\":\"$U1_ID\",\"aud\":\"api\",\"typ\":\"access\",\"exp\":$((NOW+3600))}")
R=$(curl -s -H "Authorization: Bearer $WISS" "$API/api/me")
assert_re "B3 错误 iss 被拒" "$R" "AUTH_INVALID|UNAUTHORIZED|INVALID_TOKEN"

# B4 错误 aud（真实签名）
WAUD=$(node "$(dirname "$0")/jwt-helper.mjs" sign "$KEYS" "202610-lny7" "{\"iss\":\"https://i.182030.xyz\",\"sub\":\"$U1_ID\",\"aud\":\"other-service\",\"typ\":\"access\",\"exp\":$((NOW+3600))}")
R=$(curl -s -H "Authorization: Bearer $WAUD" "$API/api/me")
assert_re "B4 错误 aud 被拒" "$R" "AUTH_INVALID|UNAUTHORIZED|INVALID_TOKEN"

# B5 非 Access Token（refresh/ID 类 token）当 Access 使用
REF_AS_AT=$(node "$(dirname "$0")/jwt-helper.mjs" sign "$KEYS" "202610-lny7" "{\"iss\":\"https://i.182030.xyz\",\"sub\":\"$U1_ID\",\"aud\":\"api\",\"typ\":\"refresh\",\"exp\":$((NOW+3600))}")
R=$(curl -s -H "Authorization: Bearer $REF_AS_AT" "$API/api/me")
assert_re "B5 refresh/ID 类 token 当 Access 被拒" "$R" "AUTH_INVALID|UNAUTHORIZED|INVALID_TOKEN"

# B6 密钥轮换：旧密钥（已不在 JWKS）签发的 token 被拒
THROWAWAY=$(node "$(dirname "$0")/jwt-helper.mjs" gen)
OLDKEY=$(node "$(dirname "$0")/jwt-helper.mjs" rotate-sign "$THROWAWAY" "rotated-old-key" "{\"iss\":\"https://i.182030.xyz\",\"sub\":\"$U1_ID\",\"aud\":\"api\",\"typ\":\"access\",\"exp\":$((NOW+3600))}")
R=$(curl -s -H "Authorization: Bearer $OLDKEY" "$API/api/me")
assert_re "B6 轮换后旧密钥 token 被拒" "$R" "AUTH_INVALID|UNAUTHORIZED|INVALID_TOKEN"

# B7 注销与撤销：logout 后 refresh 失效；轮换出的旧 refresh 重放触发整链撤销
LOGOUT=$(curl -s -X POST -H "Content-Type: application/json" -d "{\"refreshToken\":\"$U1_REF\"}" "$API/api/auth/logout")
R=$(curl -s -X POST -H "Content-Type: application/json" -d "{\"refreshToken\":\"$U1_REF\"}" "$API/api/auth/refresh")
assert_re "B7a 注销后 refresh 不能刷新" "$R" "INVALID_TOKEN|TOKEN_REVOKED|AUTH_INVALID|UNAUTHORIZED"
R=$(curl -s -H "Authorization: Bearer $U1_TOK" "$API/api/me")
if [[ "$R" == *'"username"'* ]]; then
  pass "B7b 退出后旧 Access 仍有效至过期（无状态 JWT，≤30 分钟，设计如此）"
else
  fail "B7b 退出后旧 Access 行为异常：${R:0:120}"
fi

# ==============================================================
section "C" "会话与缓存"
# C1 用户隔离：A/B 各取各的资料
ME1=$(curl -s -H "Authorization: Bearer $U1_TOK" "$API/api/me")
ME2=$(curl -s -H "Authorization: Bearer $U2_TOK" "$API/api/me")
N1=$(jget "$ME1" "d['user']['username']"); N2=$(jget "$ME2" "d['user']['username']")
if [[ "$N1" == "nebula" && "$N2" == "smk-smoke-u1" ]]; then
  pass "C1 用户 A/B 会话与资料完全隔离（$N1 / $N2）"
else
  fail "C1 用户隔离异常：$N1 / $N2"
fi

# C2 授权页 / 令牌接口不进入公共缓存
H1=$(curl -s -D - -o /dev/null -X POST -H "Content-Type: application/json" -d '{"identifier":"nebula","password":"nebula12345"}' "$API/api/auth/login" | grep -i "cache-control" | head -1)
H2=$(curl -s -D - -o /dev/null -X POST -H "Content-Type: application/json" -d '{"refreshToken":"x"}' "$API/api/auth/refresh" | grep -i "cache-control" | head -1)
H3=$(curl -s -D - -o /dev/null -H "Authorization: Bearer $U2_TOK" "$API/api/me" | grep -i "cache-control" | head -1)
H4=$(curl -s -D - -o /dev/null -H "Authorization: Bearer $U2_TOK" "$API/api/admin/sso/config" | grep -i "cache-control" | head -1)
for item in "login:$H1" "refresh:$H2" "me:$H3" "admin:$H4"; do
  name="${item%%:*}"; header="${item#*:}"
  if [[ "$header" == *"no-store"* || "$header" == *"no-cache"* || "$header" == *"private"* ]]; then
    pass "C2$name 响应带缓存禁止头"
  else
    fail "C2$name 缺少 no-store/private（实际：${header:-无 Cache-Control}）"
  fi
done

# C3 跨站请求不能修改资料 / 授权（无 Cookie 会话 + Bearer 仅在同源 JS 中）
R=$(curl -s -X PATCH "$API/api/me" -H "Content-Type: text/plain" -H "Origin: https://evil.example.com" -d "nickname=hacked")
assert_re "C3a 跨站无凭证 PATCH 被拒" "$R" "AUTH_REQUIRED|AUTH_INVALID|UNAUTHORIZED"
R=$(curl -s -X POST "$API/api/auth/logout" -H "Content-Type: text/plain" -H "Origin: https://evil.example.com" -d "refreshToken=guess")
assert_ne "C3b 跨站 logout 无法影响他人会话" "$R" '"success":true'
COOKIE=$(curl -s -D - -o /dev/null -X POST -H "Content-Type: application/json" -d '{"identifier":"nebula","password":"nebula12345"}' "$API/api/auth/login" | grep -i "set-cookie" | head -1)
[[ -z "$COOKIE" ]] && pass "C3c 登录不发放 Cookie（无 Cookie CSRF 面）" || fail "C3c 登录意外发放 Cookie"

# ==============================================================
section "D" "第三方应用管理（OAuth Provider 预留且未启用）"
assert "D1 未注册 client_id 无法发起授权（端点未启用 501）" "$(code "$API/oauth/authorize?client_id=unregistered&redirect_uri=https://evil.com&response_type=code")" "501"
assert "D2 令牌端点未启用（501）" "$(code -X POST "$API/oauth/token")" "501"
assert "D3 撤销端点未启用（501）" "$(code -X POST "$API/oauth/revoke")" "501"
assert "D4 userinfo 未启用（501）" "$(code "$API/oauth/userinfo")" "501"
PROVIDER_HIT=$(curl -s "$API/oauth/callback/unknown" )
assert "D5 未注册 provider 回调 404" "$(code "$API/oauth/callback/unknown")" "404"
CLIENTS=$(cd "$(dirname "$0")/.." && npx wrangler d1 execute xingchen-forum-db --local --command "SELECT COUNT(*) AS n FROM oauth_clients" --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['results'][0]['n'])")
[[ "$CLIENTS" == "0" ]] && pass "D6 oauth_clients 表为空（无任何已注册第三方应用）" || fail "D6 oauth_clients 出现 $CLIENTS 条记录"

# ==============================================================
echo ""
echo "=============================================================="
if [[ $FAIL -eq 0 ]]; then
  echo "✅ 安全检查清单全部通过：$PASS 项"
  exit 0
else
  echo "❌ 通过 $PASS 项，失败 $FAIL 项："
  for f in "${FAILED[@]}"; do echo "   - $f"; done
  exit 1
fi
