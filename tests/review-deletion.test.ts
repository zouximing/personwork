import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { ReviewView } from '../packages/contracts/src/management.js';
import { createApp } from '../apps/server/src/app.js';
import { Workbench } from '../apps/server/src/workbench.js';

describe('confirmed review deletion through HTTP and SQLite', () => {
  let dir: string;
  let app: FastifyInstance;
  let writeHeaders: Record<string, string>;
  const config = { port: 4310, host: '127.0.0.1', origin: 'http://127.0.0.1:4310', remote: false };
  const headers = { host: '127.0.0.1:4310' };
  const range = { kind: 'week', start: '2026-11-02', end: '2026-11-08' };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pwb-review-delete-'));
    app = await createApp({ ...config, dataDir: dir });
    const session = (await app.inject({ url: '/api/session', headers })).json();
    writeHeaders = { ...headers, 'x-workbench-csrf': session.csrfToken };
  });
  afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  async function createReview(title = '合成历史回顾'): Promise<ReviewView> {
    const response = await app.inject({ method: 'POST', url: '/api/reviews', headers: writeHeaders, payload: { title, ...range } });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  const remove = (review: ReviewView, payload: Record<string, unknown> = { revision: review.revision, confirm: true }) =>
    app.inject({ method: 'DELETE', url: `/api/reviews/${review.id}`, headers: writeHeaders, payload });
  const list = async (): Promise<ReviewView[]> => (await app.inject({ url: '/api/reviews', headers })).json().items;

  it('deletes a published review and all versions durably while retaining source facts and other reviews', async () => {
    const task = (await app.inject({ method: 'POST', url: '/api/tasks', headers: writeHeaders, payload: { title: '保留的合成任务' } })).json();
    const line = (await app.inject({ method: 'POST', url: '/api/lines', headers: writeHeaders, payload: { name: '合成产线' } })).json();
    const period = (await app.inject({ method: 'POST', url: '/api/periods', headers: writeHeaders, payload: { title: '保留的合成计划', lineId: line.id, ...range, taskIds: [task.id] } })).json();
    expect(period.id).toBeTruthy();
    const response = await app.inject({ method: 'POST', url: '/api/reviews', headers: writeHeaders, payload: { title: '待删合成回顾', ...range, selections: { taskIds: [task.id], periodIds: [period.id] } } });
    const review: ReviewView = response.json();
    expect(review.facts).toHaveLength(2);
    const published: ReviewView = (await app.inject({ method: 'POST', url: `/api/reviews/${review.id}/publish`, headers: writeHeaders, payload: { revision: review.revision } })).json();
    expect(published.versions).toHaveLength(1);
    const other = await createReview('保留的其他回顾');
    expect((await remove(published)).statusCode).toBe(200);
    expect((await list()).map(item => item.id)).toEqual([other.id]);
    const db = new Workbench(dir);
    try {
      expect(db.storage.get('review', review.id)).toBeUndefined();
      expect(db.getHistory(review.id).some(event => event.kind === 'review.deleted')).toBe(true);
    } finally { db.close(); }
    await app.close();
    app = await createApp({ ...config, dataDir: dir });
    expect((await list()).map(item => item.id)).toEqual([other.id]);
    expect((await app.inject({ url: '/api/tasks', headers })).json().items).toEqual([task]);
    expect((await app.inject({ url: '/api/periods', headers })).json().items[0]).toMatchObject({ id: period.id, taskIds: [task.id] });
  });

  it.each(['brief', 'sections'])('deletes an unpublished %s review', async format => {
    const response = await app.inject({ method: 'POST', url: '/api/reviews', headers: writeHeaders, payload: { title: '合成草稿', ...range, format } });
    expect((await remove(response.json())).statusCode).toBe(200);
    expect(await list()).toEqual([]);
  });

  it('requires explicit confirmation and a valid revision before mutating the record', async () => {
    const review = await createReview();
    for (const payload of [{ revision: review.revision }, { revision: review.revision, confirm: false }, { confirm: true }, { revision: 'invalid', confirm: true }]) {
      expect((await remove(review, payload)).statusCode).toBe(400);
    }
    expect((await list())[0]).toMatchObject({ id: review.id, revision: review.revision });
  });

  it('refuses stale revisions and repeated deletion without deleting another record', async () => {
    const review = await createReview();
    const changed: ReviewView = (await app.inject({ method: 'PATCH', url: `/api/reviews/${review.id}`, headers: writeHeaders, payload: { revision: review.revision, title: '其他窗口更新' } })).json();
    expect((await remove(review)).statusCode).toBe(409);
    expect((await list())[0]).toMatchObject({ title: changed.title, revision: changed.revision });
    expect((await remove(changed)).statusCode).toBe(200);
    expect((await remove(changed)).statusCode).toBe(404);
  });

  it('applies CSRF and origin protection to deletion', async () => {
    const review = await createReview();
    const payload = { revision: review.revision, confirm: true };
    expect((await app.inject({ method: 'DELETE', url: `/api/reviews/${review.id}`, headers, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/reviews/${review.id}`, headers: { ...writeHeaders, origin: 'https://untrusted.invalid' }, payload })).statusCode).toBe(403);
    expect((await list()).map(item => item.id)).toEqual([review.id]);
  });

  it('rolls deletion back if its audit event cannot be saved', async () => {
    const review = await createReview();
    const db = new Workbench(dir);
    try {
      db.storage.database.exec("CREATE TRIGGER fail_review_deletion BEFORE INSERT ON events WHEN NEW.kind = 'review.deleted' BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END;");
      expect((await remove(review)).statusCode).toBe(500);
      expect((await list())[0]).toMatchObject({ id: review.id, revision: review.revision });
      expect(db.getHistory(review.id).some(event => event.kind === 'review.deleted')).toBe(false);
      db.storage.database.exec('DROP TRIGGER fail_review_deletion;');
      expect((await remove(review)).statusCode).toBe(200);
    } finally { db.close(); }
  });

  it('keeps a deleted review absent when exporting and restoring a new backup with audit history', async () => {
    const review = await createReview();
    expect((await remove(review)).statusCode).toBe(200);
    const password = 'synthetic-review-deletion-backup';
    const backup = await app.inject({ method: 'POST', url: '/api/backups/export', headers: writeHeaders, payload: { password } });
    expect(backup.statusCode).toBe(200);
    const restored = await app.inject({ method: 'POST', url: '/api/backups/restore', headers: writeHeaders, payload: { password, content: backup.rawPayload.toString('base64'), confirm: true } });
    expect(restored.statusCode).toBe(200);
    expect(await list()).toEqual([]);
    const history = (await app.inject({ url: `/api/history/${review.id}`, headers })).json().items;
    expect(history.some((event: { kind: string }) => event.kind === 'review.deleted')).toBe(true);
  });

  it('refuses a late model result instead of recreating a deleted review', async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; });
    let upstream!: ServerResponse;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => { upstream = response; arrived(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing model fixture port');
    let completion: Promise<unknown> | undefined;
    try {
      const model = await app.inject({ method: 'POST', url: '/api/models', headers: writeHeaders, payload: { name: '合成延迟模型', kind: 'local', baseUrl: `http://127.0.0.1:${address.port}`, model: 'fixture', timeoutSeconds: 2 } });
      expect(model.statusCode).toBe(200);
      const review = await createReview();
      const pending = Promise.resolve(app.inject({ method: 'POST', url: '/api/ai/summarize', headers: writeHeaders, payload: { modelId: model.json().id, reviewId: review.id, dataClass: 'public' } }));
      completion = pending;
      await arrival;
      expect((await remove(review)).statusCode).toBe(200);
      upstream.writeHead(200, { 'Content-Type': 'application/json' });
      upstream.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '合成迟到总结' } }] }));
      expect((await pending).statusCode).toBe(409);
      expect(await list()).toEqual([]);
      const history = (await app.inject({ url: `/api/history/${review.id}`, headers })).json().items;
      expect(history.some((event: { kind: string }) => event.kind === 'review.ai-draft.saved')).toBe(false);
    } finally {
      server.closeAllConnections();
      await completion;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
