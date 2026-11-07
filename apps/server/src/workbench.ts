import { randomUUID } from 'node:crypto';
import { localDate, taskFields, taskSchema, patchTaskSchema, deleteTaskSchema, promptInputSchema, type Task, type Prompt, type RecordEvent } from '@workbench/contracts';
import { Storage } from './storage.js';
import { AppError } from './errors.js';
import { isPrivateMaterial, isInternalTask } from './material-privacy.js';
import type { Period, Risk, Milestone, Recurrence, Review } from '../../../packages/contracts/src/management.js';
import type { SourceObject } from '../../../packages/contracts/src/sources.js';
import type { Execution } from '../../../packages/contracts/src/executions.js';
export class Workbench {
  readonly storage: Storage;
  constructor(dir: string) { this.storage = new Storage(dir); }
  close(): void { this.storage.close(); }
  listTasks(): Task[] { return this.storage.list<unknown>('task').map(task => this.readTask(task)).sort((a, b) => a.order - b.order || b.createdAt.localeCompare(a.createdAt)); }
  private readTask(input: unknown): Task {
    const task = taskSchema.parse(input);
    if (task.status === 'done' && !task.completedAt) task.completedAt = this.storage.history(task.id).find(event => event.kind === 'task.completed')?.at ?? null;
    return task;
  }
  listPrompts(): Prompt[] { return this.storage.list<Prompt>('prompt').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  getHistory(id: string): RecordEvent[] { return this.storage.history(id); }
  createTask(input: unknown): Task {
    const fields = taskFields.parse(input); const now = new Date().toISOString();
    const task: Task = { ...fields, status: fields.keyDate === localDate() && fields.status === 'inbox' ? 'todo' : fields.status, completedAt: fields.status === 'done' ? now : null, id: randomUUID(), revision: randomUUID(), createdAt: now, updatedAt: now, sourceState: null };
    return this.storage.database.transaction(() => {
      this.validateTask(task); this.storage.put('task', task); this.storage.event(task.id, 'task.created', { title: task.title, status: task.status, priority: task.priority }); return task;
    })();
  }
  patchTask(id: string, input: unknown): Task {
    const patch = patchTaskSchema.parse(input);
    return this.storage.database.transaction(() => {
      const stored = this.storage.get<Task>('task', id); if (!stored) throw new AppError(404, '任务不存在');
      const previous = this.readTask(stored);
      if (previous.revision !== patch.revision) throw new AppError(409, '记录已被更新，请保留当前输入并重新读取最新版本');
      const { dateChangeReason, ...fields } = patch;
      if (previous.dueDate && fields.dueDate !== undefined && fields.dueDate !== previous.dueDate && !dateChangeReason?.trim()) throw new AppError(400, '调整已有硬截止日期需填写原因，原日期会保留在历史中');
      const task = taskSchema.parse({ ...previous, ...fields, revision: randomUUID(), updatedAt: new Date().toISOString() });
      if (task.keyDate === localDate() && task.status === 'inbox') task.status = 'todo';
      task.completedAt = task.status === 'done' ? previous.status === 'done' ? previous.completedAt : task.updatedAt : null;
      this.validateTask(task); this.storage.put('task', task, patch.revision);
      const kind = previous.status !== 'done' && task.status === 'done' ? 'task.completed' : previous.status === 'done' && task.status !== 'done' ? 'task.reopened' : 'task.updated';
      const changes = Object.fromEntries(Object.keys(fields).filter(key => key !== 'revision' && previous[key as keyof Task] !== task[key as keyof Task]).map(key => [key, { before: previous[key as keyof Task], after: task[key as keyof Task] }]));
      this.storage.event(id, kind, { ...changes, ...(previous.dueDate !== task.dueDate && dateChangeReason ? { dateChangeReason } : {}) }); return task;
    })();
  }
  deleteTask(id: string, input: unknown): { deleted: true } {
    const fields = deleteTaskSchema.parse(input);
    return this.storage.database.transaction(() => {
      const task = this.storage.get<Task>('task', id);
      if (!task) throw new AppError(404, '任务不存在');
      if (task.revision !== fields.revision) throw new AppError(409, '任务已被更新，请重新读取后确认删除');
      const executions = this.storage.list<Execution>('execution');
      if (executions.some(item => item.status === 'running')) throw new AppError(409, '仍有执行进行中，请等待结束后再删除');
      const at = new Date().toISOString();
      const privateTask = isPrivateMaterial(this.storage, 'task', id);
      const internalTask = isInternalTask(this.storage, id);
      // Capture privacy before removing links; unlinking must never declassify surviving material.
      const associated = (['period', 'risk', 'milestone'] as const).flatMap(kind => this.storage.list<Period | Risk | Milestone>(kind).filter(item => item.taskIds.includes(id)).map(item => ({ kind, item, restricted: isPrivateMaterial(this.storage, kind, item.id) })));
      for (const child of this.listTasks().filter(item => item.parentId === id)) this.storage.put('task', { ...child, parentId: null, ...(privateTask ? { privacyRestricted: true } : {}), ...(internalTask ? { internalContext: true } : {}), revision: randomUUID(), updatedAt: at }, child.revision);
      for (const { kind, item, restricted } of associated) this.storage.put(kind, { ...item, taskIds: item.taskIds.filter(value => value !== id), ...(restricted ? { privacyRestricted: true } : {}), revision: randomUUID(), updatedAt: at }, item.revision);
      for (const source of this.storage.list<SourceObject>('source-record').filter(item => item.localTaskId === id || item.autoCreatedTaskId === id)) this.storage.put('source-record', { ...source, ...(privateTask ? { privacyRestricted: true } : {}), localTaskId: source.localTaskId === id ? null : source.localTaskId, autoCreatedTaskId: source.autoCreatedTaskId === id ? null : source.autoCreatedTaskId, autoCreatedTaskRevision: source.autoCreatedTaskId === id ? null : source.autoCreatedTaskRevision, revision: randomUUID(), updatedAt: at }, source.revision);
      for (const rule of this.storage.list<Recurrence>('recurrence').filter(item => item.occurrences.some(value => value.taskId === id))) this.storage.put('recurrence', { ...rule, occurrences: rule.occurrences.filter(value => value.taskId !== id), revision: randomUUID(), updatedAt: at }, rule.revision);
      for (const review of this.storage.list<Review>('review')) {
        const captured = [review.facts, ...review.versions.map(version => version.facts)].some(facts => facts.some(fact => fact.kind === 'task' && fact.id === id));
        if (!review.selections.taskIds.includes(id) && !(review.nextWeekTaskIds ?? []).includes(id) && !(privateTask && captured)) continue;
        this.storage.put('review', { ...review, selections: { ...review.selections, taskIds: review.selections.taskIds.filter(value => value !== id) }, nextWeekTaskIds: (review.nextWeekTaskIds ?? []).filter(value => value !== id), ...(privateTask && captured ? { privacyRestricted: true } : {}), revision: randomUUID(), updatedAt: at }, review.revision);
      }
      for (const execution of executions.filter(item => item.taskIds.includes(id) || `task:${id}` in item.materialRevisions)) {
        const materialRevisions = { ...execution.materialRevisions }; delete materialRevisions[`task:${id}`];
        this.storage.put('execution', { ...execution, taskIds: execution.taskIds.filter(value => value !== id), materialRevisions, ...(execution.status === 'awaiting_authorization' ? { status: 'cancelled' as const, statusNote: '所选任务已删除，请重新制定执行计划' } : {}), revision: randomUUID(), updatedAt: at }, execution.revision);
      }
      this.storage.removeTask(id);
      return { deleted: true as const };
    })();
  }
  private validateTask(task: Task): void {
    if (task.keyDate && task.keyDate >= localDate() && !task.archived && !['done', 'cancelled'].includes(task.status)) {
      const selected = this.listTasks().filter(other => other.id !== task.id && other.keyDate === task.keyDate && !other.archived && !['done', 'cancelled'].includes(other.status));
      if (selected.length >= 3) throw new AppError(400, '今日要事已满 3 件，请先取消一件');
    }
    if (task.sensitive) throw new AppError(400, '敏感正文存储尚未获许可，请仅记录不含身份信息的行动摘要');
    if (task.status === 'waiting' && (!task.waitingFor.trim() || !task.waitingWhat.trim() || !task.followUpDate)) throw new AppError(400, '等待反馈需填写等待对象、内容和下次跟进日期');
    if (task.status === 'blocked' && (!task.blockedReason.trim() || !task.followUpDate)) throw new AppError(400, '阻塞需填写原因和下次检查日期');
    if (task.status === 'blocked' && !task.nextAction.trim() && !task.waitingFor.trim()) throw new AppError(400, '阻塞需填写下一步解除动作或求助对象');
    if (task.validation === 'passed' && !task.validationNote.trim()) throw new AppError(400, '验证通过需填写检查结果与依据');
    if (task.delivery === 'delivered' && !task.deliveryNote.trim()) throw new AppError(400, '最终交付需填写结果与依据');
    if (task.archived && !['done', 'cancelled'].includes(task.status) && !task.archiveReason.trim()) throw new AppError(400, '未完成事项归档需说明后续安排');
    const seen = new Set([task.id]); let parentId = task.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new AppError(400, '父子任务不能形成循环'); seen.add(parentId);
      const parent = this.storage.get<Task>('task', parentId); if (!parent) throw new AppError(400, '关联主任务不存在'); parentId = parent.parentId;
    }
  }
  savePrompt(input: unknown): Prompt {
    const fields = promptInputSchema.parse(input);
    return this.storage.database.transaction(() => {
      const previous = fields.id ? this.storage.get<Prompt>('prompt', fields.id) : undefined;
      if (fields.id && (!previous || !fields.revision)) throw new AppError(409, '提示词已被更新，请重新读取');
      const now = new Date().toISOString();
      const prompt: Prompt = { title: fields.title, body: fields.body, tag: fields.tag, id: previous?.id ?? randomUUID(), revision: randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now };
      this.storage.put('prompt', prompt, previous ? fields.revision : undefined);
      this.storage.event(prompt.id, previous ? 'prompt.updated' : 'prompt.created', { title: prompt.title }); return prompt;
    })();
  }
}
