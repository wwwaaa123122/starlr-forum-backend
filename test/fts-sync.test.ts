/**
 * FTS5 索引一致性：触发器（insert/update/delete）维护的索引与 posts 表状态同步。
 * 不一致会导致搜索结果包含已删除/已修改的帖子，或漏掉新内容。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createPost, createUser, req } from './helpers';

let adminToken = '';
let authorToken = '';

beforeAll(async () => {
  const admin = await createUser({ username: 'ftsadmin' });
  await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='ftsadmin'`).run();
  adminToken = admin.accessToken;
  const author = await createUser({ username: 'ftsauthor' });
  authorToken = author.accessToken;
});

/** 直接查 FTS 索引：该词是否可命中某 rowid */
async function ftsRowids(match: string): Promise<number[]> {
  const { results } = await env.DB.prepare(`SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?`)
    .bind(`"${match}"`)
    .all<{ rowid: number }>();
  return (results ?? []).map((r) => r.rowid);
}

async function rowidOf(postId: string): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT rowid FROM posts WHERE id = ?`).bind(postId).first<{ rowid: number }>();
  return row?.rowid ?? null;
}

describe('FTS5 索引一致性', () => {
  it('新建帖子后立即可搜到（insert 触发器）', async () => {
    const created = (await createPost(authorToken, { title: 'FTS索引验证专用帖', content: '唯一探针内容词 ftsprobecontent' })).body.id as string;
    const rid = await rowidOf(created);
    expect(rid).not.toBeNull();
    const ids = await ftsRowids('ftsprobecontent');
    expect(ids).toContain(rid!);
  });

  it('编辑正文后索引同步更新（update 触发器：旧词消失，新词出现）', async () => {
    const created = (await createPost(authorToken, { title: 'FTS编辑验证帖', content: '原始词 ftsoldword' })).body.id as string;
    const rid = await rowidOf(created);
    expect((await ftsRowids('ftsoldword'))).toContain(rid!);

    const patch = await req(`/api/posts/${created}`, {
      method: 'PATCH',
      token: authorToken,
      body: { content: '改后词 ftsnewword' },
    });
    expect(patch.status).toBe(200);

    // 旧词已从索引移除，新词已进入
    expect((await ftsRowids('ftsoldword'))).not.toContain(rid!);
    expect((await ftsRowids('ftsnewword'))).toContain(rid!);
  });

  it('软删除的帖子仍占索引但搜索不再命中（is_deleted 过滤）——行为一致性', async () => {
    const created = (await createPost(authorToken, { title: 'FTS删除验证帖', content: '删除探针 ftsdeleteword' })).body.id as string;
    const rid = await rowidOf(created);
    expect((await ftsRowids('ftsdeleteword'))).toContain(rid!);

    // 软删除（UPDATE is_deleted）— update 触发器会重写索引，内容仍在
    const del = await req(`/api/posts/${created}`, { method: 'DELETE', token: authorToken });
    expect(del.status).toBe(200);

    // 搜索接口不再返回它（is_deleted=0 过滤在 SQL，不依赖 FTS）
    const search = await req<{ posts: { id: string }[] }>('/api/search?q=ftsdeleteword&pageSize=50');
    expect(search.body.posts.every((p) => p.id !== created)).toBe(true);
  });

  it('硬删除（admin purge 类操作如存在）后索引同步移除——当前实现为软删除则索引保留不影响搜索', async () => {
    // 记录当前实现事实：全站都是软删除，无硬删除路径。
    // 若未来加硬删除（DELETE FROM posts），delete 触发器会移除索引 —— 本用例固化搜索不命中这一用户可见语义。
    const created = (await createPost(authorToken, { title: 'FTS硬删验证帖', content: '硬删探针 ftshardword' })).body.id as string;
    await req(`/api/posts/${created}`, { method: 'DELETE', token: authorToken });
    const search = await req<{ posts: { id: string }[] }>('/api/search?q=ftshardword&pageSize=50');
    expect(search.body.posts.every((p) => p.id !== created)).toBe(true);
  });

  it('标题修改也进入索引（title 列在 FTS 表内）', async () => {
    const created = (await createPost(authorToken, { title: '原始标题词 ftstitold', content: '正文' })).body.id as string;
    const rid = await rowidOf(created);
    expect((await ftsRowids('ftstitold'))).toContain(rid!);

    await req(`/api/posts/${created}`, { method: 'PATCH', token: authorToken, body: { title: '改后标题词 ftstitnew' } });
    expect((await ftsRowids('ftstitold'))).not.toContain(rid!);
    expect((await ftsRowids('ftstitnew'))).toContain(rid!);
  });
});
