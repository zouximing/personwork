import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Snapshot } from '@workbench/contracts';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management } from '../apps/server/src/management.js';
import { SourceService } from '../apps/server/src/source-settings.js';
import { BackupService } from '../apps/server/src/backup.js';
import { SecretVault } from '../apps/server/src/secrets.js';
import { encrypt, passwordKey } from '../apps/server/src/crypto.js';
import { sourceObjectSchema } from '../packages/contracts/src/sources.js';
import { modelSchema } from '../packages/contracts/src/models.js';
import { executionSchema } from '../packages/contracts/src/executions.js';

const password = 'synthetic-backup-integrity-passphrase';
const metadata = () => ({ id: randomUUID(), revision: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
async function envelope(snapshot: unknown): Promise<Buffer> {
  const salt = randomBytes(16); const key = await passwordKey(password, salt);
  try { return Buffer.concat([Buffer.from('PWB1'), salt, encrypt(Buffer.from(JSON.stringify(snapshot)), key, 'pwb-backup/v1')]); } finally { key.fill(0); }
}

describe('complete backup validation and local protected snapshot recovery', () => {
  let dir: string; let store: Workbench; let vault: SecretVault; let backup: BackupService;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pwb-backup-integrity-')); store = new Workbench(dir); vault = new SecretVault(dir); backup = new BackupService(store, vault); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
  async function completeFixture() {
    const task = store.createTask({ title: 'Synthetic action', notes: 'Synthetic retained plan' });
    const manager = new Management(store); const line = manager.createLine({ name: 'Synthetic line' });
    const month = manager.createPeriod({ title: 'Synthetic month', kind: 'month', start: '2026-11-01', end: '2026-11-30', lineId: line.id, taskIds: [task.id] });
    const week = manager.createPeriod({ title: 'Synthetic week', kind: 'week', start: '2026-11-02', end: '2026-11-08', lineId: line.id, monthlyId: month.id, taskIds: [task.id] });
    const risk = manager.createRisk({ title: 'Synthetic risk', lineIds: [line.id], periodIds: [week.id], taskIds: [task.id] });
    const milestone = manager.createMilestone({ title: 'Synthetic milestone', taskIds: [task.id], riskIds: [risk.id] });
    const rule = manager.createRecurrence({ title: 'Synthetic recurrence', kind: 'week' }); manager.materializeRecurrence({ recurrenceId: rule.id, start: '2026-11-02', end: '2026-11-08' });
    const review = manager.createReview({ title: 'Synthetic review', kind: 'week', start: week.start, end: week.end, selections: { taskIds: [task.id], periodIds: [week.id], riskIds: [risk.id], milestoneIds: [milestone.id] } });
    manager.publishReview(review.id, { revision: review.revision });
    const source = new SourceService(store, vault); const previous = source.listSources().find(value => value.provider === 'pingcode')!;
    const config = await source.updateSource('pingcode', { revision: previous.revision, name: 'Synthetic PingCode', baseUrl: 'http://127.0.0.1:1', projectScope: 'p1', identity: 'synthetic-user', historyDays: 90, enabled: true, intervalMinutes: 5, scheduleEnabled: true, credentialAction: 'keep' });
    const object = sourceObjectSchema.parse({ ...metadata(), provider: 'pingcode', instanceId: config.instanceId, projectId: 'p1', projectName: 'Synthetic project', externalId: 'work-1', number: 'TEST-1', title: 'Synthetic work', url: 'http://127.0.0.1:1/work-1', sourceState: 'Custom state', sourceStateId: 'state-1', sourceDueDate: null, sourcePriority: '', author: '', assigneeId: 'synthetic-user', currentSha: null, checkedSha: null, reviewStatus: 'not_started', conclusion: '', followUpDate: null, needsReview: false, reviewAssignmentChanged: false, assignedToMe: true, attentionReason: '', localTaskId: task.id, lastSeenAt: new Date().toISOString(), sourceUpdatedAt: null });
    store.storage.put('source-record', object);
    const preview = source.createWriteback({ sourceRecordId: object.id, field: 'comment', value: 'Synthetic selected progress', requestId: randomUUID() });
    const modelMeta = metadata(); const configRevision = randomUUID();
    const model = modelSchema.parse({ ...modelMeta, name: 'Synthetic local model', kind: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic', protocol: 'openai', upstreamLocation: 'internal', allowInternal: true, configurationRevision: configRevision, credentialRef: randomUUID(), capabilities: { text: 'passed', tools: 'passed', testedAt: modelMeta.createdAt, configurationRevision: configRevision, message: 'Synthetic capability receipt', lastErrorKind: null } });
    store.storage.put('model', model);
    const executionMeta = metadata(); const execution = executionSchema.parse({ ...executionMeta, title: 'Synthetic execution', modelId: model.id, instruction: 'Read synthetic selected records', taskIds: [task.id], sourceRecordIds: [object.id], periodIds: [week.id], riskIds: [risk.id], allowedTools: ['read_records'], writebackIds: [preview.id], modelConfigurationRevision: configRevision, status: 'paused', statusNote: 'Synthetic', plan: ['Read selected records'], steps: [], artifacts: [], verification: 'Unverified', finalText: '', calls: 0, tokens: 0, tokenUsageKnown: true, outputDir: join(dir, 'artifacts', executionMeta.id) });
    store.storage.put('execution', execution);
    return { task, month, week, risk, milestone, rule, review, object, preview, model, execution, source };
  }

  it('restores a legacy MR and a typed issue sharing external IDs without merging their tasks', async () => {
    const fixture = await completeFixture();
    const config = fixture.source.listSources().find(item => item.provider === 'gitlab')!;
    const mrTask = store.createTask({ title: 'Synthetic MR action', notes: 'Synthetic review plan' });
    const issueTask = store.createTask({ title: 'Synthetic issue action', notes: 'Synthetic issue plan' });
    const mr = sourceObjectSchema.parse({ ...fixture.object, ...metadata(), provider: 'gitlab', instanceId: config.instanceId, projectId: '1', externalId: '11', number: '1', title: 'Synthetic old MR', localTaskId: mrTask.id, currentSha: 'aaaa', checkedSha: 'aaaa', reviewStatus: 'reviewed' });
    const issue = sourceObjectSchema.parse({ ...mr, ...metadata(), objectType: 'issue', assignedAsAssignee: true, assignedAsReviewer: false, title: 'Synthetic issue', localTaskId: issueTask.id, currentSha: null, checkedSha: null, reviewStatus: 'not_started' });
    store.storage.put('source-record', mr); store.storage.put('source-record', issue);
    const buffer = await backup.export(password); await backup.restore(buffer, password);
    const restored = fixture.source.listRecords();
    expect(restored).toHaveLength(3);
    expect(fixture.source.getRecord(mr.id)).toMatchObject({ localTaskId: mrTask.id, checkedSha: 'aaaa', reviewStatus: 'reviewed' });
    expect(fixture.source.getRecord(issue.id)).toMatchObject({ localTaskId: issueTask.id, objectType: 'issue', assignedAsAssignee: true });
    expect(store.listTasks().find(item => item.id === mrTask.id)?.notes).toBe('Synthetic review plan');
    expect(store.listTasks().find(item => item.id === issueTask.id)?.notes).toBe('Synthetic issue plan');
  });

  const corruptions: [string, (snapshot: Snapshot) => void][] = [
    ['wrong document shape', snapshot => { snapshot.documents.find(value => value.kind === 'line')!.data.name = 7; }],
    ['dangling period task', snapshot => { snapshot.documents.find(value => value.kind === 'period')!.data.taskIds = [randomUUID()]; }],
    ['dangling risk line', snapshot => { snapshot.documents.find(value => value.kind === 'risk')!.data.lineIds = [randomUUID()]; }],
    ['dangling milestone risk', snapshot => { snapshot.documents.find(value => value.kind === 'milestone')!.data.riskIds = [randomUUID()]; }],
    ['dangling recurrence occurrence', snapshot => { const value = snapshot.documents.find(value => value.kind === 'recurrence')!.data; (value.occurrences as { taskId: string }[])[0].taskId = randomUUID(); }],
    ['dangling review selection', snapshot => { const value = snapshot.documents.find(value => value.kind === 'review')!.data; (value.selections as { taskIds: string[] }).taskIds = [randomUUID()]; }],
    ['dangling source task', snapshot => { snapshot.documents.find(value => value.kind === 'source-record')!.data.localTaskId = randomUUID(); }],
    ['duplicate source identity', snapshot => { const object = structuredClone(snapshot.documents.find(value => value.kind === 'source-record')!); object.data.id = randomUUID(); object.data.localTaskId = null; snapshot.documents.push(object); }],
    ['invalid cross-source link', snapshot => { snapshot.documents.find(value => value.kind === 'source-record')!.data.linkedSourceIds = [randomUUID()]; }],
    ['unsupported writeback field', snapshot => { snapshot.documents.find(value => value.kind === 'writeback')!.data.field = 'delete'; }],
    ['dangling writeback target', snapshot => { snapshot.documents.find(value => value.kind === 'writeback')!.data.sourceRecordId = randomUUID(); }],
    ['dangling execution model', snapshot => { snapshot.documents.find(value => value.kind === 'execution')!.data.modelId = randomUUID(); }],
    ['embedded credential reference', snapshot => { snapshot.documents.find(value => value.kind === 'model')!.data.credentialRef = randomUUID(); }]
  ];
  it.each(corruptions)('rejects %s before changing data or history', async (_name, corrupt) => {
    await completeFixture(); const before = backup.snapshot(); const invalid = structuredClone(before); corrupt(invalid);
    await expect(backup.restore(await envelope(invalid), password)).rejects.toThrow();
    expect({ ...backup.snapshot(), createdAt: before.createdAt }).toEqual(before);
  });

  it('roundtrips complete references and history while disabling restored sources, models and external operations', async () => {
    const fixture = await completeFixture(); const sent = { ...fixture.preview, status: 'submitting' as const, submittedAt: new Date().toISOString() };
    store.storage.put('writeback', sent, fixture.preview.revision);
    const snapshot = backup.snapshot(); expect(JSON.stringify(snapshot)).not.toContain('credentialRef');
    const buffer = await backup.export(password); store.createTask({ title: 'After-backup synthetic task' }); await backup.restore(buffer, password);
    expect(store.listTasks().some(value => value.title === 'After-backup synthetic task')).toBe(false);
    expect(new Management(store).listPeriods().find(value => value.id === fixture.week.id)?.monthlyId).toBe(fixture.month.id);
    expect(new Management(store).listReviews()[0].versions).toHaveLength(1);
    expect(fixture.source.getRecord(fixture.object.id).localTaskId).toBe(fixture.task.id);
    expect(fixture.source.listWritebacks()[0].status).toBe('uncertain');
    const restoredModel = modelSchema.parse(store.storage.get('model', fixture.model.id));
    expect(restoredModel).toMatchObject({ enabled: false, isDefault: false, credentialRef: null, capabilities: { text: 'untested', tools: 'untested', testedAt: null, configurationRevision: null } });
    expect(restoredModel.configurationRevision).not.toBe(fixture.model.configurationRevision);
    expect(store.storage.get<{ status: string }>('execution', fixture.execution.id)?.status).toBe('pending_verification');
    expect(fixture.source.listSources().every(value => !value.enabled && !value.scheduleEnabled && !value.hasCredential)).toBe(true);
    expect(store.getHistory(fixture.task.id).length).toBeGreaterThan(0);
  });

  it('restores task priorities and defaults legacy backups that have no priority field', async () => {
    const task = store.createTask({ title: 'Synthetic priority backup', priority: 'high', status: 'doing' });
    const buffer = await backup.export(password);
    store.patchTask(task.id, { revision: task.revision, priority: 'low' });
    await backup.restore(buffer, password);
    expect(store.listTasks()[0]).toMatchObject({ id: task.id, priority: 'high', status: 'doing' });
    const legacy = backup.snapshot();
    Reflect.deleteProperty(legacy.tasks[0], 'priority');
    await backup.restore(await envelope(legacy), password);
    expect(store.listTasks()[0]).toMatchObject({ id: task.id, priority: 'medium', status: 'doing' });
  });

  it('lists and restores a local protected snapshot after a restart and keeps a pre-restore protected copy', async () => {
    const task = store.createTask({ title: 'Synthetic protected baseline' }); backup.saveProtectedSnapshot('2026-11-07');
    store.patchTask(task.id, { revision: task.revision, title: 'After snapshot' }); store.close(); store = new Workbench(dir); backup = new BackupService(store, new SecretVault(dir));
    expect(backup.listSnapshots().map(value => value.name)).toContain('2026-11-07.protected');
    await backup.restoreProtected('2026-11-07.protected'); expect(store.listTasks()[0].title).toBe('Synthetic protected baseline');
    expect(backup.listSnapshots().some(value => value.name.startsWith('before-restore-'))).toBe(true);
  });

  it('updates the same daily protected snapshot with later facts instead of retaining only the first startup state', async () => {
    const task = store.createTask({ title: 'First fact' }); backup.daily();
    store.patchTask(task.id, { revision: task.revision, title: 'Later fact' }); backup.daily();
    const name = readdirSync(join(dir, 'snapshots')).find(value => /^\d{4}-\d{2}-\d{2}\.protected$/.test(value))!;
    const saved = JSON.parse(vault.unprotect(readFileSync(join(dir, 'snapshots', name)), 'pwb-snapshot/v1').toString()); expect(saved.tasks[0].title).toBe('Later fact');
  });

  it('rejects traversal, corrupted local snapshots and symbolic links without touching the database', async () => {
    store.createTask({ title: 'Preserve current state' }); backup.saveProtectedSnapshot('2026-11-07'); const baseline = backup.snapshot();
    await expect(backup.restoreProtected('../workbench.db')).rejects.toThrow();
    writeFileSync(join(dir, 'snapshots', '2026-11-06.protected'), 'corrupted synthetic content'); await expect(backup.restoreProtected('2026-11-06.protected')).rejects.toThrow();
    const target = join(dir, 'snapshot-target.protected'); writeFileSync(target, readFileSync(join(dir, 'snapshots', '2026-11-07.protected')));
    symlinkSync(target, join(dir, 'snapshots', '2026-11-05.protected'), 'file'); await expect(backup.restoreProtected('2026-11-05.protected')).rejects.toThrow();
    expect(backup.listSnapshots().some(value => value.name === '2026-11-05.protected')).toBe(false); expect({ ...backup.snapshot(), createdAt: baseline.createdAt }).toEqual(baseline);
  });

  it('preserves exact history ordering when several events share the same timestamp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T01:00:00Z'));
    const task = store.createTask({ title: 'Synthetic same-timestamp history' }); store.storage.event(task.id, 'synthetic.first', {}); store.storage.event(task.id, 'synthetic.second', {});
    const history = store.getHistory(task.id); const buffer = await backup.export(password); await backup.restore(buffer, password); expect(store.getHistory(task.id)).toEqual(history);
  });

  it('rolls back data and history when a later insert in the restore transaction fails', async () => {
    const task = store.createTask({ title: 'Synthetic initial state' }); const buffer = await backup.export(password);
    store.patchTask(task.id, { revision: task.revision, title: 'Synthetic current state' }); const baseline = backup.snapshot();
    store.storage.database.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON documents WHEN json_extract(NEW.data, '$.title') = 'Synthetic initial state' BEGIN SELECT RAISE(ABORT, 'synthetic restore failure'); END;");
    await expect(backup.restore(buffer, password)).rejects.toThrow(/restore failure/); expect({ ...backup.snapshot(), createdAt: baseline.createdAt }).toEqual(baseline);
  });

  it('does not overwrite a dangling symbolic link that resembles a daily snapshot', () => {
    store.createTask({ title: 'Synthetic state' }); backup.saveProtectedSnapshot('2026-11-07');
    const link = join(dir, 'snapshots', '2026-11-06.protected'); symlinkSync(join(dir, 'missing-target'), link, 'file');
    expect(() => backup.saveProtectedSnapshot('2026-11-06')).toThrow(); expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('rejects an oversized export or protected snapshot before creating an unrestorable backup', async () => {
    const task = store.createTask({ title: 'Synthetic large backup fixture', notes: 'x'.repeat(20000) });
    store.storage.database.transaction(() => { for (let index = 0; index < 1600; index++) store.storage.put('task', { ...task, id: randomUUID(), revision: randomUUID() }); })();
    let exportError = ''; try { await backup.export(password); } catch (error) { exportError = error instanceof Error ? error.message : 'unknown'; }
    expect(exportError).toMatch(/30 MiB/); expect(() => backup.saveProtectedSnapshot('2026-11-07')).toThrow(/30 MiB/);
    expect(backup.listSnapshots()).toEqual([]); expect(store.listTasks()).toHaveLength(1601);
  });
});
