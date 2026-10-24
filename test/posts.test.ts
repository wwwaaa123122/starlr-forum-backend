/**
 * 论坛功能测试：发帖 / 回复 / 编辑 / 删除 / 点赞 / 收藏 / 浏览 / 搜索 / 通知 / @ / 举报
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, createPost, req } from './helpers';

describe('发帖', () => {
  it('创建帖子并返回 ID', async () => {
    const user = await createUser({ username: 'poster' });
    const res = await createPost(user.accessToken, { title: '第一篇帖子', tags: ['cloudflare', 'd1'] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });

  it('帖子列表包含标签与计数', async () => {
    const user = await createUser({ username: 'lister' });
    const { id } = (await createPost(user.accessToken, { title: '列表帖子', tags: ['tag1', 'tag2'] })).body;
    const list = await req('/api/posts?pageSize=10');
    expect(list.status).toBe(200);
    const post = list.body.posts.find((p: { id: string }) => p.id === id);
    expect(post).toBeTruthy();
    expect(post.tags).toContain('tag1');
    expect(post.authorName).toBe('lister');
  });

  it('标题过短 / 正文为空被拒绝', async () => {
    const user = await createUser({ username: 'shorttitle' });
    const res = await createPost(user.accessToken, { title: 'x' });
    expect(res.status).toBe(400);
    const res2 = await createPost(user.accessToken, { content: '   ' });
    expect(res2.status).toBe(400);
  });

  it('未登录不能发帖', async () => {
    const res = await createPost(undefined as unknown as string);
    expect(res.status).toBe(401);
  });

  it('不存在的分类被拒绝', async () => {
    const user = await createUser({ username: 'nocat' });
    const res = await createPost(user.accessToken, { categoryId: 'cat-not-exist' });
    expect(res.status).toBe(400);
  });

  it('标签去重与上限（>5 报错）', async () => {
    const user = await createUser({ username: 'taglimit' });
    const res = await createPost(user.accessToken, { tags: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(res.status).toBe(400);
  });
});

describe('回复', () => {
  it('回复帖子并更新计数', async () => {
    const author = await createUser({ username: 'replyauthor' });
    const replier = await createUser({ username: 'replier' });
    const { id } = (await createPost(author.accessToken)).body;

    const res = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: replier.accessToken,
      body: { content: '顶一个！' },
    });
    expect(res.status).toBe(201);

    const detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.replyCount).toBe(1);
    expect(detail.body.post.lastReplyAt).toBeTruthy();
  });

  it('引用回复（楼中楼）', async () => {
    const author = await createUser({ username: 'quoteauthor' });
    const b = await createUser({ username: 'quoterb' });
    const c = await createUser({ username: 'quoterc' });
    const { id } = (await createPost(author.accessToken)).body;
    const r1 = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: b.accessToken,
      body: { content: '第一条' },
    });
    const r2 = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: c.accessToken,
      body: { content: '回复第一条', parentReplyId: r1.body.id },
    });
    expect(r2.status).toBe(201);

    const replies = await req(`/api/posts/${id}/replies`);
    const second = (replies.body.replies ?? []).find((r: { id: string }) => r.id === r2.body.id);
    expect(second.parentReplyId).toBe(r1.body.id);
    expect(second.replyToUserName).toBe('quoterb');
  });

  it('编辑与删除自己的回复', async () => {
    const author = await createUser({ username: 'editreply' });
    const { id } = (await createPost(author.accessToken)).body;
    const reply = await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: author.accessToken,
      body: { content: '原始内容' },
    });
    const rid = reply.body.id;

    const edited = await req(`/api/replies/${rid}`, {
      method: 'PATCH',
      token: author.accessToken,
      body: { content: '修改后的内容' },
    });
    expect(edited.status).toBe(200);

    const removed = await req(`/api/replies/${rid}`, { method: 'DELETE', token: author.accessToken });
    expect(removed.status).toBe(200);
    const replies = await req(`/api/posts/${id}/replies`);
    expect(replies.body.replies).toHaveLength(0);
  });
});

describe('点赞 / 收藏（防重复）', () => {
  it('重复点赞只计一次', async () => {
    const author = await createUser({ username: 'likeauthor' });
    const liker = await createUser({ username: 'liker' });
    const { id } = (await createPost(author.accessToken)).body;

    await req(`/api/posts/${id}/like`, { method: 'POST', token: liker.accessToken });
    await req(`/api/posts/${id}/like`, { method: 'POST', token: liker.accessToken });

    const detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.likeCount).toBe(1);
  });

  it('取消点赞', async () => {
    const author = await createUser({ username: 'unlikeauthor' });
    const liker = await createUser({ username: 'unliker' });
    const { id } = (await createPost(author.accessToken)).body;
    await req(`/api/posts/${id}/like`, { method: 'POST', token: liker.accessToken });
    await req(`/api/posts/${id}/like`, { method: 'DELETE', token: liker.accessToken });
    const detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.likeCount).toBe(0);
  });

  it('重复收藏只计一次，取消后可重新收藏', async () => {
    const author = await createUser({ username: 'favauthor' });
    const user = await createUser({ username: 'favuser' });
    const { id } = (await createPost(author.accessToken)).body;
    await req(`/api/posts/${id}/favorite`, { method: 'POST', token: user.accessToken });
    await req(`/api/posts/${id}/favorite`, { method: 'POST', token: user.accessToken });
    let detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.favoriteCount).toBe(1);

    await req(`/api/posts/${id}/favorite`, { method: 'DELETE', token: user.accessToken });
    detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.favoriteCount).toBe(0);
  });

  it('未登录点赞被拒绝', async () => {
    const author = await createUser({ username: 'guestlike' });
    const { id } = (await createPost(author.accessToken)).body;
    const res = await req(`/api/posts/${id}/like`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('浏览量', () => {
  it('同一访客重复浏览只计一次（KV 去重）', async () => {
    const author = await createUser({ username: 'viewauthor' });
    const { id } = (await createPost(author.accessToken)).body;
    const ua = { headers: { 'user-agent': 'same-visitor-1', 'cf-connecting-ip': '203.0.113.9' } };
    await req(`/api/posts/${id}/view`, { method: 'POST', ...ua });
    await req(`/api/posts/${id}/view`, { method: 'POST', ...ua });
    await req(`/api/posts/${id}/view`, { method: 'POST', ...ua });
    const detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.viewCount).toBe(1);
  });
});

describe('编辑与删除帖子', () => {
  it('作者可以编辑自己的帖子', async () => {
    const author = await createUser({ username: 'editpost' });
    const { id } = (await createPost(author.accessToken, { title: '原标题' })).body;
    const res = await req(`/api/posts/${id}`, {
      method: 'PATCH',
      token: author.accessToken,
      body: { title: '新标题', tags: ['edited'] },
    });
    expect(res.status).toBe(200);
    const detail = await req(`/api/posts/${id}`);
    expect(detail.body.post.title).toBe('新标题');
    const tagNames = detail.body.post.tags.map((t: { name: string } | string) => (typeof t === 'string' ? t : t.name));
    expect(tagNames).toContain('edited');
  });

  it('不能编辑/删除别人的帖子', async () => {
    const author = await createUser({ username: 'ownerpost' });
    const other = await createUser({ username: 'otherpost' });
    const { id } = (await createPost(author.accessToken)).body;
    const edit = await req(`/api/posts/${id}`, {
      method: 'PATCH',
      token: other.accessToken,
      body: { title: '黑客改的标题' },
    });
    expect(edit.status).toBe(403);
    const del = await req(`/api/posts/${id}`, { method: 'DELETE', token: other.accessToken });
    expect(del.status).toBe(403);
  });

  it('作者删除后从列表消失', async () => {
    const author = await createUser({ username: 'delpost' });
    const { id } = (await createPost(author.accessToken)).body;
    await req(`/api/posts/${id}`, { method: 'DELETE', token: author.accessToken });
    const detail = await req(`/api/posts/${id}`);
    expect(detail.status).toBe(404);
    const list = await req('/api/posts?pageSize=50');
    expect(list.body.posts.find((p: { id: string }) => p.id === id)).toBeUndefined();
  });
});

describe('搜索', () => {
  it('标题/正文搜索（FTS 或 LIKE 回退）', async () => {
    const author = await createUser({ username: 'searcher' });
    await createPost(author.accessToken, {
      title: 'Cloudflare Workers 指南',
      content: '深入介绍 Workers KV 与 D1 的配合方式',
    });
    const byTitle = await req('/api/search?q=Cloudflare');
    expect(byTitle.body.posts.length).toBeGreaterThanOrEqual(1);
    const byContent = await req('/api/search?q=KV%20%E4%B8%8E%20D1');
    expect(byContent.body.posts.length).toBeGreaterThanOrEqual(1);
  });

  it('中文短词搜索', async () => {
    const author = await createUser({ username: 'cjksearch' });
    await createPost(author.accessToken, { title: '星尘计划发布', content: '面向中文社区的边缘计算实践' });
    const res = await req('/api/search?q=星尘');
    expect(res.body.posts.length).toBeGreaterThanOrEqual(1);
  });

  it('用户搜索', async () => {
    await createUser({ username: 'findmeplease' });
    const res = await req('/api/search?q=findme&type=user');
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].email).toBeUndefined();
  });

  it('SQL 注入安全：特殊字符不报错不越权', async () => {
    const res = await req("/api/search?q=' OR 1=1 --");
    expect(res.status).toBe(200);
    const res2 = await req('/api/search?q=%27%3B%20DROP%20TABLE%20posts%3B--');
    expect(res2.status).toBe(200);
  });

  it('空关键词被拒绝', async () => {
    const res = await req('/api/search?q=');
    expect(res.status).toBe(400);
  });
});

describe('通知与 @', () => {
  it('被回复、被 @、被点赞产生通知', async () => {
    const author = await createUser({ username: 'notiauthor' });
    const actor = await createUser({ username: 'notiactor' });
    const { id } = (await createPost(author.accessToken, { content: '初始内容' })).body;

    await req(`/api/posts/${id}/replies`, {
      method: 'POST',
      token: actor.accessToken,
      body: { content: '你好 @notiauthor' },
    });
    await req(`/api/posts/${id}/like`, { method: 'POST', token: actor.accessToken });

    const list = await req('/api/notifications', { token: author.accessToken });
    const types = list.body.notifications.map((n: { type: string }) => n.type);
    expect(types).toContain('reply');
    expect(types).toContain('mention');
    expect(types).toContain('like');
    expect(list.body.unread).toBeGreaterThanOrEqual(3);
  });

  it('自己操作自己的内容不产生通知', async () => {
    const author = await createUser({ username: 'selfnoti' });
    const { id } = (await createPost(author.accessToken)).body;
    await req(`/api/posts/${id}/replies`, { method: 'POST', token: author.accessToken, body: { content: '自言自语' } });
    await req(`/api/posts/${id}/like`, { method: 'POST', token: author.accessToken });
    const list = await req('/api/notifications', { token: author.accessToken });
    expect(list.body.unread).toBe(0);
  });

  it('@ 提及上限（最多 5 个，避免通知轰炸）', async () => {
    const author = await createUser({ username: 'mentionbomber' });
    const victims = await Promise.all([
      createUser({ username: 'victim1' }),
      createUser({ username: 'victim2' }),
      createUser({ username: 'victim3' }),
      createUser({ username: 'victim4' }),
      createUser({ username: 'victim5' }),
      createUser({ username: 'victim6' }),
      createUser({ username: 'victim7' }),
    ]);
    const content = victims.map((v) => `@${v.username}`).join(' ') + ' 看这里！';
    const { id } = (await createPost(author.accessToken, { content })).body;
    // 只有前 5 个受害者收到 mention 通知
    const counts = await Promise.all(
      victims.map(async (v) => {
        const list = await req('/api/notifications', { token: v.accessToken });
        return list.body.notifications.filter((n: { type: string }) => n.type === 'mention').length;
      }),
    );
    expect(counts.filter((c) => c === 1).length).toBe(5);
    expect(counts[5]).toBe(0);
    expect(counts[6]).toBe(0);
    expect(id).toBeTruthy();
  });

  it('未读数与标记已读', async () => {
    const author = await createUser({ username: 'readauthor' });
    const actor = await createUser({ username: 'readactor' });
    const { id } = (await createPost(author.accessToken)).body;
    await req(`/api/posts/${id}/replies`, { method: 'POST', token: actor.accessToken, body: { content: 'hello' } });

    const before = await req('/api/notifications/unread-count', { token: author.accessToken });
    expect(before.body.unread).toBe(1);
    await req('/api/notifications/read-all', { method: 'POST', token: author.accessToken });
    const after = await req('/api/notifications/unread-count', { token: author.accessToken });
    expect(after.body.unread).toBe(0);
  });
});

describe('举报', () => {
  it('举报帖子进入待处理队列', async () => {
    const author = await createUser({ username: 'reportauthor' });
    const reporter = await createUser({ username: 'reporter' });
    const { id } = (await createPost(author.accessToken)).body;

    const res = await req('/api/reports', {
      method: 'POST',
      token: reporter.accessToken,
      body: { targetType: 'post', targetId: id, reason: 'spam', detail: '垃圾广告测试' },
    });
    expect(res.status).toBe(201);

    // 管理员可见（创建管理员）
    const admin = await createUser({ username: 'reportadmin' });
    await (env.DB as unknown as D1Database).prepare("UPDATE users SET role='admin' WHERE id=?").bind(admin.id).run();
    const list = await req('/api/admin/reports?status=pending', { token: admin.accessToken });
    expect(list.body.reports.some((r: { id: string }) => r.id === res.body.id)).toBe(true);
  });

  it('举报不存在的目标被拒绝', async () => {
    const reporter = await createUser({ username: 'ghostreporter' });
    const res = await req('/api/reports', {
      method: 'POST',
      token: reporter.accessToken,
      body: { targetType: 'post', targetId: 'ghost0000000000', reason: 'spam' },
    });
    expect(res.status).toBe(404);
  });
});

describe('分类', () => {
  it('公开分类列表（含种子数据）', async () => {
    const res = await req('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBeGreaterThanOrEqual(3);
    const slugs = res.body.categories.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('tech');
  });
});
