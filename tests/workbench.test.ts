import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../apps/server/src/workbench.js';

describe('durable personal records', () => {
  let dir: string;
  let store: Workbench;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pwb-test-')); store = new Workbench(dir); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('persists title-only inbox tasks and exact multiline prompts after reopening the database', () => {
    const task = store.createTask({ title: '处理边界条件' });
    const body = '第一行\n\n  保留缩进：{{标题}}\n特殊字符 <>&\\$';
    store.savePrompt({ title: '排障', body, tag: '研发' });
    store.close(); store = new Workbench(dir);
    expect(store.listTasks()[0]).toMatchObject({ id: task.id, title: '处理边界条件', status: 'inbox' });
    expect(store.listPrompts()[0].body).toBe(body);
  });

  it('rejects stale edits instead of overwriting the more recent personal plan', () => {
    const task = store.createTask({ title: '原计划' });
    store.patchTask(task.id, { revision: task.revision, planDate: '2026-11-08', nextAction: '核对结果' });
    expect(() => store.patchTask(task.id, { revision: task.revision, title: '过期编辑' })).toThrow(/已被更新/);
    expect(store.listTasks()[0]).toMatchObject({ title: '原计划', planDate: '2026-11-08', nextAction: '核对结果' });
  });
  it('defaults new and legacy tasks to medium priority without rewriting legacy records', () => {
    const task = store.createTask({ title: '默认优先级' });
    expect(task).toMatchObject({ priority: 'medium', status: 'inbox' });
    store.storage.database.prepare("UPDATE documents SET data = json_remove(data, '$.priority') WHERE kind = 'task' AND id = ?").run(task.id);
    store.close(); store = new Workbench(dir);
    expect(store.listTasks()[0]).toMatchObject({ id: task.id, priority: 'medium', revision: task.revision });
    expect(store.storage.get('task', task.id)).not.toHaveProperty('priority');
    expect(store.patchTask(task.id, { revision: task.revision, status: 'doing' })).toMatchObject({ priority: 'medium', status: 'doing' });
  });

  it('persists priority edits and preserves them during independent status changes', () => {
    const task = store.createTask({ title: '优先推进', priority: 'high', status: 'todo' });
    const doing = store.patchTask(task.id, { revision: task.revision, status: 'doing' });
    expect(doing).toMatchObject({ priority: 'high', status: 'doing' });
    const low = store.patchTask(task.id, { revision: doing.revision, priority: 'low' });
    expect(low).toMatchObject({ priority: 'low', status: 'doing' });
    expect(store.getHistory(task.id)[0].details).toMatchObject({ priority: { before: 'high', after: 'low' } });
    store.close(); store = new Workbench(dir);
    expect(store.listTasks()[0]).toMatchObject({ priority: 'low', status: 'doing' });
    expect(() => store.createTask({ title: '无效优先级', priority: 'urgent' })).toThrow();
    expect(() => store.patchTask(task.id, { revision: low.revision, priority: 'urgent' })).toThrow();
    expect(store.listTasks()).toHaveLength(1);
  });
  it('partial edits preserve fields not included in the request', () => {
    const parent = store.createTask({ title: '主任务' });
    const task = store.createTask({ title: '子任务', parentId: parent.id, notes: '个人备注', planDate: '2026-11-09', focus: true });
    const updated = store.patchTask(task.id, { revision: task.revision, nextAction: '只改下一步' });
    expect(updated).toMatchObject({ parentId: parent.id, notes: '个人备注', planDate: '2026-11-09', focus: true });
  });

  it('finishing and reopening an action preserve verification, delivery and completion history', () => {
    const task = store.createTask({ title: '修 Bug', validation: 'unverified' });
    const done = store.patchTask(task.id, { revision: task.revision, status: 'done' });
    expect(done).toMatchObject({ validation: 'unverified', delivery: 'not_delivered', sourceState: null });
    store.patchTask(task.id, { revision: done.revision, status: 'doing' });
    const history = store.getHistory(task.id);
    expect(history.some(event => event.kind === 'task.completed')).toBe(true);
    expect(history.some(event => event.kind === 'task.reopened')).toBe(true);
    expect(store.listTasks()[0].status).toBe('doing');
  });

  it('requires real calendar dates, waiting details and evidence for verified claims', () => {
    expect(() => store.createTask({ title: '无效日期', planDate: '2026-02-30' })).toThrow();
    expect(() => store.createTask({ title: '等待', status: 'waiting' })).toThrow(/等待/);
    expect(() => store.createTask({ title: '无依据', validation: 'passed' })).toThrow(/依据/);
    expect(store.listTasks()).toHaveLength(0);
  });

  it('keeps the previous prompt and history when a stale prompt save fails', () => {
    const prompt = store.savePrompt({ title: '初稿', body: '内容\n  原样', tag: '' });
    const saved = store.savePrompt({ id: prompt.id, revision: prompt.revision, title: '新稿', body: '已保存', tag: '' });
    expect(() => store.savePrompt({ id: prompt.id, revision: prompt.revision, title: '过期', body: '不能覆盖', tag: '' })).toThrow();
    expect(store.listPrompts()[0]).toEqual(saved);
  });

  it('supports parent links, ordering and safe archive without duplicating tasks', () => {
    const parent = store.createTask({ title: '功能' });
    const child = store.createTask({ title: '验证', parentId: parent.id, order: -5 });
    expect(store.listTasks()[0].id).toBe(child.id);
    expect(() => store.patchTask(parent.id, { revision: parent.revision, parentId: child.id })).toThrow(/循环/);
    expect(() => store.patchTask(child.id, { revision: child.revision, archived: true })).toThrow(/后续安排/);
    store.patchTask(child.id, { revision: child.revision, archived: true, archiveReason: '并入主任务继续跟进' });
    expect(store.listTasks()).toHaveLength(2);
  });

  it('rejects sensitive text storage until protection and data permission have been confirmed', () => {
    expect(() => store.createTask({ title: '人员资料', sensitive: true })).toThrow(/敏感/);
    expect(store.listTasks()).toHaveLength(0);
  });
  it('requires a reason for changing an existing hard deadline and records the previous value', () => {
    const task = store.createTask({ title: '有硬截止的事项', dueDate: '2026-11-09' });
    expect(() => store.patchTask(task.id, { revision: task.revision, dueDate: '2026-11-10' })).toThrow(/原因/);
    const updated = store.patchTask(task.id, { revision: task.revision, dueDate: '2026-11-10', dateChangeReason: '等待授权测试环境' });
    expect(updated.dueDate).toBe('2026-11-10');
    expect(store.getHistory(task.id)[0].details).toMatchObject({ dueDate: { before: '2026-11-09', after: '2026-11-10' }, dateChangeReason: '等待授权测试环境' });
  });
  it('requires an unblock action or help contact when marking a task blocked', () => {
    expect(() => store.createTask({ title: '被阻塞', status: 'blocked', blockedReason: '缺少环境', followUpDate: '2026-11-09' })).toThrow(/解除|求助/);
    expect(store.createTask({ title: '被阻塞', status: 'blocked', blockedReason: '缺少环境', followUpDate: '2026-11-09', nextAction: '申请测试环境' }).status).toBe('blocked');
  });
});
