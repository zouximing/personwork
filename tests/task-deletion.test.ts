import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management } from '../apps/server/src/management.js';
import { BackupService } from '../apps/server/src/backup.js';
import { SecretVault } from '../apps/server/src/secrets.js';
import { isPrivateMaterial } from '../apps/server/src/material-privacy.js';
import { sourceObjectSchema } from '../packages/contracts/src/sources.js';
import { ExecutionService } from '../apps/server/src/executions.js';
import type { Task } from '../packages/contracts/src/index.js';

describe('permanent task deletion and reference integrity', () => {
  let dir: string;
  let store: Workbench;
  let management: Management;
  const range = { start: '2026-11-02', end: '2026-11-08' };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pwb-delete-'));
    store = new Workbench(dir);
    management = new Management(store);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const remove = (task: Task) => store.deleteTask(task.id, { revision: task.revision, confirm: true });
  const backup = () => new BackupService(store, new SecretVault(dir));
  function source(task: Task) {
    const now = new Date().toISOString();
    const record = sourceObjectSchema.parse({
      id: randomUUID(), revision: randomUUID(), createdAt: now, updatedAt: now,
      provider: 'gitlab', instanceId: randomUUID(), projectId: '8', projectName: 'Synthetic', externalId: '23',
      number: '23', title: 'Synthetic source', url: 'http://gitlab.invalid/synthetic/-/issues/23',
      objectType: 'issue', sourceState: 'opened', sourceStateId: 'opened', sourceDueDate: null, sourcePriority: '',
      author: 'synthetic', assigneeId: '7', currentSha: null, checkedSha: null, reviewStatus: 'not_started',
      conclusion: '', followUpDate: null, needsReview: false, reviewAssignmentChanged: false, assignedToMe: true, attentionReason: '',
      localTaskId: task.id, lastSeenAt: now, sourceUpdatedAt: now, linkedSourceIds: [],
      autoCreatedTaskId: task.id, autoCreatedTaskRevision: task.revision,
    });
    store.storage.put('source-record', record);
    return record;
  }

  it('removes the task and its history permanently, including after reopening SQLite', () => {
    const task = store.createTask({ title: '需要永久删除的合成事项' });
    const child = store.createTask({ title: '保留的子任务', parentId: task.id });
    store.storage.event(child.id, 'task.linked', { taskIds: [task.id] });
    remove(task);
    expect(store.listTasks().map(item => item.id)).toEqual([child.id]);
    expect(store.listTasks()[0]).toMatchObject({ parentId: null });
    expect(store.getHistory(task.id)).toEqual([]);
    expect(JSON.stringify(store.storage.history())).not.toContain(task.id);
    expect(backup().snapshot().tasks.map(item => item.id)).toEqual([child.id]);
    store.close(); store = new Workbench(dir);
    expect(store.listTasks()).toHaveLength(1);
    expect(store.getHistory(task.id)).toEqual([]);
  });

  it('requires confirmation and the latest revision without deleting newer edits', () => {
    const task = store.createTask({ title: '不能误删' });
    const edited = store.patchTask(task.id, { revision: task.revision, nextAction: '新内容' });
    expect(() => remove(task)).toThrow(/更新|变更/);
    expect(() => store.deleteTask(task.id, { revision: edited.revision, confirm: false })).toThrow();
    expect(store.listTasks()[0]).toMatchObject({ revision: edited.revision, nextAction: '新内容' });
    expect(() => store.deleteTask(randomUUID(), { revision: randomUUID(), confirm: true })).toThrow(/不存在/);
  });

  it('cleans live associations while retaining report text and published snapshots', () => {
    const task = store.createTask({ title: '合成历史任务', planDate: range.start, nextAction: '保留报告中的快照' });
    const line = management.createLine({ name: '合成产线' });
    const period = management.createPeriod({ title: '合成周重点', lineId: line.id, kind: 'week', ...range, taskIds: [task.id] });
    const risk = management.createRisk({ title: '合成风险', taskIds: [task.id] });
    const milestone = management.createMilestone({ title: '合成专题', taskIds: [task.id] });
    const bound = source(task);
    const review = management.createReview({ title: '保留的回顾', kind: 'week', ...range, selections: { taskIds: [task.id] } });
    const published = management.publishReview(review.id, { revision: review.revision });
    remove(task);
    for (const [kind, id] of [['period', period.id], ['risk', risk.id], ['milestone', milestone.id]] as const) {
      expect(store.storage.get<{ taskIds: string[] }>(kind, id)?.taskIds).toEqual([]);
    }
    expect(store.storage.get('source-record', bound.id)).toMatchObject({ localTaskId: null, autoCreatedTaskId: null, autoCreatedTaskRevision: null });
    const retained = management.listReviews().find(item => item.id === review.id)!;
    expect(retained.selections.taskIds).toEqual([]);
    expect(retained.reportBody).toBe(published.reportBody);
    expect(retained.versions).toEqual(published.versions);
    expect(retained.facts).toEqual(published.facts);
    expect(retained.exportBlocked).toBe(false);
    expect(retained.markdown).toBe(published.markdown);
    const snapshot = backup().snapshot();
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.documents.find(item => item.kind === 'review')?.data.reportBody).toContain('合成历史任务');
  });

  it('removes an occurrence link so an explicit generation can create a new task', () => {
    const rule = management.createRecurrence({ title: '合成周期', kind: 'week' });
    const first = management.materializeRecurrence({ recurrenceId: rule.id, ...range });
    remove(first.task);
    expect(management.listRecurrences()[0].occurrences).toEqual([]);
    expect(backup().snapshot().tasks).toEqual([]);
    const next = management.materializeRecurrence({ recurrenceId: rule.id, ...range });
    expect(next.created).toBe(true);
    expect(next.task.id).not.toBe(first.task.id);
  });

  it('cleans next-week selections while preserving published plan snapshots and valid backups', () => {
    const task = store.createTask({ title: '合成下周任务', planDate: '2026-11-09' });
    const review = management.createReview({ title: '下周计划回顾', kind: 'week', ...range, includeNextWeekPlan: true, nextWeekTaskIds: [task.id] });
    const published = management.publishReview(review.id, { revision: review.revision });
    remove(task);
    const retained = management.listReviews()[0];
    expect(retained.nextWeekTaskIds).toEqual([]);
    expect(retained.versions).toEqual(published.versions);
    expect(retained.reportBody).toBe(published.reportBody);
    expect(backup().snapshot().tasks).toEqual([]);
  });

  it('keeps report snapshots restricted if the removed task became private after capture', () => {
    const task = store.createTask({ title: '合成快照分类', planDate: range.start });
    const review = management.createReview({ title: '受保护回顾', kind: 'week', ...range, selections: { taskIds: [task.id] } });
    const published = management.publishReview(review.id, { revision: review.revision });
    const privateTask = store.patchTask(task.id, { revision: task.revision, type: 'people' });
    remove(privateTask);
    const retained = management.listReviews()[0];
    expect(retained.exportBlocked).toBe(true);
    expect(retained.facts).toEqual(published.facts);
    expect(retained.versions).toEqual(published.versions);
    expect(backup().snapshot().tasks).toEqual([]);
  });

  it('preserves privacy and internal restrictions when detaching surviving children and associations', () => {
    const parent = store.createTask({ title: '脱敏人员事项', type: 'people', category: 'management' });
    const child = store.createTask({ title: '仍需保护的子事项', parentId: parent.id });
    const line = management.createLine({ name: '合成产线' });
    const period = management.createPeriod({ title: '仍需保护的重点', lineId: line.id, kind: 'week', ...range, taskIds: [parent.id] });
    const bound = source(parent);
    remove(parent);
    expect(store.listTasks().find(item => item.id === child.id)).toMatchObject({ parentId: null, type: 'task' });
    expect(isPrivateMaterial(store.storage, 'task', child.id)).toBe(true);
    expect(isPrivateMaterial(store.storage, 'period', period.id)).toBe(true);
    expect(isPrivateMaterial(store.storage, 'source-record', bound.id)).toBe(true);
    const retained = store.listTasks().find(item => item.id === child.id)!;
    expect(retained.internalContext).toBe(true);
    expect(() => store.patchTask(child.id, { revision: retained.revision, privacyRestricted: false })).toThrow();
    expect(() => store.patchTask(child.id, { revision: retained.revision, internalContext: false })).toThrow();
    expect(backup().snapshot().tasks).toHaveLength(1);
  });

  it('rolls all reference cleanup back if the physical delete fails', () => {
    const parent = store.createTask({ title: '删除回滚' });
    const child = store.createTask({ title: '关联回滚', parentId: parent.id });
    const before = backup().snapshot();
    store.storage.database.exec("CREATE TRIGGER prevent_task_delete BEFORE DELETE ON documents WHEN OLD.kind = 'task' BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;");
    expect(() => remove(parent)).toThrow(/synthetic delete failure/);
    expect(store.listTasks().find(item => item.id === child.id)?.parentId).toBe(parent.id);
    const after = backup().snapshot();
    expect({ ...after, createdAt: before.createdAt }).toEqual(before);
  });

  it('removes execution scope references and invalidates an unstarted authorization', () => {
    const task = store.createTask({ title: '授权中的任务' });
    const modelId = randomUUID();
    const service = new ExecutionService(store, {
      profile: () => ({ id: modelId, configurationRevision: 'synthetic', capabilities: { tools: 'passed' }, allowInternal: true, maxCalls: 1, maxTokens: 1000 }),
      chat: async () => ({ content: '未执行', toolCalls: [] }),
    }, { listRecords: () => [], listWritebacks: () => [], submitWriteback: async () => { throw new Error('unexpected'); }, verifyWriteback: async () => { throw new Error('unexpected'); } }, join(dir, 'artifacts'));
    const plan = service.create({ title: '合成计划', modelId, instruction: '读任务', taskIds: [task.id], allowedTools: ['read_records'] });
    remove(task);
    const saved = service.get(plan.id);
    expect(saved.taskIds).toEqual([]);
    expect(saved.materialRevisions).not.toHaveProperty(`task:${task.id}`);
    expect(saved.status).toBe('cancelled');
    expect(() => service.authorize(saved.id, saved.revision)).toThrow(/变更|启动/);
  });
});
