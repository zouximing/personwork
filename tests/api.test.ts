import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import type { FastifyInstance } from 'fastify';
import { createServer } from 'node:http';

describe('HTTP contract and browser boundary', () => {
  let dir: string; let app: FastifyInstance;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'pwb-api-')); app = await createApp({ dataDir: dir, port: 4310, host: '127.0.0.1', origin: 'http://127.0.0.1:4310', remote: false }); });
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const headers = { host: '127.0.0.1:4310' };
  async function csrf(): Promise<string> { return (await app.inject({ url: '/api/session', headers })).json().csrfToken; }
  it('rejects cross-site writes and host rebinding before business mutations', async () => {
    const token = await csrf();
    const cross = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, origin: 'https://untrusted.invalid', 'x-workbench-csrf': token }, payload: { title: '不能写入' } });
    expect(cross.statusCode).toBe(403);
    expect((await app.inject({ url: '/api/bootstrap', headers: { host: 'untrusted.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/bootstrap', headers })).json().tasks).toHaveLength(0);
  });
  it('persists actual task requests and refuses stale revisions', async () => {
    const token = await csrf(); const writeHeaders = { ...headers, 'x-workbench-csrf': token };
    const created = await app.inject({ method: 'POST', url: '/api/tasks', headers: writeHeaders, payload: { title: '实际保存' } });
    expect(created.statusCode).toBe(201); const task = created.json();
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: writeHeaders, payload: { revision: task.revision, nextAction: '核验落盘' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, headers: writeHeaders, payload: { revision: task.revision, title: '不能覆盖' } })).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/bootstrap', headers })).json().tasks[0]).toMatchObject({ title: '实际保存', nextAction: '核验落盘' });
  });
  it('rejects missing CSRF and invalid task data without claiming a save', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { title: '拒绝' } })).statusCode).toBe(403);
    const token = await csrf();
    expect((await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, 'x-workbench-csrf': token }, payload: { title: '', credential: 'synthetic-secret' } })).statusCode).toBe(400);
  });
  it('requires CSRF, explicit confirmation and current revision for permanent deletion', async () => {
    const writeHeaders = { ...headers, 'x-workbench-csrf': await csrf() };
    const task = (await app.inject({ method: 'POST', url: '/api/tasks', headers: writeHeaders, payload: { title: '合成删除请求' } })).json();
    const url = `/api/tasks/${task.id}`;
    const payload = { revision: task.revision, confirm: true };
    expect((await app.inject({ method: 'DELETE', url, headers, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: { ...writeHeaders, origin: 'https://untrusted.invalid' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url, headers: writeHeaders, payload: { revision: task.revision } })).statusCode).toBe(400);
    const edited = (await app.inject({ method: 'PATCH', url, headers: writeHeaders, payload: { revision: task.revision, nextAction: '保留最新内容' } })).json();
    expect((await app.inject({ method: 'DELETE', url, headers: writeHeaders, payload })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url, headers: writeHeaders, payload: { revision: edited.revision, confirm: true } })).json()).toEqual({ deleted: true });
    expect((await app.inject({ url: '/api/bootstrap', headers })).json().tasks).toEqual([]);
    expect((await app.inject({ url: `/api/history/${task.id}`, headers })).json().items).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url, headers: writeHeaders, payload })).statusCode).toBe(404);
  });
  it('fails closed when remote mode lacks secure transport or authentication', () => {
    expect(() => readConfig({ WORKBENCH_HOST: '0.0.0.0' })).toThrow();
    expect(() => readConfig({ WORKBENCH_HOST: '0.0.0.0', WORKBENCH_ORIGIN: 'http://workbench.intranet:4310' })).toThrow();
  });
  it('protects earlier-registered source, model and execution routes with the same browser boundary', async () => {
    for (const url of ['/api/models', '/api/sources/pingcode/sync', '/api/executions', '/api/ai/decompose']) {
      const rejected = await app.inject({ method: 'POST', url, headers, payload: {} });
      expect(rejected.statusCode).toBe(403);
      const hostile = await app.inject({ url: url === '/api/sources/pingcode/sync' ? '/api/sources' : url, headers: { host: 'untrusted.invalid' } });
      expect(hostile.statusCode).toBe(403);
    }
  });
  it('authenticates remote access with a secure session and invalidates logout', async () => {
    await app.close();
    app = await createApp({ dataDir: dir, host: '0.0.0.0', port: 4310, origin: 'https://workbench.intranet:4310', remote: true, accessPassword: 'fixture-remote-login-passphrase' });
    const remoteHeaders = { host: 'workbench.intranet:4310' };
    const session = (await app.inject({ url: '/api/session', headers: remoteHeaders })).json();
    expect(session.authenticated).toBe(false);
    expect((await app.inject({ url: '/api/models', headers: remoteHeaders })).statusCode).toBe(401);
    const authenticatedHeaders = { ...remoteHeaders, 'x-workbench-csrf': session.csrfToken };
    expect((await app.inject({ method: 'POST', url: '/api/login', headers: authenticatedHeaders, payload: { password: 'incorrect-fixture' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: authenticatedHeaders, payload: { password: 'fixture-remote-login-passphrase' } });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('Secure'); expect(setCookie).toContain('SameSite=Strict');
    const loggedIn = { ...authenticatedHeaders, cookie: setCookie.split(';')[0] };
    expect((await app.inject({ url: '/api/bootstrap', headers: loggedIn })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/logout', headers: loggedIn, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/bootstrap', headers: loggedIn })).statusCode).toBe(401);
  });
  it('refuses restoration while a real model request is in flight', async () => {
    let arrived!: () => void; const arrival = new Promise<void>(resolve => { arrived = resolve; });
    const fixture = createServer((_request, response) => { arrived(); response.on('error', () => {}); });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback fixture');
    try {
      const writeHeaders = { ...headers, 'x-workbench-csrf': await csrf() };
      const task = (await app.inject({ method: 'POST', url: '/api/tasks', headers: writeHeaders, payload: { title: '在途请求期间不能删除' } })).json();
      const saved = (await app.inject({ method: 'POST', url: '/api/models', headers: writeHeaders, payload: { name: 'Maintenance fixture', kind: 'local', baseUrl: `http://127.0.0.1:${address.port}`, model: 'fixture', timeoutSeconds: 1 } })).json();
      const pending = app.inject({ method: 'POST', url: `/api/models/${saved.id}/test`, headers: writeHeaders, payload: { testTools: false } });
      const completion = Promise.resolve(pending); await arrival;
      const deletion = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, headers: writeHeaders, payload: { revision: task.revision, confirm: true } });
      expect(deletion.statusCode).toBe(409);
      const restore = await app.inject({ method: 'POST', url: '/api/backups/restore', headers: writeHeaders, payload: { password: 'fixture-backup-passphrase', content: 'invalid-fixture', confirm: true } });
      expect(restore.statusCode).toBe(409); expect(restore.json().error).toMatch(/进行|执行|请求/);
      await completion;
      expect((await app.inject({ url: '/api/models', headers })).json().items).toHaveLength(1);
    } finally { fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
  });
});
