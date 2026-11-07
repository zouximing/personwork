import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localDate, shiftDate, type Task } from '@workbench/contracts';
import {
  lineFields, linePatchSchema, lineSchema, periodFields, periodSchema, periodPatchSchema, carryPeriodSchema, carryPreviousSchema, productionQuerySchema,
  riskFields, riskSchema, riskPatchSchema, milestoneFields, milestonePatchSchema,
  recurrenceFields, recurrencePatchSchema, materializeSchema,
  reviewFields, reviewRangeSchema, reviewPatchSchema, reviewSectionsSchema, publishReviewInputSchema, deleteReviewInputSchema, nextWeekRange,
  type Line, type Period, type PeriodView, type Risk, type Milestone, type Recurrence,
  type Review, type ReviewView, type ReviewSelections, type FactSnapshot, type ReviewSections
} from '../../../packages/contracts/src/management.js';
import type { Workbench } from './workbench.js';
import type { DocumentKind } from './storage.js';
import { sourceObjectType, sourceNumber, isMergeRequest, type SourceObject } from '../../../packages/contracts/src/sources.js';
import { AppError } from './errors.js';
import { isPrivateMaterial } from './material-privacy.js';
import { cycleRange, lineOverview, type MonthSummary } from '../../../packages/contracts/src/production.js';
import { monthEndSummary, productionReport } from './production-history.js';

type Entity = { id: string; revision: string; createdAt: string; updatedAt: string };
const metadata = (): Entity => { const now = new Date().toISOString(); return { id: randomUUID(), revision: randomUUID(), createdAt: now, updatedAt: now }; };
const revisionInput = z.object({ revision: z.string().uuid() }).passthrough();
const sectionLabels: Record<keyof ReviewSections, string> = { accomplishments: '成果', progress: '进展', deviations: '偏差', risks: '风险', nextPlan: '下期计划', support: '需支持事项' };

