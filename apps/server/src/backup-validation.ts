import { z } from 'zod';
import { localDate, snapshotSchema, shiftDate, sourceFields, type Snapshot, type Task } from '@workbench/contracts';
import { lineSchema, periodSchema, riskSchema, milestoneSchema, recurrenceSchema, reviewSchema, type Period } from '../../../packages/contracts/src/management.js';
import { sourceObjectSchema, sourceObjectType, writebackSchema, type SourceObject } from '../../../packages/contracts/src/sources.js';
import { modelSchema } from '../../../packages/contracts/src/models.js';
import { executionSchema } from '../../../packages/contracts/src/executions.js';
import { dashboardSettingsSchema } from '../../../packages/contracts/src/dashboard.js';
import { monthSummarySchema } from '../../../packages/contracts/src/production.js';

export const extraKinds = ['source-record', 'writeback', 'line', 'period', 'risk', 'review', 'recurrence', 'milestone', 'model', 'execution', 'dashboard-settings'] as const;
type ExtraKind = typeof extraKinds[number];
const schemas = {
  'source-record': sourceObjectSchema.strict(), writeback: writebackSchema.strict(), line: lineSchema.strict(), period: periodSchema.strict(),
  risk: riskSchema.strict(), review: reviewSchema.strict(), recurrence: recurrenceSchema.strict(), milestone: milestoneSchema.strict(),
  model: modelSchema.omit({ credentialRef: true }).strict(), execution: executionSchema.strict(), 'dashboard-settings': dashboardSettingsSchema
};
const secretKeys = new Set(['credentialref', 'credential', 'access_token', 'refresh_token', 'api_key', 'apikey', 'authorization', 'private-token']);
export function withoutBackupSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBackupSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.toLowerCase())).map(([key, child]) => [key, withoutBackupSecrets(child)]));
  return value;
}
function containsSecretKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKeys);
  return Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, child]) => secretKeys.has(key.toLowerCase()) || containsSecretKeys(child)));
}
export function validateBackupSnapshot(input: unknown): Snapshot {
  if (containsSecretKeys(input)) throw new Error('Credential fields are not accepted in backups');
  const snapshot = snapshotSchema.parse(input);
  snapshot.documents = snapshot.documents.map(document => ({ kind: document.kind, data: schemas[document.kind].parse(document.data) }));
  const all = new Map<string, { kind: string; data: Record<string, unknown> }>();
  const add = (kind: string, data: { id: string } & Record<string, unknown>) => { if (all.has(data.id)) throw new Error('Duplicate record identity'); all.set(data.id, { kind, data }); };
  snapshot.tasks.forEach(value => add('task', value)); snapshot.prompts.forEach(value => add('prompt', value)); snapshot.sources.forEach(value => add('source', value)); snapshot.documents.forEach(value => add(value.kind, value.data));
  const eventIds = new Set<string>(); for (const event of snapshot.events) { if (eventIds.has(event.id)) throw new Error('Duplicate event identity'); eventIds.add(event.id); }
  const get = <T>(kind: string, id: string): T => { const value = all.get(id); if (!value || value.kind !== kind) throw new Error('Invalid record reference'); return value.data as T; };
  const summaryKeys = new Set<string>();
  for (const event of snapshot.events.filter(e => e.kind === 'line.month-summarized')) {
    const summary = monthSummarySchema.parse(event.details); get('line', summary.lineId);
    const key = `${summary.lineId}:${summary.month}`;
    if (event.resourceId !== summary.lineId || summaryKeys.has(key)) throw new Error('Invalid month summary identity');
    summaryKeys.add(key);
  }
  const references = (kind: string, values: string[]) => { if (new Set(values).size !== values.length) throw new Error('Duplicate reference'); values.forEach(id => get(kind, id)); };
  const documents = <K extends ExtraKind>(kind: K): z.infer<typeof schemas[K]>[] => snapshot.documents.filter(value => value.kind === kind).map(value => value.data) as z.infer<typeof schemas[K]>[];
  const range = (start: string, end: string) => { if (start > end) throw new Error('Invalid date range'); };
  const sourcesByProvider = new Set<string>(); for (const source of snapshot.sources) { if (sourcesByProvider.has(source.provider)) throw new Error('Duplicate source configuration'); sourcesByProvider.add(source.provider); }
  const keyCounts = new Map<string, number>();
  const snapshotDate = localDate(new Date(snapshot.createdAt));
  for (const task of snapshot.tasks) {
    if (task.keyDate && task.keyDate >= snapshotDate && !task.archived && !['done', 'cancelled'].includes(task.status)) {
      const count = (keyCounts.get(task.keyDate) ?? 0) + 1;
      if (count > 3) throw new Error('Too many daily key tasks');
      keyCounts.set(task.keyDate, count);
    }
    const seen = new Set([task.id]); let current: Task = task;
    while (current.parentId) { if (seen.has(current.parentId)) throw new Error('Parent cycle'); seen.add(current.parentId); current = get<Task>('task', current.parentId); }
    if (task.sensitive || task.status === 'waiting' && (!task.waitingFor.trim() || !task.waitingWhat.trim() || !task.followUpDate) || task.status === 'blocked' && (!task.blockedReason.trim() || !task.followUpDate || !task.nextAction.trim() && !task.waitingFor.trim()) || task.validation === 'passed' && !task.validationNote.trim() || task.delivery === 'delivered' && !task.deliveryNote.trim() || task.archived && !['done', 'cancelled'].includes(task.status) && !task.archiveReason.trim()) throw new Error('Invalid task invariants');
  }
  if (documents('line').filter(value => !value.archived).length > 3) throw new Error('Too many active lines');
  for (const period of documents('period')) {
    range(period.start, period.end); get('line', period.lineId); references('task', period.taskIds);
    if (period.monthlyId) { const month = get<Period>('period', period.monthlyId); if (period.kind !== 'week' || month.kind !== 'month' || month.lineId !== period.lineId || month.start > period.end || month.end < period.start) throw new Error('Invalid monthly link'); }
    if (period.feedbackAt && !period.feedbackSource.trim() || period.status === 'waiting' && (!period.nextAction.trim() || !period.followUpDate)) throw new Error('Invalid period evidence');
    if (period.status !== 'done' && period.completion === 100) throw new Error('Invalid period completion');
    if (period.kind === 'week' && period.progressStatus && ((period.progressStatus === 'done') !== (period.status === 'done') || (period.progressStatus === 'blocked') !== (period.status === 'blocked'))) throw new Error('Inconsistent weekly progress');
    if (period.carriedFromId) { const from = get<Period>('period', period.carriedFromId); if (from.lineId !== period.lineId || from.kind !== period.kind || period.start <= from.end || !from.carriedToIds.includes(period.id)) throw new Error('Invalid carried plan link'); }
    references('period', period.carriedToIds); for (const id of period.carriedToIds) if (get<Period>('period', id).carriedFromId !== period.id) throw new Error('Asymmetric carried plan link');
  }
  for (const risk of documents('risk')) {
    references('line', risk.lineIds); references('period', risk.periodIds); references('task', risk.taskIds);
    if (risk.sensitive || risk.status === 'closed' && (!risk.result.trim() || !risk.evidence.trim())) throw new Error('Invalid risk evidence');
  }
  for (const milestone of documents('milestone')) { references('task', milestone.taskIds); references('risk', milestone.riskIds); if (milestone.validation === 'passed' && (!milestone.adoptionResult.trim() || !milestone.validationNote.trim())) throw new Error('Invalid adoption evidence'); }
  for (const rule of documents('recurrence')) {
    const starts = new Set<string>();
    for (const occurrence of rule.occurrences) {
      get('task', occurrence.taskId); if (starts.has(occurrence.start)) throw new Error('Duplicate recurring cycle'); starts.add(occurrence.start);
      const date = new Date(`${occurrence.start}T12:00:00Z`); const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      if (rule.kind === 'week' ? date.getUTCDay() !== 1 || occurrence.end !== shiftDate(occurrence.start, 6) : !occurrence.start.endsWith('-01') || occurrence.end !== last) throw new Error('Invalid recurring cycle');
    }
    if ((rule.waitingFor || rule.waitingWhat) && (!rule.waitingFor.trim() || !rule.waitingWhat.trim() || !rule.followUpDate)) throw new Error('Invalid collection plan');
  }
  for (const review of documents('review')) {
    range(review.start, review.end); references('task', review.selections.taskIds); references('period', review.selections.periodIds); references('risk', review.selections.riskIds); references('milestone', review.selections.milestoneIds);
    for (const draft of review.aiDrafts) get('model', draft.modelId);
    for (const record of [review, ...review.versions]) {
      // Published plans identify historical facts; only the current selection is a live link.
      if (record === review) references('task', record.nextWeekTaskIds);
      if ((!record.includeNextWeekPlan && record.nextWeekTaskIds.length) || record.nextWeekTaskIds.some(id => !record.facts.some(fact => fact.kind === 'task' && fact.id === id))) throw new Error('Invalid next-week plan reference');
    }
    // Fact snapshots and delivered versions retain their historical revisions and text.
    for (const facts of [review.facts, ...review.versions.map(value => value.facts)]) { const keys = new Set<string>(); for (const fact of facts) { if (fact.kind !== 'task' || all.has(fact.id)) get(fact.kind, fact.id); const key = `${fact.kind}:${fact.id}`; if (keys.has(key)) throw new Error('Duplicate review fact'); keys.add(key); } }
    review.versions.forEach((version, index) => { if (version.version !== index + 1) throw new Error('Invalid publication sequence'); range(version.start, version.end); });
  }
  const sourceKeys = new Set<string>(); const boundTaskIds = new Set<string>();
  for (const object of documents('source-record')) {
    const key = object.provider === 'pingcode' ? `${object.provider}/${object.instanceId}/${object.externalId}` : `${object.provider}/${object.instanceId}/${sourceObjectType(object)}/${object.projectId}/${object.externalId}`;
    if (sourceKeys.has(key)) throw new Error('Duplicate external identity'); sourceKeys.add(key);
    if (object.localTaskId) { get('task', object.localTaskId); if (boundTaskIds.has(object.localTaskId)) throw new Error('Multiple source objects bound to one task'); boundTaskIds.add(object.localTaskId); }
    if (object.autoCreatedTaskId) get('task', object.autoCreatedTaskId);
    references('source-record', object.linkedSourceIds);
    for (const id of object.linkedSourceIds) { const related = get<SourceObject>('source-record', id); if (related.provider === object.provider || !related.linkedSourceIds.includes(object.id)) throw new Error('Invalid symmetric source association'); }
  }
  const requestIds = new Set<string>();
  for (const item of documents('writeback')) {
    const object = get<SourceObject>('source-record', item.sourceRecordId); sourceFields.shape.baseUrl.parse(item.baseUrl);
    if (object.provider !== 'pingcode' || object.instanceId !== item.instanceId || object.externalId !== item.externalId || requestIds.has(item.requestId)) throw new Error('Invalid writeback target or duplicate request'); requestIds.add(item.requestId);
    if (item.field === 'comment' ? item.outboundValue !== `${item.value}\n\n[个人工作台提交:${item.requestId}]` : !item.expectedValue || item.outboundValue !== item.value) throw new Error('Invalid writeback preview');
  }
  if (documents('model').filter(value => value.isDefault).length > 1) throw new Error('Multiple default models');
  for (const item of documents('execution')) {
    get('model', item.modelId); references('task', item.taskIds); references('source-record', item.sourceRecordIds); references('period', item.periodIds); references('risk', item.riskIds); references('writeback', item.writebackIds);
    if (item.calls < 0 || item.tokens < 0) throw new Error('Invalid execution usage');
    const allowed = new Set([...item.taskIds.map(id => `task:${id}`), ...item.sourceRecordIds.map(id => `source:${id}`), ...item.periodIds.map(id => `period:${id}`), ...item.riskIds.map(id => `risk:${id}`)]);
    if (Object.keys(item.materialRevisions).some(key => !allowed.has(key))) throw new Error('Material revision out of scope');
  }
  return snapshot;
}
