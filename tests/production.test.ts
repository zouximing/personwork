import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management, registerManagementRoutes } from '../apps/server/src/management.js';
import { lineSchema, riskSchema } from '../packages/contracts/src/management.js';
import { cycleRange, lineOverview, monthCompletion, progressState } from '../packages/contracts/src/production.js';
import { BackupService } from '../apps/server/src/backup.js';
import { SecretVault } from '../apps/server/src/secrets.js';
import { validateBackupSnapshot } from '../apps/server/src/backup-validation.js';
import { DashboardService } from '../apps/server/src/dashboard.js';

describe('FR-19 through FR-25 production management', () => {
  let dir: string;
  let store: Workbench;
  let manager: Management;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T04:00:00Z'));
    dir = mkdtempSync(join(tmpdir(), 'pwb-production-')); store = new Workbench(dir); manager = new Management(store);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
  const month = { kind: 'month', start: '2026-11-01', end: '2026-11-30' };
  const week = { kind: 'week', start: '2026-11-02', end: '2026-11-08' };
  const line = () => manager.createLine({ name: '合成产线', owner: '代号A' });
  async function call(method: 'GET' | 'POST', url: string, payload?: object) {
    const app = Fastify(); registerManagementRoutes(app, store);
    try { const response = await app.inject({ method, url, ...(payload ? { payload } : {}) }); return { status: response.statusCode, body: response.json() }; }
    finally { await app.close(); }
  }

  it('rejects changes that break either side of a carry chain without changing stored history', () => {
    const l = line(); const other = manager.createLine({ name: '另一线' });
    const source = manager.createPeriod({ kind: 'month', lineId: l.id, title: '结转源', start: '2026-10-01', end: '2026-10-31' });
    const child = manager.carryPeriod(source.id, { revision: source.revision, start: month.start, end: month.end, reason: '继续' });
    const current = manager.listPeriods().find(p => p.id === source.id)!;
    const before = new BackupService(store, new SecretVault(dir)).snapshot();
    for (const [p, patch] of [
      [current, { lineId: other.id }], [current, { end: '2026-11-01', changeReason: '调整' }],
      [child, { lineId: other.id }], [child, { start: '2026-10-31', changeReason: '调整' }]
    ] as const) expect(() => manager.patchPeriod(p.id, { revision: p.revision, ...patch })).toThrow(/结转/);
    const after = new BackupService(store, new SecretVault(dir)).snapshot();
    expect(after.documents).toEqual(before.documents); expect(after.events).toEqual(before.events);
    expect(() => validateBackupSnapshot(after)).not.toThrow();
  });

  it('requires natural cycles for newly created priorities while preserving old custom records', () => {
    const l = line();
    expect(() => manager.createPeriod({ ...week, lineId: l.id, title: '非完整周', start: '2026-11-04' })).toThrow(/自然/);
    expect(() => manager.createPeriod({ ...month, lineId: l.id, title: '非完整月', end: '2026-11-29' })).toThrow(/自然/);
    const p = manager.createPeriod({ ...week, lineId: l.id, title: '旧周期' });
    store.storage.put('period', { ...p, start: '2026-11-04' }, p.revision);
    expect(manager.patchPeriod(p.id, { revision: p.revision, actual: '兼容内容更新' }).actual).toBe('兼容内容更新');
  });

  it('marks month-end history incomplete when a legacy carry has no initial snapshot and is later moved', () => {
    vi.setSystemTime(new Date('2026-09-20T04:00:00Z')); const l = line();
    const p = manager.createPeriod({ kind: 'month', lineId: l.id, title: '旧来源', start: '2026-09-01', end: '2026-09-30' });
    vi.setSystemTime(new Date('2026-10-02T04:00:00Z'));
    const child = manager.carryPeriod(p.id, { revision: p.revision, start: '2026-10-01', end: '2026-10-31', reason: '旧结转' });
    store.storage.database.prepare("UPDATE events SET details = json_remove(details, '$.record') WHERE resource_id = ? AND kind = 'period.carried'").run(child.id);
    vi.setSystemTime(new Date('2026-11-02T04:00:00Z'));
    manager.patchPeriod(child.id, { revision: child.revision, start: '2026-11-01', end: '2026-11-30', changeReason: '迁月' });
    manager.checkCycles();
    expect(manager.production().summaries.find(s => s.month === '2026-10')).toMatchObject({ historyComplete: false });
  });

  it('rejects oversized generated sections before storing any review', () => {
    const l = line();
    for (let i = 0; i < 2; i++) manager.createPeriod({ ...week, lineId: l.id, title: `长进展${i}`, actual: '进'.repeat(11000) });
    expect(() => manager.createReview({ ...week, title: '过长章节', format: 'sections' })).toThrow(/过长/);
    expect(manager.listReviews()).toEqual([]);
    expect(store.storage.history().filter(e => e.kind === 'review.created')).toEqual([]);
    expect(() => validateBackupSnapshot(new BackupService(store, new SecretVault(dir)).snapshot())).not.toThrow();
  });

  it('persists month completion and notes without resetting omitted PATCH fields', () => {
    const l = line();
    const p = manager.createPeriod({ ...month, lineId: l.id, title: '目标', completion: 35, notes: '交付备注' });
    expect(p).toMatchObject({ completion: 35, notes: '交付备注' });
    expect(manager.patchPeriod(p.id, { revision: p.revision, owner: '代号B' })).toMatchObject({ completion: 35, notes: '交付备注' });
    const done = manager.patchPeriod(p.id, { revision: manager.listPeriods()[0].revision, status: 'done' });
    expect(done.completion).toBe(100);
    expect(() => manager.createPeriod({ ...month, lineId: l.id, title: '错误完成度', completion: 101 })).toThrow();
  });

  it('records four weekly progress states while keeping month delivery independent', () => {
    const l = line(); const m = manager.createPeriod({ ...month, lineId: l.id, title: '月交付' });
    const p = manager.createPeriod({ ...week, lineId: l.id, title: '周阶段', monthlyId: m.id, progressStatus: 'at_risk', actual: '等待样机' });
    expect(p).toMatchObject({ progressStatus: 'at_risk' });
    const blocked = manager.patchPeriod(p.id, { revision: p.revision, progressStatus: 'blocked' });
    expect(blocked).toMatchObject({ progressStatus: 'blocked', status: 'blocked' });
    const done = manager.patchPeriod(p.id, { revision: blocked.revision, progressStatus: 'done' });
    expect(done.status).toBe('done');
    expect(manager.listPeriods().find(value => value.id === m.id)?.status).toBe('planned');
  });

  it('provides safe defaults for old persisted records', () => {
    const l = line(); const p = manager.createPeriod({ ...month, lineId: l.id, title: '旧重点' });
    const r = manager.createRisk({ title: '旧风险', lineIds: [l.id] });
    const strip = (value: object, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    store.storage.put('line', strip(l, ['reminderWeekday']) as typeof l, l.revision);
    store.storage.put('period', strip(p, ['completion', 'notes', 'progressStatus']) as typeof p, p.revision);
    store.storage.put('risk', strip(r, ['level', 'targetCloseDate', 'escalated']) as typeof r, r.revision);
    expect(lineSchema.parse(manager.listLines()[0]).reminderWeekday).toBe(5);
    expect(manager.listPeriods()[0].completion).toBe(0);
    expect(riskSchema.parse(manager.listRisks()[0])).toMatchObject({ level: 'medium', targetCloseDate: null, escalated: false });
  });

  it('calculates current month rate, four-state counts, colored risk counts and Friday reminders', async () => {
    vi.setSystemTime(new Date('2026-11-05T04:00:00Z'));
    const l = line();
    manager.createPeriod({ ...month, lineId: l.id, title: '完成', status: 'done' });
    manager.createPeriod({ ...month, lineId: l.id, title: '在做', completion: 70 });
    manager.createPeriod({ ...month, lineId: l.id, title: '取消', status: 'cancelled' });
    manager.createPeriod({ ...week, lineId: l.id, title: '风险项', progressStatus: 'at_risk' });
    manager.createRisk({ title: '高风险', lineIds: [l.id], level: 'high', targetCloseDate: '2026-11-07', escalated: true });
    manager.createRisk({ title: '低等级但逾期', lineIds: [l.id], level: 'low', targetCloseDate: '2026-11-05' });
    const result = await call('GET', '/api/production?date=2026-11-06');
    expect(result.status).toBe(200);
    expect(result.body.lines[0]).toMatchObject({ monthly: { total: 2, done: 1, rate: 50 }, weekly: { at_risk: 1 }, openRisks: { high: 1, medium: 0, low: 1 }, warningRiskIds: expect.any(Array) });
    expect(result.body.lines[0].warningRiskIds).toHaveLength(2);
    expect(result.body.lines[0].reminders).toContain('weekly-update');
    expect(result.body.lines[0].reminders).not.toContain('initialize-month');
  });

  it('carries all unfinished previous-month items atomically and retries without duplicates', async () => {
    const l = line(); const previous = { kind: 'month', start: '2026-10-01', end: '2026-10-31' };
    const p = manager.createPeriod({ ...previous, lineId: l.id, title: '遗留交付', completion: 60, notes: '保留备注' });
    manager.createPeriod({ ...previous, lineId: l.id, title: '完成不结转', status: 'done' });
    manager.createPeriod({ ...previous, lineId: l.id, title: '取消不结转', status: 'cancelled' });
    const payload = { lineId: l.id, ...month, reason: '新月继续' };
    const first = await call('POST', '/api/periods/carry-previous', payload);
    expect(first.status).toBe(200); expect(first.body.created).toBe(1);
    expect(first.body.items[0]).toMatchObject({ carriedFromId: p.id, completion: 0, notes: '保留备注', status: 'planned' });
    const retry = await call('POST', '/api/periods/carry-previous', payload);
    expect(retry.status).toBe(200); expect(retry.body.created).toBe(0);
    expect(retry.body.items[0].id).toBe(first.body.items[0].id);
    expect(manager.listPeriods().find(value => value.id === p.id)).toMatchObject({ completion: 60, status: 'planned' });
    const invalid = await call('POST', '/api/periods/carry-previous', { ...payload, start: '2026-11-02' });
    expect(invalid.status).toBe(400);
  });

  it('reuses single carry on retries and detects all last-week leftovers without title matching', async () => {
    const l = line(); const p = manager.createPeriod({ kind: 'week', lineId: l.id, title: '上周遗留', start: '2026-10-26', end: '2026-11-01' });
    const payload = { revision: p.revision, start: week.start, end: week.end, reason: '继续' };
    const c = manager.carryPeriod(p.id, payload);
    expect(manager.carryPeriod(p.id, payload).id).toBe(c.id);
    const result = await call('GET', '/api/production?date=2026-11-06');
    expect(result.status).toBe(200);
    expect(result.body.lines[0].leftovers).toEqual([expect.objectContaining({ id: p.id, carriedToCurrent: true })]);
  });

  it('shows empty monthly rate, custom weekday reminders and no warnings for closed or due-today risks', async () => {
    const l = manager.createLine({ name: '提醒线', reminderWeekday: 3 });
    manager.createRisk({ title: '今天到期', lineIds: [l.id], level: 'low', targetCloseDate: '2026-11-06' });
    manager.createRisk({ title: '高风险已闭环', lineIds: [l.id], level: 'high', status: 'closed', result: '解决', evidence: '检查通过' });
    const result = await call('GET', '/api/production?date=2026-11-06');
    expect(result.status).toBe(200);
    expect(result.body.lines[0]).toMatchObject({ monthly: { total: 0, done: 0, rate: null }, warningRiskIds: [], reminders: expect.arrayContaining(['weekly-update', 'initialize-week', 'initialize-month']) });
  });

  it('adds a separate editable production section to weekly reports with only in-range new and closed risks', () => {
    vi.setSystemTime(new Date('2026-10-20T04:00:00Z')); const l = line();
    const closing = manager.createRisk({ title: '本周闭环风险', lineIds: [l.id], level: 'medium' });
    manager.createRisk({ title: '旧风险仍开放', lineIds: [l.id] });
    vi.setSystemTime(new Date('2026-11-06T04:00:00Z'));
    manager.createPeriod({ ...week, lineId: l.id, title: '样机联调', progressStatus: 'at_risk', actual: '环境待就绪' });
    manager.createRisk({ title: '本周新增风险', lineIds: [l.id], level: 'high' });
    manager.patchRisk(closing.id, { revision: closing.revision, status: 'closed', result: '修复', evidence: '回归通过' });
    const privateTask = store.createTask({ title: '隐藏姓名', type: 'people' });
    manager.createPeriod({ ...week, lineId: l.id, title: '隐藏产线事项', taskIds: [privateTask.id] });
    const report = manager.createReview({ title: '周报', ...week });
    expect(report.reportBody).toContain('产线进展');
    expect(report.markdown).toContain('## 产线进展');
    expect(report.reportBody).toContain('样机联调'); expect(report.reportBody).toContain('有风险');
    expect(report.reportBody).toContain('新增：本周新增风险'); expect(report.reportBody).toContain('闭环：本周闭环风险');
    expect(report.reportBody).not.toContain('旧风险仍开放'); expect(report.reportBody).not.toContain('隐藏产线事项');
    expect(report.facts.map(f => f.title)).not.toContain('隐藏产线事项');
    const published = manager.publishReview(report.id, { revision: report.revision });
    expect(published.versions[0].markdown).toContain('产线进展');
    store.close(); store = new Workbench(dir); manager = new Management(store);
    expect(manager.listReviews()[0].versions).toEqual(published.versions);
    const edit = manager.patchReview(report.id, { revision: published.revision, reportBody: '人工产线进展修订' });
    expect(edit.markdown).toContain('人工产线进展修订');
  });

  it('rolls back a whole batch if an event write fails', async () => {
    const l = line(); const previous = { kind: 'month', start: '2026-10-01', end: '2026-10-31' };
    const a = manager.createPeriod({ ...previous, lineId: l.id, title: 'A' });
    const b = manager.createPeriod({ ...previous, lineId: l.id, title: 'B' });
    const original = store.storage.event.bind(store.storage);
    const spy = vi.spyOn(store.storage, 'event').mockImplementation((id, kind, details) => {
      if (kind === 'period.carried' && details.fromId === b.id) throw new Error('synthetic disk error');
      original(id, kind, details);
    });
    const result = await call('POST', '/api/periods/carry-previous', { lineId: l.id, ...month, reason: '继续' });
    expect(result.status).toBe(500); spy.mockRestore();
    expect(manager.listPeriods()).toHaveLength(2);
    expect(manager.listPeriods().find(value => value.id === a.id)?.carriedToIds).toEqual([]);
  });

  it('captures month-end status from history on catch-up, once per month and across restart', async () => {
    vi.setSystemTime(new Date('2026-10-25T04:00:00Z')); const l = line();
    const p = manager.createPeriod({ kind: 'month', lineId: l.id, title: '跨月目标', start: '2026-10-01', end: '2026-10-31' });
    vi.setSystemTime(new Date('2026-11-02T04:00:00Z'));
    manager.patchPeriod(p.id, { revision: p.revision, status: 'done' });
    manager.checkCycles(); manager.checkCycles();
    const summaries = store.getHistory(l.id).filter(event => event.kind === 'line.month-summarized');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].details).toMatchObject({ month: '2026-10', total: 1, done: 0, rate: 0, historyComplete: true });
    store.close(); store = new Workbench(dir); manager = new Management(store); manager.checkCycles();
    expect(store.getHistory(l.id).filter(event => event.kind === 'line.month-summarized')).toHaveLength(1);
    const result = await call('GET', '/api/production?date=2026-11-02');
    expect(result.body.summaries[0]).toMatchObject({ month: '2026-10', rate: 0 });
  });

  it('omits private linked material from dashboards and blocks old production reports when privacy changes', async () => {
    const l = line(); const t = store.createTask({ title: '普通事项' });
    const p = manager.createPeriod({ ...week, lineId: l.id, title: '关联重点', taskIds: [t.id] });
    const alert = manager.createRisk({ title: '隐私风险', lineIds: [l.id], periodIds: [p.id], level: 'high' });
    const report = manager.createReview({ title: '先公开后私密', ...week });
    expect(report.facts.some(f => f.id === p.id)).toBe(true);
    store.patchTask(t.id, { revision: t.revision, type: 'people' });
    expect(manager.listReviews()[0].exportBlocked).toBe(true);
    expect(new DashboardService(store).get().lineAlerts.some(r => r.id.includes(alert.id))).toBe(false);
    const result = await call('GET', '/api/production?date=2026-11-06');
    expect(JSON.stringify(result.body)).not.toContain(p.title);
  });

  it('keeps Shanghai reminder boundaries and cross-year natural cycles precise', () => {
    expect(cycleRange('week', '2027-01-01')).toEqual(['2026-12-28', '2027-01-03']);
    expect(cycleRange('month', '2028-02-20')).toEqual(['2028-02-01', '2028-02-29']);
    expect(monthCompletion([{ status: 'cancelled' }])).toEqual({ total: 0, done: 0, rate: null });
    expect(progressState({ status: 'waiting' })).toBe('at_risk');
    const l = line();
    const p = manager.createPeriod({ ...week, lineId: l.id, title: '提醒边界', progressStatus: 'normal' });
    const beforeFriday = { ...p, updatedAt: '2026-11-05T15:59:59Z' };
    const onFriday = { ...p, updatedAt: '2026-11-05T16:00:00Z' };
    expect(lineOverview(l, [beforeFriday], [], '2026-11-06').reminders).toContain('weekly-update');
    expect(lineOverview(l, [onFriday], [], '2026-11-06').reminders).not.toContain('weekly-update');
    expect(lineOverview(l, [beforeFriday], [], '2026-11-05').reminders).not.toContain('weekly-update');
  });

  it('records blocked month tasks without requiring unrelated feedback fields and allows more than five priorities', () => {
    const l = line();
    const p = manager.createPeriod({ ...month, lineId: l.id, title: '受阻目标', status: 'blocked', completion: 20 });
    expect(p.status).toBe('blocked');
    for (let i = 0; i < 5; i++) manager.createPeriod({ ...month, lineId: l.id, title: `目标${i}` });
    expect(manager.listPeriods()).toHaveLength(6);
    expect(() => manager.patchPeriod(p.id, { revision: p.revision, completion: 100 })).toThrow(/已完成/);
  });

  it('keeps incomplete month-end history visibly unverified and summarizes empty missed months', async () => {
    vi.setSystemTime(new Date('2026-08-20T04:00:00Z')); const l = line();
    const p = manager.createPeriod({ kind: 'month', lineId: l.id, title: '缺失历史', start: '2026-08-01', end: '2026-08-31' });
    store.storage.database.prepare('DELETE FROM events WHERE resource_id = ?').run(p.id);
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z')); manager.checkCycles();
    const result = await call('GET', '/api/production');
    expect(result.body.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ month: '2026-08', historyComplete: false }),
      expect.objectContaining({ month: '2026-09', rate: null }),
      expect.objectContaining({ month: '2026-10', rate: null })
    ]));
  });

  it('calculates month-end ownership and month before later plan changes', async () => {
    vi.setSystemTime(new Date('2026-10-25T04:00:00Z')); const l = line();
    const p = manager.createPeriod({ kind: 'month', lineId: l.id, title: '后续调整周期', start: '2026-10-01', end: '2026-10-31', status: 'done' });
    vi.setSystemTime(new Date('2026-11-02T04:00:00Z'));
    manager.patchPeriod(p.id, { revision: p.revision, start: '2026-11-01', end: '2026-11-30', changeReason: '次月另行统计' });
    manager.checkCycles();
    const result = await call('GET', '/api/production');
    expect(result.body.summaries.find((s: { month: string }) => s.month === '2026-10')).toMatchObject({ total: 1, done: 1, rate: 100 });
  });

  it('roundtrips new fields, blocked weekly progress and month summaries through encrypted backup', async () => {
    vi.setSystemTime(new Date('2026-10-30T04:00:00Z')); const l = manager.createLine({ name: '备份线', reminderWeekday: 2 });
    const m = manager.createPeriod({ kind: 'month', lineId: l.id, title: '历史月目标', start: '2026-10-01', end: '2026-10-31', completion: 45, notes: '保留备注' });
    const w = manager.createPeriod({ kind: 'week', lineId: l.id, title: '受阻周目标', start: '2026-10-26', end: '2026-11-01', monthlyId: m.id, progressStatus: 'blocked' });
    const risk = manager.createRisk({ title: '备份风险', lineIds: [l.id], level: 'high', targetCloseDate: '2026-11-07', escalated: true });
    vi.setSystemTime(new Date('2026-11-02T04:00:00Z')); manager.checkCycles();
    const backup = new BackupService(store, new SecretVault(dir));
    const password = 'synthetic-production-backup-passphrase';
    await backup.restore(await backup.export(password), password);
    expect(manager.listLines()[0].reminderWeekday).toBe(2);
    expect(manager.listPeriods().find(p => p.id === m.id)).toMatchObject({ completion: 45, notes: '保留备注' });
    expect(manager.listPeriods().find(p => p.id === w.id)).toMatchObject({ progressStatus: 'blocked', status: 'blocked' });
    expect(manager.listRisks().find(r => r.id === risk.id)).toMatchObject({ level: 'high', targetCloseDate: '2026-11-07', escalated: true });
    expect(manager.production().summaries[0]).toMatchObject({ month: '2026-10', rate: 0 });
    const corrupted = backup.snapshot();
    corrupted.events.find(e => e.kind === 'line.month-summarized')!.details.rate = 999;
    expect(() => validateBackupSnapshot(corrupted)).toThrow();
  });
});