export class Management {
  constructor(readonly workbench: Workbench) {}
  private get storage() { return this.workbench.storage; }
  private required<T>(kind: DocumentKind, id: string): T {
    const record = this.storage.get<T>(kind, id); if (!record) throw new AppError(404, '关联记录不存在');
    if (kind === 'line') return lineSchema.parse(record) as T;
    if (kind === 'period') return periodSchema.parse(record) as T;
    if (kind === 'risk') return riskSchema.parse(record) as T;
    return record;
  }
  private transaction<T>(action: () => T): T { return this.storage.database.transaction(action)(); }
  private checkRevision(previous: Entity, revision: string): void { if (previous.revision !== revision) throw new AppError(409, '记录已被更新，请保留当前输入并重新读取最新版本'); }
  private create<T extends object>(kind: DocumentKind, fields: T): T & Entity {
    const record = { ...fields, ...metadata() };
    this.storage.put(kind, record); this.storage.event(record.id, `${kind}.created`, { record }); return record;
  }
  private update<T extends Entity>(kind: DocumentKind, previous: T, fields: Partial<T>, revision: string, details?: Record<string, unknown>): T {
    this.checkRevision(previous, revision);
    const record = { ...previous, ...fields, revision: randomUUID(), updatedAt: new Date().toISOString() };
    const changes = Object.fromEntries(Object.keys(fields).filter(key => key !== 'revision' && JSON.stringify(previous[key as keyof T]) !== JSON.stringify(record[key as keyof T])).map(key => [key, { before: previous[key as keyof T], after: record[key as keyof T] }]));
    this.storage.put(kind, record, revision); this.storage.event(record.id, `${kind}.updated`, { changes, ...details }); return record;
  }
  private validateRange(start: string, end: string): void { if (start > end) throw new AppError(400, '周期开始日期不得晚于结束日期'); }
  private validateReferences(kind: DocumentKind, ids: string[], label: string): void {
    for (const id of ids) if (!this.storage.get(kind, id)) throw new AppError(400, `关联${label}不存在`);
  }
  private validateLineCapacity(archived: boolean, exceptId?: string): void {
    if (!archived && this.listLines().filter(value => !value.archived && value.id !== exceptId).length >= 3) throw new AppError(400, '最多配置3条使用中的产线，请先归档不再使用的产线');
  }
  listLines(): Line[] { return this.storage.list<Line>('line').map(value => lineSchema.parse(value)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  createLine(input: unknown): Line {
    const fields = lineFields.parse(input);
    return this.transaction(() => { this.validateLineCapacity(fields.archived); return this.create('line', fields); });
  }
  patchLine(id: string, input: unknown): Line {
    const patch = linePatchSchema.parse(input);
    return this.transaction(() => { const previous = this.required<Line>('line', id); this.checkRevision(previous, patch.revision); this.validateLineCapacity(patch.archived ?? previous.archived, id); return this.update('line', previous, patch, patch.revision); });
  }
  listPeriods(today = localDate()): PeriodView[] {
    return this.storage.list<Period>('period').map(value => periodSchema.parse(value)).map(period => ({ ...period, completion: period.status === 'done' ? 100 : period.completion, flags: {
      overdue: !['done', 'cancelled'].includes(period.status) && (period.plannedDate ?? period.end) < today,
      pendingConfirmation: !['done', 'cancelled'].includes(period.status) && !period.feedbackAt
    } })).sort((a, b) => b.start.localeCompare(a.start) || a.createdAt.localeCompare(b.createdAt));
  }
  private validatePeriod(period: Period): void {
    this.validateRange(period.start, period.end); this.validateReferences('line', [period.lineId], '产线'); this.validateReferences('task', period.taskIds, '任务');
    if (period.monthlyId) {
      const month = this.storage.get<Period>('period', period.monthlyId);
      if (period.kind !== 'week' || !month || month.kind !== 'month' || month.lineId !== period.lineId) throw new AppError(400, '周重点仅能关联同产线的月重点');
      if (month.start > period.end || month.end < period.start) throw new AppError(400, '关联月重点应与周周期有交集，允许跨月周');
    }
    if (period.feedbackAt && !period.feedbackSource.trim()) throw new AppError(400, '负责人反馈需填写时间与来源依据');
    if (period.status === 'waiting' && (!period.nextAction.trim() || !period.followUpDate)) throw new AppError(400, '等待需填写下一步与检查日期');
    if (period.status !== 'done' && period.completion === 100) throw new AppError(400, '100%完成度需同时将重点标记为已完成');
  }
  private normalizePeriod(period: Period, explicitProgress = false): Period {
    if (period.kind === 'week' && explicitProgress && period.progressStatus) period.status = period.progressStatus === 'done' ? 'done' : period.progressStatus === 'blocked' ? 'blocked' : 'doing';
    if (period.kind === 'week' && !explicitProgress) period.progressStatus = period.status === 'done' ? 'done' : period.status === 'blocked' ? 'blocked' : period.status === 'waiting' || period.progressStatus === 'at_risk' ? 'at_risk' : 'normal';
    if (period.kind === 'week' && explicitProgress && period.status !== 'done' && period.completion === 100) period.completion = 0;
    if (period.status === 'done') period.completion = 100;
    return period;
  }
  createPeriod(input: unknown): Period {
    const fields = periodFields.parse(input);
    const [start, end] = cycleRange(fields.kind, fields.start);
    if (fields.start !== start || fields.end !== end) throw new AppError(400, '新建重点必须使用完整自然周或月');
    return this.transaction(() => { const period = this.normalizePeriod({ ...fields, ...metadata(), carriedFromId: null, carriedToIds: [] }, fields.progressStatus !== null); this.validatePeriod(period); this.storage.put('period', period); this.storage.event(period.id, 'period.created', { record: period }); return period; });
  }
  patchPeriod(id: string, input: unknown): Period {
    const patch = periodPatchSchema.parse(input);
    return this.transaction(() => {
      const previous = this.required<Period>('period', id); this.checkRevision(previous, patch.revision);
      if (patch.kind !== undefined && patch.kind !== previous.kind) throw new AppError(400, '已建立重点的周月类型不能变更，请新建周期计划');
      if (['plannedDate', 'start', 'end'].some(key => key in patch && patch[key as keyof typeof patch] !== previous[key as keyof Period]) && !patch.changeReason?.trim()) throw new AppError(400, '调整周期或计划节点需说明变更原因');
      const next = this.normalizePeriod({ ...previous, ...patch, ...(previous.status === 'done' && patch.status && patch.status !== 'done' && patch.completion === undefined ? { completion: 0 } : {}) }, patch.progressStatus != null); this.validatePeriod(next);
      if (next.carriedFromId) {
        const from = this.required<Period>('period', next.carriedFromId);
        if (from.lineId !== next.lineId || from.kind !== next.kind || next.start <= from.end) throw new AppError(400, '调整后重点必须与结转来源保持同产线、同类型，且周期在来源之后');
      }
      for (const childId of next.carriedToIds) {
        const child = this.required<Period>('period', childId);
        if (child.lineId !== next.lineId || child.kind !== next.kind || child.start <= next.end) throw new AppError(400, '调整后重点必须与结转目标保持同产线、同类型，且周期在目标之前');
      }
      for (const child of this.storage.list<Period>('period').filter(value => value.monthlyId === id)) this.validatePeriod({ ...child, monthlyId: null, lineId: next.lineId });
      if (previous.lineId !== next.lineId && this.storage.list<Period>('period').some(value => value.monthlyId === id)) throw new AppError(400, '该月重点已关联周重点，不能单独更换产线');
      if (this.storage.list<Period>('period').some(value => value.monthlyId === id && (value.start > next.end || value.end < next.start))) throw new AppError(400, '调整后月重点应与已关联周周期有交集');
      return this.update('period', previous, { ...patch, status: next.status, completion: next.completion, progressStatus: next.progressStatus }, patch.revision);
    });
  }
  carryPeriod(id: string, input: unknown): Period {
    const fields = carryPeriodSchema.parse(input);
    return this.transaction(() => {
      const previous = this.required<Period>('period', id);
      const existing = this.listPeriods().find(p => p.carriedFromId === id && p.start === fields.start && p.end === fields.end);
      if (existing) return existing;
      this.checkRevision(previous, fields.revision);
      if (['done', 'cancelled'].includes(previous.status)) throw new AppError(400, '仅未完成重点可以结转');
      this.validateRange(fields.start, fields.end);
      if (fields.start <= previous.end) throw new AppError(400, '结转目标周期必须在原周期之后');
      const next: Period = { ...previous, ...metadata(), start: fields.start, end: fields.end, plannedDate: null, monthlyId: fields.monthlyId ?? null, actual: '', completion: 0, progressStatus: previous.kind === 'week' ? 'normal' : null, feedbackAt: null, feedbackSource: '', changeReason: fields.reason, status: 'planned', carriedFromId: id, carriedToIds: [] };
      this.validatePeriod(next); this.storage.put('period', next); this.storage.event(next.id, 'period.carried', { fromId: id, reason: fields.reason, record: next });
      this.update('period', previous, { carriedToIds: [...previous.carriedToIds, next.id] }, fields.revision, { reason: fields.reason, carriedToId: next.id }); return next;
    });
  }
  carryPrevious(input: unknown): { items: Period[]; created: number } {
    const fields = carryPreviousSchema.parse(input);
    return this.transaction(() => {
      this.required<Line>('line', fields.lineId);
      const [start, end] = cycleRange(fields.kind, fields.start);
      if (start !== fields.start || end !== fields.end) throw new AppError(400, '结转目标必须为完整自然周或月');
      const [previousStart, previousEnd] = cycleRange(fields.kind, shiftDate(start, -1));
      const candidates = this.listPeriods().filter(p => p.lineId === fields.lineId && p.kind === fields.kind && p.start === previousStart && p.end === previousEnd && !['done', 'cancelled'].includes(p.status));
      let created = 0;
      const items = candidates.map(p => {
        const existed = this.listPeriods().some(current => current.carriedFromId === p.id && current.start === start && current.end === end);
        const next = this.carryPeriod(p.id, { revision: p.revision, start, end, reason: fields.reason });
        if (!existed) created++;
        return next;
      });
      return { items, created };
    });
  }
  production(today = localDate()) {
    const periods = this.listPeriods().filter(p => !isPrivateMaterial(this.storage, 'period', p.id));
    const risks = this.listRisks().filter(r => !isPrivateMaterial(this.storage, 'risk', r.id));
    const lines = this.listLines().filter(l => !l.archived);
    const summaries = this.storage.history().filter(e => e.kind === 'line.month-summarized' && lines.some(l => l.id === e.resourceId)).map(e => e.details as MonthSummary);
    return { date: today, week: cycleRange('week', today), month: cycleRange('month', today), lines: lines.map(line => lineOverview(line, periods, risks, today)), summaries, publicPeriodIds: periods.map(p => p.id), publicRiskIds: risks.map(r => r.id) };
  }
  checkCycles(today = localDate()): void {
    this.transaction(() => {
      const periods = this.listPeriods().filter(p => !isPrivateMaterial(this.storage, 'period', p.id));
      const history = this.storage.history();
      const summarized = new Set(history.filter(e => e.kind === 'line.month-summarized').map(e => `${e.resourceId}:${e.details.month}`));
      for (const line of this.listLines()) {
        const months = new Set(periods.filter(p => p.kind === 'month' && p.lineId === line.id && p.start.slice(0, 7) < today.slice(0, 7)).map(p => p.start.slice(0, 7)));
        // Fill every elapsed month, including months with no priorities while the backend was stopped.
        for (let cursor = `${localDate(new Date(line.createdAt)).slice(0, 7)}-01`; cursor.slice(0, 7) < today.slice(0, 7); cursor = shiftDate(cycleRange('month', cursor)[1], 1)) months.add(cursor.slice(0, 7));
        for (const month of months) if (!summarized.has(`${line.id}:${month}`)) this.storage.event(line.id, 'line.month-summarized', monthEndSummary(line, month, periods, history));
      }
    });
  }
  listRisks(): Risk[] { return this.storage.list<Risk>('risk').map(value => riskSchema.parse(value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  private validateRisk(risk: Risk): void {
    if (risk.sensitive) throw new AppError(400, '敏感正文存储尚未获许可，请仅记录脱敏行动摘要');
    this.validateReferences('line', risk.lineIds, '产线'); this.validateReferences('period', risk.periodIds, '周期'); this.validateReferences('task', risk.taskIds, '任务');
    if (risk.status === 'closed' && (!risk.result.trim() || !risk.evidence.trim())) throw new AppError(400, '关闭风险或问题需填写独立结果与依据');
  }
  createRisk(input: unknown): Risk {
    const fields = riskFields.parse(input);
    return this.transaction(() => { const record = { ...fields, ...metadata() }; this.validateRisk(record); this.storage.put('risk', record); this.storage.event(record.id, 'risk.created', { record }); return record; });
  }
  patchRisk(id: string, input: unknown): Risk {
    const patch = riskPatchSchema.parse(input);
    return this.transaction(() => { const previous = this.required<Risk>('risk', id); this.checkRevision(previous, patch.revision); this.validateRisk({ ...previous, ...patch }); return this.update('risk', previous, patch, patch.revision); });
  }
  listMilestones(): Milestone[] { return this.storage.list<Milestone>('milestone').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  private validateMilestone(record: Milestone): void {
    this.validateReferences('task', record.taskIds, '任务'); this.validateReferences('risk', record.riskIds, '风险');
    if (record.validation === 'passed' && (!record.adoptionResult.trim() || !record.validationNote.trim())) throw new AppError(400, '提效验证通过需填写实际试用效果与验证依据');
  }
  createMilestone(input: unknown): Milestone {
    const fields = milestoneFields.parse(input);
    return this.transaction(() => { const record = { ...fields, ...metadata() }; this.validateMilestone(record); this.storage.put('milestone', record); this.storage.event(record.id, 'milestone.created', { record }); return record; });
  }
  patchMilestone(id: string, input: unknown): Milestone {
    const patch = milestonePatchSchema.parse(input);
    return this.transaction(() => { const previous = this.required<Milestone>('milestone', id); this.checkRevision(previous, patch.revision); this.validateMilestone({ ...previous, ...patch }); return this.update('milestone', previous, patch, patch.revision); });
  }
  listRecurrences(): Recurrence[] { return this.storage.list<Recurrence>('recurrence'); }
  createRecurrence(input: unknown): Recurrence {
    const fields = recurrenceFields.parse(input);
    if ((fields.waitingFor || fields.waitingWhat) && (!fields.waitingFor.trim() || !fields.waitingWhat.trim() || !fields.followUpDate)) throw new AppError(400, '材料收集需填写等待对象、内容与跟进日期');
    return this.transaction(() => this.create('recurrence', { ...fields, occurrences: [] }));
  }
  patchRecurrence(id: string, input: unknown): Recurrence {
    const patch = recurrencePatchSchema.parse(input);
    return this.transaction(() => {
      const previous = this.required<Recurrence>('recurrence', id); this.checkRevision(previous, patch.revision);
      const fields = { ...previous, ...patch };
      if ((fields.waitingFor || fields.waitingWhat) && (!fields.waitingFor.trim() || !fields.waitingWhat.trim() || !fields.followUpDate)) throw new AppError(400, '材料收集需填写等待对象、内容与跟进日期');
      if (fields.kind !== previous.kind && previous.occurrences.length) throw new AppError(400, '已生成任务的规则不能更改周期类型');
      return this.update('recurrence', previous, patch, patch.revision);
    });
  }
  materializeRecurrence(input: unknown): { task: Task; created: boolean } {
    const fields = materializeSchema.parse(input);
    return this.transaction(() => {
      const rule = this.required<Recurrence>('recurrence', fields.recurrenceId);
      const date = new Date(`${fields.start}T12:00:00Z`);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      if (rule.kind === 'week' ? date.getUTCDay() !== 1 || fields.end !== shiftDate(fields.start, 6) : !fields.start.endsWith('-01') || fields.end !== lastDay) throw new AppError(400, '周期必须是周一至周日或完整自然月，避免同一期重复生成');
      const occurrence = rule.occurrences.find(value => value.start === fields.start);
      if (occurrence) return { task: this.required<Task>('task', occurrence.taskId), created: false };
      if (!rule.enabled) throw new AppError(400, '周期规则已暂停');
      const task = this.workbench.createTask({ title: `${rule.title}（${fields.start} — ${fields.end}）`, category: 'management', type: 'summary', expectedResult: rule.expectedResult, notes: rule.collectionSource ? `材料来源：${rule.collectionSource}` : '', planDate: fields.start, dueDate: fields.end, status: rule.waitingFor ? 'waiting' : 'todo', waitingFor: rule.waitingFor, waitingWhat: rule.waitingWhat, followUpDate: rule.followUpDate });
      this.update('recurrence', rule, { occurrences: [...rule.occurrences, { start: fields.start, end: fields.end, taskId: task.id }] }, rule.revision);
      this.storage.event(task.id, 'recurrence.materialized', { recurrenceId: rule.id, start: fields.start, end: fields.end }); return { task, created: true };
    });
  }

  reviewSelections(input: unknown): ReviewSelections {
    const { kind, start, end, purpose } = reviewRangeSchema.parse(input);
    this.validateRange(start, end);
    const inRange = (date: string | null | undefined) => Boolean(date && date >= start && date <= end);
    if (purpose === 'plan') return {
      taskIds: this.workbench.listTasks().filter(task => inRange(task.planDate) && !task.archived && !['done', 'cancelled'].includes(task.status) && !isPrivateMaterial(this.storage, 'task', task.id)).map(task => task.id),
      periodIds: [], riskIds: [], milestoneIds: []
    };
    const timestampInRange = (at: string) => inRange(localDate(new Date(at)));
    const activeIds = new Set(this.storage.history().filter(event => timestampInRange(event.at) && /^(period|risk|milestone)\.(created|updated)$/.test(event.kind)).map(event => event.resourceId));
    const selected = (record: Entity, dates: (string | null | undefined)[]) => activeIds.has(record.id) || dates.some(inRange);
    const tasks = this.workbench.listTasks();
    const taskIds = tasks.filter(task => task.status !== 'cancelled' && !isPrivateMaterial(this.storage, 'task', task.id) && (
      [task.planDate, task.startDate, task.dueDate, task.followUpDate].some(inRange) || Boolean(task.completedAt && timestampInRange(task.completedAt))
    )).map(task => task.id);
    const periodIds = this.storage.list<Period>('period').filter(period => period.kind === kind && period.status !== 'cancelled' && period.start <= end && period.end >= start && !isPrivateMaterial(this.storage, 'period', period.id)).map(period => period.id);
    const periodSet = new Set(periodIds);
    const riskIds = this.storage.list<Risk>('risk').filter(risk => !isPrivateMaterial(this.storage, 'risk', risk.id) && (selected(risk, [risk.nextCheckDate]) || risk.periodIds.some(id => periodSet.has(id)))).map(risk => risk.id);
    const milestoneIds = this.storage.list<Milestone>('milestone').filter(milestone => milestone.status !== 'cancelled' && !isPrivateMaterial(this.storage, 'milestone', milestone.id) && selected(milestone, [milestone.plannedDate])).map(milestone => milestone.id);
    return { taskIds, periodIds, riskIds, milestoneIds };
  }

  private collectFacts(selections: ReviewSelections, start: string, end: string, includeAssociated = true): { facts: FactSnapshot[]; selections: ReviewSelections; excludedSensitiveCount: number } {
    const facts = new Map<string, FactSnapshot>(); const excluded = new Set<string>(); const now = new Date().toISOString();
    const cleanSelections: ReviewSelections = { taskIds: [], periodIds: [], riskIds: [], milestoneIds: [] };
    const occurredInRange = (at: string) => { const date = localDate(new Date(at)); return date >= start && date <= end; };
    const completionInRange = (record: Entity, kind: FactSnapshot['kind']) => this.workbench.getHistory(record.id).some(event => {
      if (!occurredInRange(event.at)) return false;
      if (event.kind === 'task.completed') return true;
      if (event.kind === 'task.created') return event.details.status === 'done';
      if (event.kind === `${kind}.created`) return (event.details.record as { status?: string } | undefined)?.status === 'done';
      if (event.kind === `${kind}.updated`) return ((event.details.changes as { status?: { after?: string } } | undefined)?.status?.after) === 'done';
      return false;
    });
    const base = (record: Entity & { title: string; status: string }, kind: FactSnapshot['kind'], details: Partial<FactSnapshot>): FactSnapshot => ({
      id: record.id, revision: record.revision, title: record.title, status: record.status, kind, actual: '', expectedResult: '', nextAction: '', reason: '', verification: '待核实', source: '本地人工记录', capturedAt: now, updatedAt: record.updatedAt, inRange: occurredInRange(record.updatedAt), completedInRange: completionInRange(record, kind), sensitive: false, sourceReferences: [], ...details
    });
    const addTask = (id: string, selected = false): void => {
      const task = this.required<Task>('task', id);
      if (isPrivateMaterial(this.storage, 'task', id)) { excluded.add(id); return; }
      if (selected) cleanSelections.taskIds.push(id);
      const completedInRange = completionInRange(task, 'task');
      const sourceReferences = this.storage.list<SourceObject>('source-record').filter(source => source.localTaskId === task.id).map(source => {
        let url = ''; try { const parsed = new URL(source.url); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) { parsed.search = ''; parsed.hash = ''; url = parsed.href; } } catch { /* Invalid source links remain unlinked rather than becoming trusted URLs. */ }
        return { id: source.id, revision: source.revision, provider: source.provider, objectType: sourceObjectType(source), projectId: source.projectId, projectName: source.projectName, externalId: source.externalId, number: source.number, url, sourceState: source.sourceState, lastSeenAt: source.lastSeenAt, currentSha: source.currentSha ?? null, checkedSha: source.checkedSha ?? null, reviewStatus: source.reviewStatus };
      });
      const sourceText = sourceReferences.map(source => `${source.provider} ${source.projectName || source.projectId} ${sourceNumber(source)} ${source.url}；来源快照 ${source.lastSeenAt}：${source.sourceState}${isMergeRequest(source) ? `；当前提交 ${source.currentSha ?? '无'}；已检查提交 ${source.checkedSha ?? '无'}；评审进展 ${source.reviewStatus}` : ''}`).join('；');
      const record = base(task, 'task', { actual: task.deliveryNote || task.validationNote || task.nextAction, expectedResult: task.expectedResult, nextAction: task.nextAction, verification: `${task.validation === 'passed' ? '已验证' : '未验证'}；${task.delivery === 'delivered' ? '本地交付记录有依据' : '交付待核实'}${task.sourceState ? `；来源状态：${task.sourceState}` : ''}`, source: sourceText || (task.sourceState ? `来源状态快照：${task.sourceState}（未核实最新状态）` : '本地个人行动记录'), sourceReferences, inRange: completedInRange || occurredInRange(task.updatedAt), completedInRange });
      record.reason = task.status === 'blocked' ? task.blockedReason : task.status === 'waiting' ? `等待${task.waitingFor}反馈：${task.waitingWhat}` : '';
      facts.set(`task:${id}`, record);
    };
    for (const id of selections.taskIds) addTask(id, true);
    for (const id of selections.periodIds) {
      const record = this.required<Period>('period', id);
      if (isPrivateMaterial(this.storage, 'period', id)) { excluded.add(id); continue; }
      cleanSelections.periodIds.push(id);
      facts.set(`period:${id}`, base(record, 'period', { actual: record.actual, expectedResult: record.expectedResult, nextAction: record.nextAction, verification: record.feedbackAt ? '负责人反馈（需复核）' : '缺少负责人反馈，待核实', source: record.feedbackAt ? `${record.feedbackAt}；${record.feedbackSource}` : '本地产线计划，反馈缺失', inRange: record.start <= end && record.end >= start }));
      if (includeAssociated) for (const taskId of record.taskIds) addTask(taskId);
    }
    for (const id of selections.riskIds) {
      const record = this.required<Risk>('risk', id);
      if (isPrivateMaterial(this.storage, 'risk', id)) { excluded.add(id); continue; }
      cleanSelections.riskIds.push(id);
      facts.set(`risk:${id}`, base(record, 'risk', { actual: record.result || record.impact, nextAction: record.response, verification: record.evidence ? '人工结果依据（需复核）' : '结果待核实', source: record.evidence || '本地风险／问题记录' }));
      if (includeAssociated) for (const taskId of record.taskIds) addTask(taskId);
    }
    for (const id of selections.milestoneIds) {
      const record = this.required<Milestone>('milestone', id);
      if (isPrivateMaterial(this.storage, 'milestone', id)) { excluded.add(id); continue; }
      cleanSelections.milestoneIds.push(id);
      facts.set(`milestone:${id}`, base(record, 'milestone', { actual: `部署／交付：${record.deliveryResult || '无记录'}；实际试用／效果：${record.adoptionResult || '待证实'}`, expectedResult: record.expectedResult, nextAction: record.nextAction, verification: record.validation === 'passed' ? `效果已记录验证依据：${record.validationNote}` : '效果未验证', source: record.validationNote || '本地专题里程碑记录' }));
      if (includeAssociated) for (const taskId of record.taskIds) addTask(taskId);
    }
    return { facts: [...facts.values()], selections: cleanSelections, excludedSensitiveCount: excluded.size };
  }
  private buildSections(facts: FactSnapshot[]): ReviewSections {
    const sections = reviewSectionsSchema.parse({});
    const append = (key: keyof ReviewSections, value: string) => { sections[key] += `${sections[key] ? '\n' : ''}${value}`; };
    for (const fact of facts) {
      const citation = `[${fact.kind}:${fact.id}]`;
      const line = `- ${fact.title}：${fact.actual || fact.expectedResult || '暂无结果材料'}（${fact.verification}；${fact.inRange ? '周期内事实' : '周期外快照，待核对本期进展'}） ${citation}`;
      if (fact.status === 'cancelled') { append('deviations', `- 已取消：${fact.title}，不计成果 ${citation}`); continue; }
      if (fact.kind === 'risk') append('risks', line);
      else if (fact.status === 'done' && fact.completedInRange) append('accomplishments', line);
      else append('progress', line);
      if (fact.nextAction && fact.status !== 'done' && fact.status !== 'closed') append('nextPlan', `- ${fact.nextAction} ${citation}`);
      if (['waiting', 'blocked'].includes(fact.status)) append('support', `- ${fact.title}：${fact.nextAction || '需补充支持事项'} ${citation}`);
    }
    return sections;
  }
  private buildBrief(facts: FactSnapshot[]): string {
    const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
    const body = facts.map((fact, index) => {
      const status = ['done', 'closed'].includes(fact.status) ? '完成' : ['doing', 'waiting', 'watching'].includes(fact.status) ? '进行中' : '未完成';
      const reason = status === '完成' ? '' : fact.status === 'cancelled' ? '已取消' : oneLine(fact.reason || '');
      return `${index + 1}、${oneLine(fact.title)}--${status}${reason ? `，${reason}` : ''}`;
    }).join('\n');
    if (body.length > 200000) throw new AppError(400, '所选事项的报告过长，请减少材料或缩短原因后重试');
    return body;
  }
  private markdown(review: Pick<Review, 'title' | 'start' | 'end' | 'sections' | 'facts' | 'format' | 'reportBody'>): string {
    if (review.format === 'brief') return `# ${review.title}\n\n周期：${review.start} — ${review.end}\n\n${review.reportBody || '本期暂无事项'}\n`;
    return `# ${review.title}\n\n周期：${review.start} — ${review.end}（Asia/Shanghai，周一为周起始日）\n\n生成方式：本地事实模板（未调用AI）；事实与结论需人工复核。\n\n${Object.entries(review.sections).map(([key, value]) => `## ${sectionLabels[key as keyof ReviewSections]}\n\n${value || '待补充'}`).join('\n\n')}\n\n## 事实来源\n\n${review.facts.map(fact => `- [${fact.kind}:${fact.id}] ${fact.title}；${fact.source}；快照 ${fact.capturedAt}；${fact.verification}`).join('\n')}\n`;
  }
  private reviewView(record: Review): ReviewView {
    const exportBlocked = !!record.privacyRestricted || [record.facts, ...record.versions.map(version => version.facts)].some(facts => facts.some(fact => (fact.kind !== 'task' || this.storage.get('task', fact.id)) && isPrivateMaterial(this.storage, fact.kind, fact.id)));
    const exportWarning = exportBlocked ? '该回顾的既有快照关联当前已标记的敏感、人员或招聘材料，或无法核实其隐私状态；普通导出与发布已禁止。请重新选择脱敏事实建立回顾。已发布版本保留在本机历史中。' : '';
    return { ...record, includeNextWeekPlan: record.includeNextWeekPlan ?? false, nextWeekTaskIds: record.nextWeekTaskIds ?? [], format: record.format ?? 'sections', reportBody: record.reportBody ?? '', exportBlocked, exportWarning, markdown: exportBlocked ? `禁止分享或导出该回顾。\n\n${exportWarning}\n` : this.markdown(record), differences: record.facts.map(fact => {
      const current = this.storage.get<Entity>(fact.kind, fact.id);
      const sourcesChanged = (fact.sourceReferences ?? []).some(source => this.storage.get<Entity>('source-record', source.id)?.revision !== source.revision);
      return { id: fact.id, kind: fact.kind, state: !current ? 'missing' : current.revision !== fact.revision || sourcesChanged ? 'changed' : 'unchanged' };
    }) };
  }
  listReviews(): ReviewView[] { return this.storage.list<Review>('review').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(record => this.reviewView(record)); }
  getReview(id: string): ReviewView { return this.reviewView(this.required<Review>('review', id)); }
  createReview(input: unknown): ReviewView {
    const fields = reviewFields.parse(input); this.validateRange(fields.start, fields.end);
    return this.transaction(() => {
      const publicPeriods = this.listPeriods().filter(p => !isPrivateMaterial(this.storage, 'period', p.id));
      const publicRisks = this.listRisks().filter(r => !isPrivateMaterial(this.storage, 'risk', r.id));
      const production = fields.kind === 'week' ? productionReport(this.listLines(), publicPeriods, publicRisks, this.storage.history(), fields.start, fields.end) : { text: '', periodIds: [], riskIds: [] };
      const augmented = { ...fields.selections, periodIds: [...new Set([...fields.selections.periodIds, ...production.periodIds])], riskIds: [...new Set([...fields.selections.riskIds, ...production.riskIds])] };
      const selection = this.collectFacts(augmented, fields.start, fields.end, fields.format === 'sections');
      const planRange = nextWeekRange(fields.end);
      const planIds = fields.includeNextWeekPlan ? fields.nextWeekTaskIds.filter(id => {
        const task = this.required<Task>('task', id);
        return !task.archived && !['done', 'cancelled'].includes(task.status);
      }) : [];
      const plan = this.collectFacts({ taskIds: planIds, periodIds: [], riskIds: [], milestoneIds: [] }, planRange.start, planRange.end, false);
      const currentTaskIds = new Set(selection.facts.filter(fact => fact.kind === 'task').map(fact => fact.id));
      const facts = [...selection.facts, ...plan.facts.filter(fact => !currentTaskIds.has(fact.id))];
      const planBody = plan.facts.map((fact, index) => `${index + 1}、${fact.title.replace(/[\r\n]+/g, ' ').trim()}`).join('\n');
      const productionIds = new Set([...production.periodIds, ...production.riskIds]);
      // Production facts have their own section; manually selected other material keeps the existing brief format.
      const briefFacts = selection.facts.filter(fact => !productionIds.has(fact.id));
      let reportBody = fields.format === 'brief' ? this.buildBrief(briefFacts) : '';
      const sections = fields.format === 'sections' ? this.buildSections(briefFacts) : reviewSectionsSchema.parse({});
      if (fields.includeNextWeekPlan) {
        if (fields.format === 'brief') reportBody = `本${fields.kind === 'week' ? '周' : '月'}回顾\n${reportBody || '本期暂无事项'}\n\n下周计划（${planRange.start} — ${planRange.end}）\n${planBody || '暂无计划事项'}`;
        else sections.nextPlan = planBody;
      }
      if (production.text) {
        if (fields.format === 'brief') reportBody = `${reportBody}${reportBody ? '\n\n' : ''}${production.text}`;
        else sections.progress = `${sections.progress}${sections.progress ? '\n\n' : ''}${production.text}`;
      }
      if (reportBody.length > 200000 || !reviewSectionsSchema.safeParse(sections).success) throw new AppError(400, '所选事项的报告过长，请减少材料或缩短原因后重试');
      const excludedSensitiveCount = selection.excludedSensitiveCount + plan.excludedSensitiveCount - planIds.filter(id => fields.selections.taskIds.includes(id) && isPrivateMaterial(this.storage, 'task', id)).length;
      const record: Review = { ...fields, ...selection, ...metadata(), facts, excludedSensitiveCount, nextWeekTaskIds: plan.selections.taskIds, reportBody, sections, versions: [], status: 'draft', generator: 'local-facts', aiDrafts: [] };
      this.storage.put('review', record); this.storage.event(record.id, 'review.created', { factIds: record.facts.map(fact => `${fact.kind}:${fact.id}`), excludedSensitiveCount: record.excludedSensitiveCount }); return this.reviewView(record);
    });
  }
  patchReview(id: string, input: unknown): ReviewView {
    const patch = reviewPatchSchema.parse(input);
    return this.transaction(() => { const previous = this.required<Review>('review', id); return this.reviewView(this.update('review', previous, { title: patch.title ?? previous.title, reportBody: patch.reportBody ?? previous.reportBody ?? '', sections: { ...previous.sections, ...patch.sections }, status: 'draft' }, patch.revision)); });
  }
  deleteReview(id: string, input: unknown): { deleted: true; id: string } {
    const fields = deleteReviewInputSchema.parse(input);
    return this.transaction(() => {
      const previous = this.required<Review>('review', id); this.checkRevision(previous, fields.revision);
      this.storage.delete('review', id, fields.revision);
      this.storage.event(id, 'review.deleted', { versionCount: previous.versions.length });
      return { deleted: true, id };
    });
  }
  publishReview(id: string, input: unknown): ReviewView {
    const fields = publishReviewInputSchema.parse(input);
    return this.transaction(() => {
      const previous = this.required<Review>('review', id); this.checkRevision(previous, fields.revision);
      if (this.reviewView(previous).exportBlocked) throw new AppError(403, '回顾关联当前敏感、人员或招聘材料，禁止普通发布，请重新选择脱敏事实');
      if (previous.status === 'published') throw new AppError(409, '当前草稿已发布，请编辑后创建下一版本');
      const version = { version: previous.versions.length + 1, publishedAt: new Date().toISOString(), title: previous.title, kind: previous.kind, start: previous.start, end: previous.end, includeNextWeekPlan: previous.includeNextWeekPlan ?? false, nextWeekTaskIds: [...(previous.nextWeekTaskIds ?? [])], format: previous.format ?? 'sections', reportBody: previous.reportBody ?? '', sections: structuredClone(previous.sections), facts: structuredClone(previous.facts), markdown: this.markdown(previous) };
      return this.reviewView(this.update('review', previous, { status: 'published', versions: [...previous.versions, version] }, fields.revision));
    });
  }
}

export function registerManagementRoutes(app: FastifyInstance, workbench: Workbench): Management {
  const service = new Management(workbench);
  const routeId = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  app.get('/api/lines', () => ({ items: service.listLines() }));
  app.post('/api/lines', request => service.createLine(request.body));
  app.patch('/api/lines/:id', request => service.patchLine(routeId(request.params), request.body));
  app.get('/api/periods', () => ({ items: service.listPeriods() }));
  app.post('/api/periods', request => service.createPeriod(request.body));
  app.patch('/api/periods/:id', request => service.patchPeriod(routeId(request.params), request.body));
  app.post('/api/periods/:id/carry', request => service.carryPeriod(routeId(request.params), request.body));
  app.post('/api/periods/carry-previous', request => service.carryPrevious(request.body));
  app.get('/api/production', request => service.production(productionQuerySchema.parse(request.query).date));
  app.get('/api/risks', () => ({ items: service.listRisks() }));
  app.post('/api/risks', request => service.createRisk(request.body));
  app.patch('/api/risks/:id', request => service.patchRisk(routeId(request.params), request.body));
  app.get('/api/milestones', () => ({ items: service.listMilestones() }));
  app.post('/api/milestones', request => service.createMilestone(request.body));
  app.patch('/api/milestones/:id', request => service.patchMilestone(routeId(request.params), request.body));
  app.get('/api/recurrences', () => ({ items: service.listRecurrences() }));
  app.post('/api/recurrences', request => service.createRecurrence(request.body));
  app.patch('/api/recurrences/:id', request => service.patchRecurrence(routeId(request.params), request.body));
  app.post('/api/recurrences/materialize', request => service.materializeRecurrence(request.body));
  app.get('/api/reviews', () => ({ items: service.listReviews() }));
  app.get('/api/reviews/selections', request => service.reviewSelections(request.query));
  app.get('/api/reviews/:id', request => service.getReview(routeId(request.params)));
  app.post('/api/reviews', request => service.createReview(request.body));
  app.patch('/api/reviews/:id', request => service.patchReview(routeId(request.params), request.body));
  app.delete('/api/reviews/:id', request => service.deleteReview(routeId(request.params), request.body));
  app.post('/api/reviews/:id/publish', request => service.publishReview(routeId(request.params), revisionInput.parse(request.body)));
  return service;
}
