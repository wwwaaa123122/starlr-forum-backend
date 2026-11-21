/**
 * 邮件账号池与轮询投递单测。
 * - 账号池组装：KV accounts / 旧单账号结构兼容 / env secret 兜底 / 空池
 * - 轮询：秒级时间片轮转、失败自动顺移、全部失败返回末次错误
 * - 指定账号（连通测试）：只走该账号不顺移、越界报错
 * 外部 Resend API 用 fetchMock 拦截。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { fetchMock, env } from 'cloudflare:test';
import { getMailAccounts, deliverViaResend, __clearMailOutbox } from '../src/lib/mail';

const RESEND = 'https://api.resend.com';

/** 配置 KV 账号池 */
function setKvAccounts(accounts: { api_key?: string; from?: string }[]) {
  return env.CACHE.put('config:mail', JSON.stringify({ accounts }));
}

/**
 * 拦截 Resend：全局单拦截器（beforeAll 注册一次 persist），响应状态由
 * resendStatus 序列驱动。undici MockDispatch 在 workers pool 里拿不到请求头，
 * 无法按 Authorization 区分账号，故用「每用例重置的序号」控制状态。
 */
let resendStatuses: number[] = [];
let resendSeqN = 0;

beforeAll(() => {
  fetchMock
    .get(RESEND)
    .intercept({ method: 'POST', path: '/emails' })
    .reply(() => {
      const status = resendStatuses[Math.min(resendSeqN, resendStatuses.length - 1)];
      resendSeqN++;
      return { statusCode: status, body: JSON.stringify(status >= 400 ? { message: `mock ${status}` } : {}) };
    })
    .persist();
})

function mockResendSeq(statuses: number[]) {
  resendStatuses = statuses;
  resendSeqN = 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  resendStatuses = [200]; // 默认成功，未显式 mock 的用例不会炸
  resendSeqN = 0;
  await env.CACHE.delete('config:mail');
  __clearMailOutbox();
});

describe('getMailAccounts 账号池组装', () => {
  it('KV accounts 数组', async () => {
    await setKvAccounts([{ api_key: 'kv1', from: 'a@x.com' }, { api_key: 'kv2', from: 'b@x.com' }]);
    const accs = await getMailAccounts(env);
    // env secret 兜底账号始终追加在池尾
    expect(accs.slice(0, 2).map((a) => a.api_key)).toEqual(['kv1', 'kv2']);
    expect(accs.slice(0, 2).every((a) => a.source === 'kv')).toBe(true);
    expect(accs[2].source).toBe('env');
  });

  it('api_key 为 "-" 的账号被剔除（管理后台清除语义）', async () => {
    await setKvAccounts([{ api_key: '-', from: 'x@x.com' }, { api_key: 'keep', from: 'y@x.com' }]);
    const accs = await getMailAccounts(env);
    expect(accs.filter((a) => a.source === 'kv').map((a) => a.api_key)).toEqual(['keep']);
  });

  it('旧单账号结构兼容', async () => {
    await env.CACHE.put('config:mail', JSON.stringify({ api_key: 'legacy', from: 'old@x.com' }));
    const accs = await getMailAccounts(env);
    expect(accs.filter((a) => a.source === 'kv').map((a) => a.api_key)).toEqual(['legacy']);
  });

  it('env secret 兜底账号始终追加在池尾', async () => {
    await setKvAccounts([{ api_key: 'kv1', from: 'a@x.com' }]);
    const accs = await getMailAccounts(env);
    const last = accs[accs.length - 1];
    expect(last.api_key).toBe('test-env-resend-key');
    expect(last.source).toBe('env');
  });

  it('KV 无配置时只有 env 兜底', async () => {
    const accs = await getMailAccounts(env);
    expect(accs.length).toBe(1);
    expect(accs[0].source).toBe('env');
  });
});

describe('deliverViaResend 轮询投递', () => {
  it('当前时间片账号成功：直接发送，不请求其他账号', async () => {
    await setKvAccounts([{ api_key: 'kv1', from: 'a@x.com' }, { api_key: 'kv2', from: 'b@x.com' }]);
    mockResendSeq([200]);
    const r = await deliverViaResend(env, ['to@y.com'], 's', '<p/>', 't');
    expect(r.ok).toBe(true);
    expect(resendSeqN).toBe(1); // 一个账号成功就停止
  });

  it('当前账号失败自动顺移下一个，最终成功', async () => {
    await setKvAccounts([{ api_key: 'failing', from: 'a@x.com' }, { api_key: 'healthy', from: 'b@x.com' }]);
    // 固定秒级时间片 → 轮询起点确定（索引 0）；序列第 1 次失败第 2 次成功
    vi.spyOn(Date, 'now').mockReturnValue(3 * 1000 * 1_000_000); // 3,000,000 秒 % 3 = 0
    // 第 1 次调用失败（起点账号），第 2 次成功（顺移后）
    mockResendSeq([429, 200]);
    const r = await deliverViaResend(env, ['to@y.com'], 's', '<p/>', 't');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('发送成功');
  });

  it('KV 账号失败顺移到 env 兜底账号后成功', async () => {
    await setKvAccounts([{ api_key: 'bad1', from: 'a@x.com' }]);
    // 固定时间片 → 起点 = 索引 0（KV 账号 bad1）；失败后顺移到 env 兜底
    vi.spyOn(Date, 'now').mockReturnValue(2 * 1000 * 1_000_000); // % 2 = 0
    // 第 1 次失败（KV 账号），第 2 次成功（env 兜底）
    mockResendSeq([500, 200]);
    const r = await deliverViaResend(env, ['to@y.com'], 's', '<p/>', 't');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('环境变量'); // 成功账号来自 env 兜底
  });

  it('账号池为空（KV 空且无 env）：返回配置提示', async () => {
    // 临时摘掉 env 兜底：用不含该绑定副本的 env 对象模拟
    const emptyEnv = Object.create(env);
    Object.defineProperty(emptyEnv, 'RESEND_API_KEY', { get: () => undefined });
    const r = await deliverViaResend(emptyEnv, ['to@y.com'], 's', '<p/>', 't');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('服务配置');
  });

  it('指定账号（连通测试）：只走该账号失败即报错', async () => {
    await setKvAccounts([{ api_key: 'good', from: 'a@x.com' }, { api_key: 'broken', from: 'b@x.com' }]);
    // 指定账号只发一次：返回 401 即失败（不会顺移）
    mockResendSeq([401]);
    // 指定 2 号账号（broken，kv 池内）：失败即返回，不顺移到 1 号
    const r = await deliverViaResend(env, ['to@y.com'], 's', '<p/>', 't', { accountIndex: 2 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('#2');
  });

  it('指定账号越界：友好报错', async () => {
    await setKvAccounts([{ api_key: 'kv1', from: 'a@x.com' }]);
    const r = await deliverViaResend(env, ['to@y.com'], 's', '<p/>', 't', { accountIndex: 99 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('不存在');
  });
});
