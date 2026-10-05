/**
 * UID 分配 / 多管理员配置（按 UID）/ 密码重置与修改 / 邮件告警
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, req } from './helpers';
import { __getMailOutbox, __clearMailOutbox } from '../src/lib/mail';

beforeEach(() => {
  __clearMailOutbox();
});

describe('用户 UID', () => {
  it('注册自动分配从 1 开始递增的 UID', async () => {
    const a = await createUser({ username: 'uidone' });
    const b = await createUser({ username: 'uidtwo' });
    const meA = await req('/api/me', { token: a.accessToken });
    const meB = await req('/api/me', { token: b.accessToken });
    expect(typeof meA.body.user.uid).toBe('number');
    expect(typeof meB.body.user.uid).toBe('number');
    expect(meA.body.user.uid).toBeGreaterThan(0);
    expect(meB.body.user.uid).toBe((meA.body.user.uid as number) + 1);
  });

  it('UID 全局唯一且出现在用户主页', async () => {
    const u1 = await createUser({ username: 'uiduniq1' });
    const u2 = await createUser({ username: 'uiduniq2' });
    const me1 = await req('/api/me', { token: u1.accessToken });
    const me2 = await req('/api/me', { token: u2.accessToken });
    expect(me1.body.user.uid).not.toBe(me2.body.user.uid);

    const profile = await req(`/api/users/${u2.username}`);
    expect(profile.body.user.uid).toBe(me2.body.user.uid);
  });

  it('按 UID 搜索用户', async () => {
    const u = await createUser({ username: 'uidsearchable' });
    const me = await req('/api/me', { token: u.accessToken });
    const found = await req(`/api/search?q=${me.body.user.uid}&type=user`);
    expect(found.body.users.some((x: { id: string }) => x.id === u.id)).toBe(true);
  });

  it('管理员用户列表含 UID 且支持 UID 搜索', async () => {
    const admin = await createUser({ username: 'uidadmin0' });
    await (env.DB as unknown as D1Database)
      .prepare(`UPDATE users SET role = 'admin' WHERE id = ?`)
      .bind(admin.id)
      .run();

    const u = await createUser({ username: 'uidtarget0' });
    const me = await req('/api/me', { token: u.accessToken });
    const list = await req(`/api/admin/users?query=${me.body.user.uid}`, { token: admin.accessToken });
    expect(list.body.users).toHaveLength(1);
    expect(list.body.users[0].uid).toBe(me.body.user.uid);
  });
});

describe('多管理员配置（按 UID）', () => {
  async function makeAdmin() {
    const admin = await createUser({ username: `staffadmin${Math.random().toString(36).slice(2, 7)}` });
    await (env.DB as unknown as D1Database).prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(admin.id).run();
    return admin;
  }

  it('按 UID 授予管理员 / 版主权限', async () => {
    const admin = await makeAdmin();
    const target = await createUser({ username: 'promoteduser' });
    const targetMe = await req('/api/me', { token: target.accessToken });
    const uid = targetMe.body.user.uid as number;

    const grant = await req('/api/admin/admins', { method: 'POST', token: admin.accessToken, body: { uid, role: 'admin' } });
    expect(grant.status).toBe(200);
    expect(grant.body.user.role).toBe('admin');

    // 目标用户现在可以访问管理 API
    const stats = await req('/api/admin/stats', { token: target.accessToken });
    expect(stats.status).toBe(200);

    // 管理员列表包含目标
    const list = await req('/api/admin/admins', { token: admin.accessToken });
    expect(list.body.admins.some((a: { uid: number }) => a.uid === uid)).toBe(true);
  });

  it('按 UID 授予版主权限（moderator 不能授权他人）', async () => {
    const admin = await makeAdmin();
    const mod = await createUser({ username: 'promotedmod' });
    const modMe = await req('/api/me', { token: mod.accessToken });
    await req('/api/admin/admins', { method: 'POST', token: admin.accessToken, body: { uid: modMe.body.user.uid, role: 'moderator' } });

    // 版主可以看到管理后台
    expect((await req('/api/admin/posts', { token: mod.accessToken })).status).toBe(200);
    // 但版主无权授权
    const victim = await createUser({ username: 'modvictimm' });
    const victimMe = await req('/api/me', { token: victim.accessToken });
    const grant = await req('/api/admin/admins', {
      method: 'POST',
      token: mod.accessToken,
      body: { uid: victimMe.body.user.uid, role: 'admin' },
    });
    expect(grant.status).toBe(403);
  });

  it('按 UID 撤销管理权限', async () => {
    const admin = await makeAdmin();
    const target = await createUser({ username: 'revoketarget' });
    const uid = (await req('/api/me', { token: target.accessToken })).body.user.uid as number;
    await req('/api/admin/admins', { method: 'POST', token: admin.accessToken, body: { uid, role: 'moderator' } });

    const revoke = await req(`/api/admin/admins/${uid}`, { method: 'DELETE', token: admin.accessToken });
    expect(revoke.status).toBe(200);

    // 撤销后回到普通用户
    const forbidden = await req('/api/admin/stats', { token: target.accessToken });
    expect(forbidden.status).toBe(403);
    const me = await req('/api/me', { token: target.accessToken });
    expect(me.body.user.role).toBe('user');
  });

  it('不能撤销自己的管理权限，且必须保留至少一位管理员', async () => {
    const admin = await makeAdmin();
    const adminMe = await req('/api/me', { token: admin.accessToken });
    const selfRevoke = await req(`/api/admin/admins/${adminMe.body.user.uid}`, {
      method: 'DELETE',
      token: admin.accessToken,
    });
    expect(selfRevoke.status).toBe(400);

    // 唯一管理员的 UID 不能被他人撤销（这里是本人，也被上面规则拦截）
    const lastAdmin = await req('/api/admin/admins', { token: admin.accessToken });
    const adminCount = lastAdmin.body.admins.filter((a: { role: string }) => a.role === 'admin').length;
    expect(adminCount).toBeGreaterThanOrEqual(1);
  });

  it('不存在的 UID 返回 404', async () => {
    const admin = await makeAdmin();
    const res = await req('/api/admin/admins', { method: 'POST', token: admin.accessToken, body: { uid: 987654321, role: 'admin' } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UID_NOT_FOUND');
  });

  it('普通用户不能访问管理员配置 API', async () => {
    const user = await createUser({ username: 'staffpeasant' });
    expect((await req('/api/admin/admins', { token: user.accessToken })).status).toBe(403);
    expect((await req('/api/admin/admins/1', { method: 'DELETE', token: user.accessToken })).status).toBe(403);
  });
});

describe('密码重置（Resend 邮件）', () => {
  it('完整流程：申请重置 → 邮件含令牌 → 重置成功 → 旧登录状态全部失效', async () => {
    __clearMailOutbox();
    const user = await createUser({ username: 'resetflow' });
    const oldRefresh = user.refreshToken;

    const forgot = await req('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } });
    expect(forgot.status).toBe(200);
    expect(forgot.body.success).toBe(true);

    // 内存 outbox 中应包含重置邮件（含一次性令牌链接）
    const mails = __getMailOutbox();
    const resetMail = mails.find((m) => m.subject === '重置你的密码');
    expect(resetMail).toBeTruthy();
    expect(resetMail!.to).toContain(user.email);
    const match = resetMail!.html.match(/token=([a-f0-9]{64})/);
    expect(match).toBeTruthy();

    // 用错误令牌重置失败
    const bad = await req('/api/auth/reset-password', {
      method: 'POST',
      body: { token: 'f'.repeat(64), password: 'NewPass2026!' },
    });
    expect(bad.status).toBe(400);

    // 正确令牌重置成功
    const reset = await req('/api/auth/reset-password', {
      method: 'POST',
      body: { token: match![1], password: 'NewPass2026!' },
    });
    expect(reset.status).toBe(200);

    // 新密码可登录，旧密码失效
    const newLogin = await req('/api/auth/login', { method: 'POST', body: { identifier: user.username, password: 'NewPass2026!' } });
    expect(newLogin.status).toBe(200);
    const oldLogin = await req('/api/auth/login', { method: 'POST', body: { identifier: user.username, password: user.password } });
    expect(oldLogin.status).toBe(401);

    // 旧 Refresh Token 已被撤销
    const oldRefreshResult = await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: oldRefresh } });
    expect(oldRefreshResult.status).toBe(401);
  });

  it('不存在的邮箱返回统一成功（防枚举），弱新密码被拒绝', async () => {
    __clearMailOutbox();
    const ghost = await req('/api/auth/forgot-password', { method: 'POST', body: { email: 'ghost@test.local' } });
    expect(ghost.status).toBe(200);
    expect(ghost.body.success).toBe(true);
    expect(__getMailOutbox().some((m) => m.subject === '重置你的密码')).toBe(false);

    const user = await createUser({ username: 'weakreset' });
    await req('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } });
    const match = __getMailOutbox().find((m) => m.subject === '重置你的密码')!.html.match(/token=([a-f0-9]{64})/);
    const weak = await req('/api/auth/reset-password', { method: 'POST', body: { token: match![1], password: 'password' } });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('注册发送欢迎邮件（含 UID）', async () => {
    __clearMailOutbox();
    const user = await createUser({ username: 'welcomecheck' });
    const mails = __getMailOutbox();
    const welcome = mails.find((m) => m.subject === '欢迎加入 Starlr Forum');
    expect(welcome).toBeTruthy();
    expect(welcome!.to).toContain(user.email);
    const me = await req('/api/me', { token: user.accessToken });
    expect(welcome!.html).toContain(`UID：${me.body.user.uid}`);
  });
});

describe('邮件使用昵称', () => {
  it('注册昵称出现在欢迎邮件；修改昵称后后续邮件使用新昵称', async () => {
    __clearMailOutbox();
    const user = await createUser({ username: 'nickmailuser', nickname: '夜航星' });

    const welcome = __getMailOutbox().find((m) => m.subject === '欢迎加入 Starlr Forum');
    expect(welcome).toBeTruthy();
    expect(welcome!.html).toContain('夜航星');

    // 昵称可随时修改
    const patched = await req('/api/me', { method: 'PATCH', token: user.accessToken, body: { nickname: '晨光旅人' } });
    expect(patched.status).toBe(200);

    __clearMailOutbox();
    await req('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } });
    const reset = __getMailOutbox().find((m) => m.subject === '重置你的密码');
    expect(reset).toBeTruthy();
    expect(reset!.html).toContain('晨光旅人');
    expect(reset!.html).not.toContain('夜航星');
  });

  it('不填昵称时默认使用用户名', async () => {
    __clearMailOutbox();
    const user = await createUser({ username: 'nonickname' });
    const welcome = __getMailOutbox().find((m) => m.subject === '欢迎加入 Starlr Forum');
    expect(welcome!.html).toContain('nonickname');
    const me = await req('/api/me', { token: user.accessToken });
    expect(me.body.user.nickname).toBe('nonickname');
  });
});

describe('修改密码（登录态）', () => {
  it('当前密码错误被拒绝；成功后旧密码失效、旧 Refresh Token 失效', async () => {
    const user = await createUser({ username: 'changpwuser' });

    const wrong = await req('/api/me/password', {
      method: 'PATCH',
      token: user.accessToken,
      body: { currentPassword: 'WrongOld123!', newPassword: 'Changed2026!' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('WRONG_PASSWORD');

    const change = await req('/api/me/password', {
      method: 'PATCH',
      token: user.accessToken,
      body: { currentPassword: user.password, newPassword: 'Changed2026!' },
    });
    expect(change.status).toBe(200);

    expect(
      (await req('/api/auth/login', { method: 'POST', body: { identifier: user.username, password: user.password } })).status,
    ).toBe(401);
    expect(
      (await req('/api/auth/login', { method: 'POST', body: { identifier: user.username, password: 'Changed2026!' } })).status,
    ).toBe(200);
    expect(
      (await req('/api/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } })).status,
    ).toBe(401);
  });

  it('新密码不能与当前密码相同', async () => {
    const user = await createUser({ username: 'samepwuser' });
    const res = await req('/api/me/password', {
      method: 'PATCH',
      token: user.accessToken,
      body: { currentPassword: user.password, newPassword: user.password },
    });
    expect(res.status).toBe(400);
  });
});

describe('管理员邮件告警', () => {
  it('新举报触发管理员告警邮件', async () => {
    __clearMailOutbox();
    const admin = await createUser({ username: 'alertadmin' });
    await (env.DB as unknown as D1Database).prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(admin.id).run();
    const author = await createUser({ username: 'alertauthor' });
    const reporter = await createUser({ username: 'alertreporter' });

    const post = await req('/api/posts', {
      method: 'POST',
      token: author.accessToken,
      body: { title: '被举报的帖子', content: '正文内容', categoryId: 'cat0tech000000001', tags: [] },
    });
    __clearMailOutbox();
    await req('/api/reports', {
      method: 'POST',
      token: reporter.accessToken,
      body: { targetType: 'post', targetId: post.body.id, reason: 'spam', detail: '邮件告警测试' },
    });

    const mails = __getMailOutbox();
    const alert = mails.find((m) => m.subject.startsWith('[论坛管理]'));
    expect(alert).toBeTruthy();
    // 告警发送至 UID 1（站长）的邮箱
    const owner = await (env.DB as unknown as D1Database)
      .prepare('SELECT email FROM users WHERE uid = 1')
      .first<{ email: string }>();
    expect(owner?.email).toBeTruthy();
    expect(alert!.to).toContain(owner!.email);
  });

  it('授予管理员权限时向目标用户发送邮件通知', async () => {
    __clearMailOutbox();
    const admin = await createUser({ username: 'grantmailadmin' });
    await (env.DB as unknown as D1Database).prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(admin.id).run();
    const target = await createUser({ username: 'grantmailtarget' });
    const uid = (await req('/api/me', { token: target.accessToken })).body.user.uid as number;

    __clearMailOutbox();
    await req('/api/admin/admins', { method: 'POST', token: admin.accessToken, body: { uid, role: 'admin' } });
    const mail = __getMailOutbox().find((m) => m.to.includes(target.email));
    expect(mail).toBeTruthy();
    expect(mail!.subject).toContain('管理员');
  });
});
