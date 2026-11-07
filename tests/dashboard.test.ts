import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../apps/server/src/app.js';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management } from '../apps/server/src/management.js';
import { sourceObjectSchema } from '../packages/contracts/src/sources.js';
import { BackupService } from '../apps/server/src/backup.js';
import { SecretVault } from '../apps/server/src/secrets.js';
import { validateBackupSnapshot } from '../apps/server/src/backup-validation.js';

describe('today dashboard aggregation and transactional actions', () => {
  let dir: string; let app: FastifyInstance; let store: Workbench;
  const headers = { host: '127.0.0.1:4310' };
  let writeHeaders: Record<string, string>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T16:30:00Z'));
    dir = mkdtempSync(join(tmpdir(), 'pwb-dashboard-'));
    app = await createApp({ dataDir: dir, port: 4310, host: '127.0.0.1', origin: 'http://127.0.0.1:4310', remote: false });
    store = new Workbench(dir);
    writeHeaders = { ...headers, 'x-workbench-csrf': (await app.inject({ url: '/api/session', headers })).json().csrfToken };
  });
  afterEach(async () => { store.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
  const dashboard = async () => (await app.inject({ url: '/api/dashboard', headers })).json();
  const key = (id: string, revision: string, isKey = true) => app.inject({ method: 'POST', url: `/api/tasks/${id}/key`, headers: writeHeaders, payload: { revision, isKey } });

  it('returns all empty sections and key-empty reminder from one endpoint', async () => {
    const response = await app.inject({ url: '/api/dashboard', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ date: '2026-11-07', keyTasks: [], todayTodos: [], inProgress: [], waiting: [], nearDue: [], overdue: [], inboxCount: 0, completedToday: [], mrPendingCount: 0, mrOverdueCount: 0, mrItems: [], lineAlerts: [] });
    expect(response.json().reminders).toEqual([expect.objectContaining({ types: ['key_empty'], level: 'info' })]);
  });
  it('filters start dates, archived and ended tasks and sorts due dates then priority', async () => {
    store.createTask({ title: '无截止', status: 'todo' });
    store.createTask({ title: '中', status: 'todo', dueDate: '2026-11-07' });
    store.createTask({ title: '高', status: 'todo', dueDate: '2026-11-07', priority: 'high' });
    store.createTask({ title: '超期', status: 'todo', dueDate: '2026-11-06' });
    store.createTask({ title: '未来', status: 'todo', startDate: '2026-11-08' });
    store.createTask({ title: '归档', status: 'todo', archived: true, archiveReason: '合成' });
    store.createTask({ title: '明日截止', status: 'doing', dueDate: '2026-11-08' });
    const value = await dashboard();
    expect(value.todayTodos.map((t: { title: string }) => t.title)).toEqual(['超期', '高', '中', '无截止']);
    expect(value.overdue.map((t: { title: string }) => t.title)).toEqual(['超期']);
    expect(value.nearDue.map((t: { title: string }) => t.title)).toEqual(['高', '中']);
    expect(value.reminders.some((r: { title: string }) => r.title === '明日截止')).toBe(true);
  });
  it('limits keys through both dedicated and ordinary writes, frees completed slots and expires across Shanghai midnight', async () => {
    const tasks = Array.from({ length: 4 }, (_, i) => store.createTask({ title: `要事${i}` }));
    for (const task of tasks.slice(0, 3)) expect((await key(task.id, task.revision)).statusCode).toBe(200);
    expect((await key(tasks[3].id, tasks[3].revision)).statusCode).toBe(400);
    expect(() => store.patchTask(tasks[3].id, { revision: tasks[3].revision, keyDate: '2026-11-07' })).toThrow(/3/);
    expect(() => store.createTask({ title: '绕过', keyDate: '2026-11-07' })).toThrow(/3/);
    const selected = (await dashboard()).keyTasks;
    expect(selected).toHaveLength(3); expect(selected.every((t: { status: string }) => t.status === 'todo')).toBe(true);
    store.patchTask(selected[0].id, { revision: selected[0].revision, status: 'done' });
    expect((await key(tasks[3].id, tasks[3].revision)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-07T16:00:00Z'));
    expect((await dashboard()).keyTasks).toEqual([]);
    expect(store.getHistory(tasks[0].id).length).toBeGreaterThan(1);
  });
  it('atomically replaces keys and rejects stale revisions without partial updates', async () => {
    const tasks = Array.from({ length: 4 }, (_, i) => store.createTask({ title: `替换${i}` }));
    for (const task of tasks.slice(0, 3)) await key(task.id, task.revision);
    const current = (await dashboard()).keyTasks;
    const selected = [current[1], current[2], tasks[3]].map(t => ({ id: t.id, revision: t.revision }));
    const url = '/api/dashboard/key-tasks';
    const stale = await app.inject({ method: 'PUT', url, headers: writeHeaders, payload: { selected, current: current.map((t: { id: string; revision: string }) => ({ id: t.id, revision: t.id === current[0].id ? randomUUID() : t.revision })) } });
    expect(stale.statusCode).toBe(409); expect((await dashboard()).keyTasks).toHaveLength(3);
    const saved = await app.inject({ method: 'PUT', url, headers: writeHeaders, payload: { selected, current: current.map((t: { id: string; revision: string }) => ({ id: t.id, revision: t.revision })) } });
    expect(saved.statusCode).toBe(200);
    expect((await dashboard()).keyTasks.map((t: { id: string }) => t.id).sort()).toEqual(selected.map(t => t.id).sort());
  });
  it('records actual completion timestamps, preserves them on edits, excludes future dates and clears on reopening', async () => {
    const task = store.createTask({ title: '今日完成' });
    const done = store.patchTask(task.id, { revision: task.revision, status: 'done' });
    expect(done).toHaveProperty('completedAt', '2026-11-06T16:30:00.000Z');
    vi.setSystemTime(new Date('2026-11-07T03:00:00Z'));
    const edited = store.patchTask(done.id, { revision: done.revision, title: '完成后改标题' });
    expect(edited).toHaveProperty('completedAt', '2026-11-06T16:30:00.000Z');
    expect((await dashboard()).completedToday).toHaveLength(1);
    const reopened = store.patchTask(edited.id, { revision: edited.revision, status: 'todo' });
    expect(reopened).toHaveProperty('completedAt', null); expect((await dashboard()).completedToday).toHaveLength(0);
    expect(store.getHistory(task.id).some(e => e.kind === 'task.completed')).toBe(true);
  });
  it('merges deadline and waiting reminders for the same task and validates waiting fields', async () => {
    expect(() => store.createTask({ title: '缺等待', status: 'waiting' })).toThrow();
    const task = store.createTask({ title: '等待合成反馈', status: 'waiting', waitingFor: '代号A', waitingWhat: '合成反馈', followUpDate: '2026-11-05', dueDate: '2026-11-06' });
    const value = await dashboard();
    expect(value.waiting[0].id).toBe(task.id);
    const reminders = (await app.inject({ url: '/api/reminders', headers })).json().items;
    expect(reminders.filter((r: { targetId: string }) => r.targetId === task.id)).toEqual([expect.objectContaining({ level: 'danger', types: ['task_overdue', 'waiting_overdue'], detail: expect.stringMatching(/代号A.*2026-11-05/) })]);
  });
  it('rejects stale revisions and actions opened before a Shanghai date rollover', async () => {
    const task = store.createTask({ title: '跨日旧页' });
    const changed = store.patchTask(task.id, { revision: task.revision, nextAction: '最新安排' });
    expect((await key(task.id, task.revision)).statusCode).toBe(409);
    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/key`, headers: writeHeaders, payload: { revision: changed.revision, isKey: true, date: '2026-11-06' } });
    expect(response.statusCode).toBe(409);
    expect((await dashboard()).keyTasks).toHaveLength(0);
  });
  it('recovers legacy completion from events, excludes future completion and never guesses from an edit timestamp', async () => {
    const old = store.createTask({ title: '旧记录', status: 'todo' });
    const completed = store.patchTask(old.id, { revision: old.revision, status: 'done' });
    const legacy = Object.fromEntries(Object.entries(completed).filter(([key]) => !['completedAt', 'keyDate', 'startDate'].includes(key))) as typeof completed;
    store.storage.put('task', legacy, completed.revision);
    const noEvidence = store.createTask({ title: '无完成依据', status: 'done' });
    store.storage.put('task', { ...noEvidence, completedAt: null }, noEvidence.revision);
    const future = store.createTask({ title: '未来完成', status: 'done' });
    store.storage.put('task', { ...future, completedAt: '2026-11-07T16:00:00Z' }, future.revision);
    const value = await dashboard();
    expect(value.completedToday.map((task: { title: string }) => task.title)).toEqual(['旧记录']);
    expect(store.listTasks().find(task => task.id === old.id)).toMatchObject({ startDate: null, keyDate: null, completedAt: '2026-11-06T16:30:00.000Z' });
  });
  it('aggregates active line risk and weekly progress and only assigned pending opened MR snapshots', async () => {
    const manager = new Management(store); const line = manager.createLine({ name: '合成产线' });
    manager.createRisk({ title: '高风险', level: 'high', lineIds: [line.id] });
    manager.createRisk({ title: '过期中风险', targetCloseDate: '2026-11-06', lineIds: [line.id] });
    manager.createRisk({ title: '今天中风险', targetCloseDate: '2026-11-07', lineIds: [line.id] });
    manager.createPeriod({ title: '本周受阻', kind: 'week', lineId: line.id, start: '2026-11-02', end: '2026-11-08', progressStatus: 'blocked' });
    for (let i = 0; i < 13; i++) {
      const id = randomUUID(); store.storage.put('source-record', sourceObjectSchema.parse({ id, revision: randomUUID(), createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', provider: 'gitlab', instanceId: line.id, projectId: '1', projectName: '合成项目', externalId: String(i), number: String(i), title: `MR${i}`, url: 'https://gitlab.invalid/1', sourceState: i === 11 ? 'merged' : 'opened', sourceStateId: 'opened', sourceDueDate: null, sourcePriority: '', author: '合成', assigneeId: '', currentSha: null, checkedSha: null, reviewStatus: i === 12 ? 'reviewed' : 'not_started', conclusion: '', followUpDate: null, needsReview: false, reviewAssignmentChanged: false, assignedToMe: true, assignedAsReviewer: i !== 10, attentionReason: '', localTaskId: null, lastSeenAt: '2026-11-06T00:00:00Z', sourceUpdatedAt: null }));
    }
    const value = await dashboard();
    expect(value.lineAlerts.map((r: { title: string }) => r.title).sort()).toEqual(['本周受阻', '过期中风险', '高风险'].sort());
    expect(value.mrPendingCount).toBe(10); expect(value.mrItems).toHaveLength(10); expect(value.mrOverdueCount).toBe(10);
    expect(value.mrItems[0]).toMatchObject({ stayDays: 3, overdue: true });
  });
  it('persists reminder settings, rejects stale and invalid updates and includes settings in backups', async () => {
    const get = await app.inject({ url: '/api/dashboard/settings', headers }); expect(get.statusCode).toBe(200);
    const previous = get.json(); expect(previous).toMatchObject({ deadlineLeadDays: 1, lineUpdateWeekday: 5, browserNotify: false, mrBacklogDays: 2 });
    const payload = { ...previous, deadlineLeadDays: 4, mrBacklogDays: 5 };
    const updated = await app.inject({ method: 'PUT', url: '/api/dashboard/settings', headers: writeHeaders, payload });
    expect(updated.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/dashboard/settings', headers: writeHeaders, payload })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: '/api/dashboard/settings', headers: writeHeaders, payload: { ...updated.json<Record<string, unknown>>(), deadlineLeadDays: -1 } })).statusCode).toBe(400);
    const backups = new BackupService(store, new SecretVault(dir));
    expect(backups.snapshot().documents).toContainEqual(expect.objectContaining({ kind: 'dashboard-settings', data: expect.objectContaining({ deadlineLeadDays: 4 }) }));
  });
  it('computes recruitment, weekly-update and next-month reminders using existing records', async () => {
    vi.setSystemTime(new Date('2026-11-27T03:00:00Z'));
    const manager = new Management(store); const line = manager.createLine({ name: '合成月末产线' });
    manager.createPeriod({ title: '本月目标', kind: 'month', lineId: line.id, start: '2026-11-01', end: '2026-11-30' });
    manager.createPeriod({ title: '未填周进展', kind: 'week', lineId: line.id, start: '2026-11-23', end: '2026-11-29' });
    store.createTask({ title: '脱敏面试', type: 'recruitment', followUpDate: '2026-11-28' });
    store.createTask({ title: '已结束面试', type: 'recruitment', status: 'cancelled', followUpDate: '2026-11-28' });
    const value = await dashboard(); const types = value.reminders.flatMap((r: { types: string[] }) => r.types);
    expect(types).toEqual(expect.arrayContaining(['interview', 'line_weekly_update', 'line_monthly_init']));
    expect(value.reminders.some((r: { title: string }) => r.title === '已结束面试')).toBe(false);
    expect(value.reminders[0].level).toBe('danger');
  });
  it('roundtrips dashboard settings, keys and completion through encrypted backup restore', async () => {
    const backups = new BackupService(store, new SecretVault(dir));
    const task = store.createTask({ title: '备份要事', keyDate: '2026-11-07' });
    const done = store.createTask({ title: '备份完成', status: 'done' });
    const previous = (await app.inject({ url: '/api/dashboard/settings', headers })).json<Record<string, unknown>>();
    await app.inject({ method: 'PUT', url: '/api/dashboard/settings', headers: writeHeaders, payload: { ...previous, deadlineLeadDays: 3 } });
    const archive = await backups.export('synthetic-dashboard-passphrase');
    store.patchTask(task.id, { revision: task.revision, keyDate: null });
    await backups.restore(archive, 'synthetic-dashboard-passphrase');
    const value = await dashboard();
    expect(value.settings.deadlineLeadDays).toBe(3);
    expect(value.keyTasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    expect(value.completedToday[0].completedAt).toBe(done.completedAt);
    expect(value.keyTasks[0].revision).not.toBe(task.revision);
  });
  it('reopens an expired key without consuming yesterday quota or breaking backup', async () => {
    const task = store.createTask({ title: '昨日已完成要事', keyDate: '2026-11-07' });
    const done = store.patchTask(task.id, { revision: task.revision, status: 'done' });
    for (let i = 0; i < 3; i++) store.createTask({ title: `昨日替补${i}`, keyDate: '2026-11-07' });
    vi.setSystemTime(new Date('2026-11-07T16:00:00Z'));
    expect(() => store.patchTask(done.id, { revision: done.revision, status: 'todo' })).not.toThrow();
    expect((await dashboard()).keyTasks).toEqual([]);
    const backup = new BackupService(store, new SecretVault(dir));
    expect(() => backup.snapshot()).not.toThrow();
    const archive = await backup.export('synthetic-expired-key-passphrase');
    await backup.restore(archive, 'synthetic-expired-key-passphrase');
    expect(store.listTasks().find(value => value.id === task.id)?.status).toBe('todo');
    expect((await dashboard()).keyTasks).toEqual([]);
  });
  it('still enforces upcoming key quotas in task writes and backup validation', () => {
    for (let i = 0; i < 3; i++) store.createTask({ title: `未来要事${i}`, keyDate: '2026-11-08' });
    expect(() => store.createTask({ title: '未来第四件', keyDate: '2026-11-08' })).toThrow('今日要事已满');
    const snapshot = new BackupService(store, new SecretVault(dir)).snapshot();
    snapshot.tasks.push({ ...snapshot.tasks[0], id: randomUUID(), revision: randomUUID() });
    expect(() => validateBackupSnapshot(snapshot)).toThrow('Too many daily key tasks');
  });
});
