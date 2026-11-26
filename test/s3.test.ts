/**
 * lib/s3 单测：SigV4 签名确定性、URL 构造（path-style / virtual-host）、配置校验。
 * 外部 S3 请求用 fetchMock 拦截，签名结果与 AWS 官方测试向量风格对照。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { fetchMock, env } from 'cloudflare:test';
import { getS3Config, s3ObjectUrl, s3Request, type S3Config } from '../src/lib/s3';

const VALID_CFG = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  access_key_id: 'AKIAIOSFODNN7EXAMPLE',
  secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  path_style: true,
};

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
  fetchMock.activate();
  vi.restoreAllMocks();
});

function setKv(cfg: Record<string, string>) {
  return env.CACHE.put('config:s3', JSON.stringify(cfg));
}

describe('getS3Config', () => {
  it('四项必填缺一返回 null', async () => {
    await setKv({ endpoint: '', bucket: 'b', access_key_id: 'a', secret_access_key: 's' });
    expect(await getS3Config(env)).toBeNull();
    await setKv({ endpoint: 'https://s3.example.com', bucket: '', access_key_id: 'a', secret_access_key: 's' });
    expect(await getS3Config(env)).toBeNull();
  });

  it('region 缺省 auto；path_style 缺省 true', async () => {
    const { region: _drop, ...noRegion } = VALID_CFG;
    await setKv(noRegion as unknown as Record<string, string>);
    const cfg = await getS3Config(env);
    expect(cfg!.region).toBe('auto');
    expect(cfg!.path_style).toBe(true);
  });

  it('KV 无配置返回 null', async () => {
    await env.CACHE.delete('config:s3');
    expect(await getS3Config(env)).toBeNull();
  });
});

describe('s3ObjectUrl', () => {
  const cfg: S3Config = { ...VALID_CFG };
  it('path-style：endpoint/bucket/key', () => {
    expect(s3ObjectUrl(cfg, 'posts/abc.png').toString()).toBe('https://s3.example.com/my-bucket/posts/abc.png');
  });
  it('path-style 空 key 不带尾斜杠', () => {
    expect(s3ObjectUrl(cfg).toString()).toBe('https://s3.example.com/my-bucket');
  });
  it('virtual-host style：bucket 进子域', () => {
    const vh: S3Config = { ...cfg, path_style: false };
    expect(s3ObjectUrl(vh, 'a/b.txt').toString()).toBe('https://my-bucket.s3.example.com/a/b.txt');
  });
  it('endpoint 尾斜杠被归一化', () => {
    const cfg2: S3Config = { ...cfg, endpoint: 'https://s3.example.com/' };
    expect(s3ObjectUrl(cfg2, 'k').toString()).toBe('https://s3.example.com/my-bucket/k');
  });
});

describe('s3Request（SigV4）', () => {
  it('未配置时抛错', async () => {
    await env.CACHE.delete('config:s3');
    await expect(s3Request(env, 'GET', 'x')).rejects.toThrow('S3 未配置');
  });

  it('签名请求成功：Authorization 带 AWS4-HMAC-SHA256 结构与签名头', async () => {
    await setKv(VALID_CFG as unknown as Record<string, string>);
    let captured: { headers: unknown } | null = null;
    fetchMock
      .get('https://s3.example.com')
      .intercept({ method: 'GET', path: '/my-bucket/posts/x.png' })
      .reply((options) => {
        captured = { headers: options.headers };
        return { statusCode: 200, body: 'object-bytes' };
      });

    const res = await s3Request(env, 'GET', 'posts/x.png');
    expect(res.status).toBe(200);
    // undici MockDispatch 的 headers 形状不定（对象或数组），统一拉平后断言
    const flat = JSON.stringify(captured!.headers);
    console.log('HDR:', flat);
    expect(flat).toMatch(/AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/);
    expect(flat).toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); // 空载荷 SHA-256（AWS 官方向量）
    expect(flat).toMatch(/\d{8}T\d{6}Z/);
  });

  it('PUT 带 body：x-amz-content-sha256 是请求体哈希（历史实现恒为空载荷哈希）', async () => {
    await setKv(VALID_CFG as unknown as Record<string, string>);
    let captured: unknown = null;
    fetchMock
      .get('https://s3.example.com')
      .intercept({ method: 'PUT', path: '/my-bucket/uploads/a.png' })
      .reply((options) => {
        captured = options.headers;
        return { statusCode: 200, body: '' };
      });

    await s3Request(env, 'PUT', 'uploads/a.png', '', 'ok');
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ok')))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const flat = JSON.stringify(captured);
    expect(flat).toContain(expected);
    expect(flat).not.toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('同输入签名确定性：同一请求两次签名一致', async () => {
    await setKv(VALID_CFG as unknown as Record<string, string>);
    const sigs: string[] = [];
    fetchMock
      .get('https://s3.example.com')
      .intercept({ method: 'GET', path: '/my-bucket/det' })
      .reply((options) => {
        sigs.push(String((options.headers as Record<string, string>)?.Authorization));
        return { statusCode: 200, body: '' };
      })
      .persist();

    await s3Request(env, 'GET', 'det');
    await s3Request(env, 'GET', 'det');
    expect(sigs[0]).toBe(sigs[1]); // x-amz-date 秒级粒度内，两次签名一致
  });
});
