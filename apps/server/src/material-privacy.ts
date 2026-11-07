import type { Task } from '@workbench/contracts';
import type { Storage } from './storage.js';

export type MaterialKind = 'task' | 'period' | 'risk' | 'milestone' | 'source-record';

/** Missing records and personnel ancestry cannot be classified as safe material. */
export function isPrivateMaterial(storage: Storage, kind: MaterialKind, id: string, seen = new Set<string>()): boolean {
  const key = `${kind}:${id}`; if (seen.has(key)) return false; seen.add(key);
  if (kind === 'task') {
    const task = storage.get<Task>('task', id);
    return !task || !!task.privacyRestricted || task.sensitive || ['people', 'recruitment'].includes(task.type) || storage.list<{ localTaskId: string | null; privacyRestricted?: boolean }>('source-record').some(source => source.localTaskId === id && source.privacyRestricted) || !!(task.parentId && isPrivateMaterial(storage, 'task', task.parentId, seen));
  }
  const record = storage.get<{ sensitive?: boolean; privacyRestricted?: boolean; localTaskId?: string | null; taskIds?: string[]; periodIds?: string[]; riskIds?: string[]; monthlyId?: string | null }>(kind, id);
  if (!record || record.sensitive || record.privacyRestricted) return true;
  if (record.localTaskId && isPrivateMaterial(storage, 'task', record.localTaskId, seen)) return true;
  if ((record.taskIds ?? []).some(taskId => isPrivateMaterial(storage, 'task', taskId, seen))) return true;
  if ((record.periodIds ?? []).some(periodId => isPrivateMaterial(storage, 'period', periodId, seen))) return true;
  if ((record.riskIds ?? []).some(riskId => isPrivateMaterial(storage, 'risk', riskId, seen))) return true;
  return !!(record.monthlyId && isPrivateMaterial(storage, 'period', record.monthlyId, seen));
}

export function isInternalTask(storage: Storage, id: string): boolean {
  const sources = storage.list<{ localTaskId: string | null }>('source-record');
  const associations = (['period', 'risk', 'milestone'] as const).flatMap(kind => storage.list<{ taskIds: string[] }>(kind));
  const seen = new Set<string>(); let task = storage.get<Task>('task', id);
  while (task && !seen.has(task.id)) {
    seen.add(task.id);
    if (task.internalContext || task.category === 'management' || sources.some(source => source.localTaskId === task!.id) || associations.some(value => value.taskIds.includes(task!.id))) return true;
    task = task.parentId ? storage.get<Task>('task', task.parentId) : undefined;
  }
  return false;
}
