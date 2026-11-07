import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management, registerManagementRoutes } from '../apps/server/src/management.js';

describe('durable management and factual reviews', () => {
  let dir: string;
  let workbench: Workbench;
  let management: Management;
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-30T04:00:00Z')); dir = mkdtempSync(join(tmpdir(), 'pwb-management-')); workbench = new Workbench(dir); management = new Management(workbench); });
  afterEach(() => { workbench.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });
  const range = { start: '2026-10-26', end: '2026-11-01' };
  function line() { return management.createLine({ name: '虚构产线', owner: '负责人代号' }); }

  it('preselects next-week plans only by plan date and excludes completed, archived and private tasks', () => {
    const monday = workbench.createTask({ title: '下周一', planDate: '2026-11-02' });
    const sunday = workbench.createTask({ title: '下周日', planDate: '2026-11-08' });
    workbench.createTask({ title: '仅截止', dueDate: '2026-11-03' });
    workbench.createTask({ title: '周外', planDate: '2026-11-09' });
    workbench.createTask({ title: '已完成', status: 'done', planDate: '2026-11-03' });
    workbench.createTask({ title: '已取消', status: 'cancelled', planDate: '2026-11-03' });
    workbench.createTask({ title: '已归档', archived: true, archiveReason: '后续另行安排', planDate: '2026-11-03' });
    const parent = workbench.createTask({ title: '人员', type: 'people' });
    workbench.createTask({ title: '私密子项', parentId: parent.id, planDate: '2026-11-03' });
    const selected = management.reviewSelections({ kind: 'week', purpose: 'plan', start: '2026-11-02', end: '2026-11-08' });
    expect(selected).toEqual({ taskIds: expect.arrayContaining([monday.id, sunday.id]), periodIds: [], riskIds: [], milestoneIds: [] });
    expect(selected.taskIds).toHaveLength(2);
  });

  it('numbers retrospective and next-week plans independently and retains their roles after publication and restart', () => {
    const current = workbench.createTask({ title: '本期开发', status: 'doing' });
    const future = workbench.createTask({ title: '下周联调', planDate: '2026-11-02' });
    const removed = workbench.createTask({ title: '手动取消计划', planDate: '2026-11-03' });
    const review = management.createReview({ title: '含计划的周报', kind: 'week', ...range, includeNextWeekPlan: true, nextWeekTaskIds: [current.id, future.id, future.id], selections: { taskIds: [current.id] } });
    expect(review.reportBody).toBe('本周回顾\n1、本期开发--进行中\n\n下周计划（2026-11-02 — 2026-11-08）\n1、本期开发\n2、下周联调');
    expect(review.facts).toHaveLength(2);
    expect(review.facts.some(fact => fact.id === removed.id)).toBe(false);
    const published = management.publishReview(review.id, { revision: review.revision });
    expect(published.versions[0]).toMatchObject({ includeNextWeekPlan: true, nextWeekTaskIds: [current.id, future.id], reportBody: review.reportBody });
    workbench.close(); workbench = new Workbench(dir); management = new Management(workbench);
    expect(management.listReviews()[0].versions).toEqual(published.versions);
    workbench.patchTask(future.id, { revision: future.revision, type: 'people' });
    expect(management.listReviews()[0].exportBlocked).toBe(true);
  });

  it('uses the next natural week after month-end across years and ignores disabled plans', () => {
    const task = workbench.createTask({ title: '跨年计划', planDate: '2027-01-04' });
    const fields = { title: '十二月回顾', kind: 'month', start: '2026-12-01', end: '2026-12-31', nextWeekTaskIds: [task.id] };
    const included = management.createReview({ ...fields, includeNextWeekPlan: true });
    expect(included.reportBody).toContain('下周计划（2027-01-04 — 2027-01-10）\n1、跨年计划');
    const disabled = management.createReview({ ...fields, includeNextWeekPlan: false });
    expect(disabled.facts).toEqual([]); expect(disabled.reportBody).toBe('');
    expect(disabled.nextWeekTaskIds).toEqual([]);
  });

  it('preselects public tasks by their dates rather than creation or edit activity across weekly and monthly ranges', async () => {
    vi.setSystemTime(new Date('2026-09-20T04:00:00Z'));
    const planned = workbench.createTask({ title: '本周计划', planDate: '2026-10-28' });
    const due = workbench.createTask({ title: '本周截止', dueDate: '2026-10-30' });
    const touched = workbench.createTask({ title: '本周推进', status: 'doing' });
    const completed = workbench.createTask({ title: '本周完成' });
    const excluded = workbench.createTask({ title: '周期外事项' });
    const reordered = workbench.createTask({ title: '仅改顺序' });
    const privateParent = workbench.createTask({ title: '人员事项', type: 'people' });
    const privateChild = workbench.createTask({ title: '人员子事项', parentId: privateParent.id, planDate: '2026-10-28' });
    vi.setSystemTime(new Date('2026-10-20T04:00:00Z'));
    const monthly = workbench.createTask({ title: '仅本月新增' });
    const productionLine = line();
    const period = management.createPeriod({ title: '本周重点', kind: 'week', lineId: productionLine.id, ...range, taskIds: [planned.id] });
    const month = management.createPeriod({ title: '本月重点', kind: 'month', lineId: productionLine.id, start: '2026-10-01', end: '2026-10-31' });
    vi.setSystemTime(new Date('2026-10-30T04:00:00Z'));
    workbench.patchTask(touched.id, { revision: touched.revision, nextAction: '已完成方案，继续联调' });
    workbench.patchTask(completed.id, { revision: completed.revision, status: 'done' });
    workbench.patchTask(reordered.id, { revision: reordered.revision, order: 10 });
    const cancelled = workbench.createTask({ title: '取消事项', status: 'cancelled' });
    const app = Fastify(); registerManagementRoutes(app, workbench);
    try {
      const response = await app.inject({ method: 'GET', url: `/api/reviews/selections?kind=week&start=${range.start}&end=${range.end}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().taskIds.sort()).toEqual([planned.id, due.id, completed.id].sort());
      expect(response.json().periodIds).toEqual([period.id]);
      expect(JSON.stringify(response.json())).not.toContain(privateChild.id);
      const monthlyResponse = await app.inject({ method: 'GET', url: '/api/reviews/selections?kind=month&start=2026-10-01&end=2026-10-31' });
      expect(monthlyResponse.json().taskIds.sort()).toEqual([planned.id, due.id, completed.id].sort());
      expect(monthlyResponse.json().periodIds).toEqual([month.id]);
      for (const id of [excluded.id, reordered.id, touched.id, monthly.id, privateParent.id, privateChild.id, cancelled.id]) expect(monthlyResponse.json().taskIds).not.toContain(id);
      const invalid = await app.inject({ method: 'GET', url: '/api/reviews/selections?kind=week&start=2026-11-08&end=2026-11-02' });
      expect(invalid.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it.each([
    ['week', '2026-10-26', '2026-11-01'],
    ['month', '2026-10-01', '2026-10-31'],
  ] as const)('preselects %s tasks only when a task date falls within the inclusive range', (kind, start, end) => {
    const selectedIds: string[] = [];
    for (const field of ['planDate', 'startDate', 'dueDate', 'followUpDate'] as const) {
      for (const date of [start, end]) selectedIds.push(workbench.createTask({ title: `${field}-${date}`, [field]: date }).id);
      workbench.createTask({ title: `${field}-过去`, [field]: '2026-09-30' });
      workbench.createTask({ title: `${field}-未来`, [field]: '2026-11-02' });
    }
    workbench.createTask({ title: '本期新增但无任务日期' });
    workbench.createTask({ title: '本期取消', status: 'cancelled', planDate: start });
    workbench.createTask({ title: '敏感行动', type: 'people', planDate: start });
    for (const at of [`${start}T00:00:00+08:00`, `${end}T23:59:59+08:00`]) {
      vi.setSystemTime(new Date(at));
      selectedIds.push(workbench.createTask({ title: `本期完成-${at}`, status: 'done' }).id);
    }
    for (const at of [`${start}T00:00:00+08:00`, `${end}T23:59:59+08:00`]) {
      vi.setSystemTime(new Date(new Date(at).valueOf() + (at.includes('T00:') ? -1000 : 1000)));
      workbench.createTask({ title: `周期外完成-${at}`, status: 'done' });
    }
    expect(management.reviewSelections({ kind, start, end }).taskIds.sort()).toEqual(selectedIds.sort());
  });

  it('does not preselect undated or out-of-range tasks through period, risk or milestone associations', () => {
    const undated = workbench.createTask({ title: '无日期关联任务' });
    const future = workbench.createTask({ title: '未来关联任务', planDate: '2026-11-02' });
    const dated = workbench.createTask({ title: '本期关联任务', planDate: '2026-10-30' });
    const taskIds = [undated.id, future.id, dated.id];
    const period = management.createPeriod({ title: '本期重点', kind: 'week', lineId: line().id, ...range, taskIds });
    management.createRisk({ title: '本期风险', taskIds });
    management.createMilestone({ title: '本期里程碑', taskIds });
    const selections = management.reviewSelections({ kind: 'week', ...range });
    expect(selections.taskIds).toEqual([dated.id]);
    expect(selections.periodIds).toContain(period.id);
    expect(selections.riskIds).toHaveLength(1);
    expect(selections.milestoneIds).toHaveLength(1);
  });

  it('creates concise status reports and preserves edits, versions and restart persistence', () => {
    const done = workbench.createTask({ title: '正常完成', status: 'done', deliveryNote: '完成时的长说明不会自动进入简报' });
    const doing = workbench.createTask({ title: '接口开发', status: 'doing' });
    const blocked = workbench.createTask({ title: '部署', status: 'blocked', blockedReason: '环境未就绪', followUpDate: '2026-10-31', nextAction: '联系环境负责人' });
    const review = management.createReview({ title: '简洁周报', kind: 'week', ...range, selections: { taskIds: [done.id, done.id, doing.id, blocked.id] } });
    expect(review).toMatchObject({ format: 'brief', reportBody: '1、正常完成--完成\n2、接口开发--进行中\n3、部署--未完成，环境未就绪' });
    expect(review.markdown).not.toMatch(/## 成果|事实来源|未验证|完成时的长说明/);
    const edited = management.patchReview(review.id, { revision: review.revision, reportBody: '1、正常完成--完成\n2、接口开发--进行中，正在联调\n3、部署--未完成，环境未就绪' });
    expect(edited.markdown).toContain('接口开发--进行中，正在联调');
    const published = management.publishReview(review.id, { revision: edited.revision });
    const version = structuredClone(published.versions[0]);
    management.patchReview(review.id, { revision: published.revision, reportBody: '新的人工说明' });
    expect(() => management.patchReview(review.id, { revision: published.revision, reportBody: '旧修订覆盖' })).toThrow(/更新/);
    workbench.close(); workbench = new Workbench(dir); management = new Management(workbench);
    expect(management.listReviews()[0]).toMatchObject({ reportBody: '新的人工说明', versions: [version] });
    expect(version.markdown).toContain('接口开发--进行中，正在联调');
  });

  it('keeps legacy six-section reviews readable without converting their saved content', () => {
    const task = workbench.createTask({ title: '旧回顾事实', status: 'done' });
    const review = management.createReview({ title: '旧回顾', format: 'sections', kind: 'week', ...range, selections: { taskIds: [task.id] } });
    const stored = { ...review } as Record<string, unknown>;
    delete stored.format; delete stored.reportBody; delete stored.markdown; delete stored.differences; delete stored.exportBlocked; delete stored.exportWarning;
    workbench.storage.put('review', stored as typeof review, review.revision);
    const legacy = management.listReviews()[0];
    expect(legacy.markdown).toContain('## 成果');
    expect(legacy.markdown).toContain('旧回顾事实');
    expect(legacy.sections).toEqual(review.sections);
  });

  it('lets manually unchecked linked actions stay out of the brief and retains legacy association expansion', () => {
    vi.setSystemTime(new Date('2026-09-20T04:00:00Z'));
    const task = workbench.createTask({ title: '关联的旧行动', planDate: '2026-10-28' });
    const productionLine = line();
    const period = management.createPeriod({ title: '本期重点', kind: 'week', lineId: productionLine.id, ...range, taskIds: [task.id] });
    expect(management.reviewSelections({ kind: 'week', ...range }).taskIds).toContain(task.id);
    const brief = management.createReview({ title: '手动取消勾选', kind: 'week', ...range, selections: { periodIds: [period.id], taskIds: [] } });
    expect(brief.facts.map(fact => fact.id)).toEqual([period.id]);
    const legacy = management.createReview({ title: '章节式回顾', format: 'sections', kind: 'week', ...range, selections: { periodIds: [period.id] } });
    expect(legacy.facts.map(fact => fact.id)).toContain(task.id);
  });

  it('rejects oversized generated reports without saving an unusable review', () => {
    const tasks = Array.from({ length: 11 }, (_, index) => workbench.createTask({ title: `长原因事项${index}`, status: 'blocked', blockedReason: '原'.repeat(20000), followUpDate: '2026-10-31', nextAction: '核对' }));
    expect(() => management.createReview({ title: '过长报告', kind: 'week', ...range, selections: { taskIds: tasks.map(task => task.id) } })).toThrow(/过长|减少/);
    expect(management.listReviews()).toEqual([]);
  });

  it('starts without fabricated lines, allows three and persists their editable names', () => {
    expect(management.listLines()).toEqual([]);
    const first = line(); management.createLine({ name: '二线' }); management.createLine({ name: '三线' });
    expect(() => management.createLine({ name: '四线' })).toThrow(/三|3/);
    management.patchLine(first.id, { revision: first.revision, name: '产线甲' });
    workbench.close(); workbench = new Workbench(dir); management = new Management(workbench);
    expect(management.listLines().some(value => value.name === '产线甲')).toBe(true);
    expect(() => management.patchLine(first.id, { revision: first.revision, name: '过期覆盖' })).toThrow(/更新/);
  });

  it('shares one task across week/month and never completes the month automatically', () => {
    const productionLine = line(); const task = workbench.createTask({ title: '同一研发行动' });
    const month = management.createPeriod({ title: '月目标', kind: 'month', lineId: productionLine.id, start: '2026-11-01', end: '2026-11-30', taskIds: [task.id] });
    const week = management.createPeriod({ title: '跨月周', kind: 'week', lineId: productionLine.id, ...range, monthlyId: month.id, taskIds: [task.id] });
    workbench.patchTask(task.id, { revision: task.revision, status: 'done' });
    management.patchPeriod(week.id, { revision: week.revision, status: 'done' });
    expect(management.listPeriods().find(value => value.id === month.id)?.status).toBe('planned');
    expect(workbench.listTasks()).toHaveLength(1);
    expect(() => management.createPeriod({ title: '坏引用', kind: 'week', lineId: productionLine.id, ...range, taskIds: ['00000000-0000-4000-8000-000000000000'] })).toThrow(/任务/);
  });

  it('keeps omitted values intact across partial updates of every management document', () => {
    const originalLine = management.createLine({ name: '原名称', owner: '负责人代号', description: '保留说明' });
    expect(management.patchLine(originalLine.id, { revision: originalLine.revision, name: '改名' })).toMatchObject({ owner: '负责人代号', description: '保留说明' });
    const task = workbench.createTask({ title: '关联行动' });
    const period = management.createPeriod({ title: '重点', kind: 'week', lineId: originalLine.id, ...range, taskIds: [task.id], actual: '保留进展', owner: '负责人代号' });
    expect(management.patchPeriod(period.id, { revision: period.revision, title: '新标题' })).toMatchObject({ actual: '保留进展', taskIds: [task.id], owner: '负责人代号' });
    const risk = management.createRisk({ title: '风险', impact: '保留影响', taskIds: [task.id] });
    expect(management.patchRisk(risk.id, { revision: risk.revision, title: '修改风险' })).toMatchObject({ impact: '保留影响', taskIds: [task.id] });
    const milestone = management.createMilestone({ title: '节点', deliveryResult: '部署记录', project: '专题' });
    expect(management.patchMilestone(milestone.id, { revision: milestone.revision, title: '新节点' })).toMatchObject({ deliveryResult: '部署记录', project: '专题' });
    const recurrence = management.createRecurrence({ title: '周例行', kind: 'week', collectionSource: '材料来源' });
    expect(management.patchRecurrence(recurrence.id, { revision: recurrence.revision, enabled: false })).toMatchObject({ collectionSource: '材料来源' });
    const review = management.createReview({ title: '回顾', kind: 'week', ...range, selections: { taskIds: [task.id] } });
    expect(management.patchReview(review.id, { revision: review.revision, sections: { nextPlan: '人工下期计划' } }).sections.progress).toBe(review.sections.progress);
  });

  it('preserves original plans, adjustment reason and feedback evidence in history', () => {
    const period = management.createPeriod({ title: '联调', kind: 'week', lineId: line().id, ...range, plannedDate: '2026-10-30' });
    expect(() => management.patchPeriod(period.id, { revision: period.revision, plannedDate: '2026-11-01' })).toThrow(/原因/);
    const next = management.patchPeriod(period.id, { revision: period.revision, plannedDate: '2026-11-01', changeReason: '资源协调', actual: '已完成阶段检查', feedbackAt: '2026-11-01', feedbackSource: '虚构会议纪要' });
    const history = workbench.getHistory(period.id);
    expect(JSON.stringify(history)).toContain('2026-10-30'); expect(JSON.stringify(history)).toContain('资源协调');
    expect(next.feedbackSource).toBe('虚构会议纪要');
    expect(management.listPeriods('2026-11-03')[0].flags).toEqual({ overdue: true, pendingConfirmation: false });
  });

  it('carries an unfinished cross-month week while retaining its original facts and task identity', () => {
    const task = workbench.createTask({ title: '未完成行动' });
    const first = management.createPeriod({ title: '跨月重点', kind: 'week', lineId: line().id, ...range, actual: '只完成一半', taskIds: [task.id] });
    const carried = management.carryPeriod(first.id, { revision: first.revision, start: '2026-11-02', end: '2026-11-08', reason: '下一周期继续' });
    expect(carried).toMatchObject({ taskIds: [task.id], carriedFromId: first.id, actual: '', status: 'planned' });
    expect(management.listPeriods().find(value => value.id === first.id)).toMatchObject({ actual: '只完成一半', status: 'planned' });
    expect(workbench.listTasks()).toHaveLength(1);
    expect(() => management.carryPeriod(first.id, { revision: first.revision, start: '2026-11-09', end: '2026-11-15', reason: '过期' })).toThrow(/更新/);
  });

  it('retains risk-to-issue history and requires independent closure evidence', () => {
    const task = workbench.createTask({ title: '应对行动' });
    const risk = management.createRisk({ title: '外部依赖', taskIds: [task.id] });
    const issue = management.patchRisk(risk.id, { revision: risk.revision, kind: 'issue' });
    workbench.patchTask(task.id, { revision: task.revision, status: 'done' });
    expect(management.listRisks()[0].status).toBe('open');
    expect(() => management.patchRisk(issue.id, { revision: issue.revision, status: 'closed' })).toThrow(/依据/);
    const closed = management.patchRisk(issue.id, { revision: issue.revision, status: 'closed', result: '依赖恢复', evidence: '虚构复测记录' });
    expect(closed.status).toBe('closed'); expect(JSON.stringify(workbench.getHistory(issue.id))).toContain('risk');
  });

  it('creates one durable recurrence task per canonical cycle and keeps different cycles independent', () => {
    const recurrence = management.createRecurrence({ title: '中心周总结', kind: 'week', collectionSource: '同事材料', waitingFor: '材料提供方', waitingWhat: '脱敏阶段材料', followUpDate: '2026-11-06' });
    const first = management.materializeRecurrence({ recurrenceId: recurrence.id, start: '2026-11-02', end: '2026-11-08' });
    const repeat = management.materializeRecurrence({ recurrenceId: recurrence.id, start: '2026-11-02', end: '2026-11-08' });
    expect(first.created).toBe(true); expect(repeat.created).toBe(false); expect(repeat.task.id).toBe(first.task.id);
    expect(first.task).toMatchObject({ category: 'management', status: 'waiting', waitingFor: '材料提供方' });
    management.materializeRecurrence({ recurrenceId: recurrence.id, start: '2026-11-09', end: '2026-11-15' });
    expect(workbench.listTasks()).toHaveLength(2);
    expect(() => management.materializeRecurrence({ recurrenceId: recurrence.id, start: '2026-11-03', end: '2026-11-09' })).toThrow(/周期/);
  });

  it('snapshots and deduplicates facts, excludes cancelled achievements and private management material', () => {
    const task = workbench.createTask({ title: '可核验行动', status: 'done', planDate: '2026-10-30' });
    const cancelled = workbench.createTask({ title: '取消事项', status: 'cancelled' });
    const privateTask = workbench.createTask({ title: '不应泄漏的姓名', type: 'people', category: 'management' });
    const period = management.createPeriod({ title: '重点', kind: 'week', ...range, lineId: line().id, taskIds: [task.id, privateTask.id] });
    const review = management.createReview({ title: '周回顾', format: 'sections', kind: 'week', ...range, selections: { taskIds: [task.id, task.id, cancelled.id, privateTask.id], periodIds: [period.id] } });
    expect(review.facts.filter(fact => fact.id === task.id)).toHaveLength(1);
    expect(JSON.stringify(review)).not.toContain('不应泄漏的姓名');
    expect(review.sections.accomplishments).toContain('可核验行动'); expect(review.sections.accomplishments).not.toContain('取消事项');
    expect(review.sections.accomplishments).toContain('未验证'); expect(review.generator).toBe('local-facts');
    workbench.patchTask(task.id, { revision: task.revision, title: '源已修改' });
    const current = management.listReviews()[0];
    expect(current.facts.find(fact => fact.id === task.id)?.title).toBe('可核验行动');
    expect(current.differences.some(change => change.id === task.id && change.state === 'changed')).toBe(true);
  });

  it('counts completion facts in Shanghai dates rather than treating this-period edits as new accomplishments', () => {
    vi.setSystemTime(new Date('2026-10-20T04:00:00Z'));
    const old = workbench.createTask({ title: '上期已完成', status: 'done' });
    vi.setSystemTime(new Date('2026-10-30T04:00:00Z'));
    workbench.patchTask(old.id, { revision: old.revision, nextAction: '本期补充备注' });
    vi.setSystemTime(new Date('2026-10-25T16:30:00Z')); // Shanghai Monday, UTC Sunday.
    const recent = workbench.createTask({ title: '上海周一完成', status: 'done' });
    vi.setSystemTime(new Date('2026-10-30T04:00:00Z'));
    const review = management.createReview({ title: '事实周期', format: 'sections', kind: 'week', ...range, selections: { taskIds: [old.id, recent.id] } });
    expect(review.sections.accomplishments).not.toContain('上期已完成');
    expect(review.sections.progress).toContain('上期已完成');
    expect(review.sections.accomplishments).toContain('上海周一完成');
  });

  it('keeps external identities, original links and review revisions distinct from personal action completion', () => {
    const task = workbench.createTask({ title: '个人评审行动', status: 'done' });
    const source = { id: randomUUID(), revision: randomUUID(), localTaskId: task.id, provider: 'gitlab', projectId: 'fixture-project', projectName: '虚构项目', externalId: '7', number: '!7', url: 'https://fixture.invalid/project/merge_requests/7', sourceState: 'merged', lastSeenAt: new Date().toISOString(), currentSha: 'new-version', checkedSha: 'old-version', reviewStatus: 'waiting_author' };
    workbench.storage.put('source-record', source);
    const review = management.createReview({ title: '来源追溯', kind: 'week', ...range, selections: { taskIds: [task.id] } });
    expect(review.facts[0].sourceReferences[0]).toMatchObject({ provider: 'gitlab', number: '!7', url: source.url, currentSha: 'new-version', checkedSha: 'old-version', reviewStatus: 'waiting_author' });
    expect(review.facts[0].verification).toContain('交付待核实'); expect(review.facts[0].source).toContain(source.url);
    workbench.storage.put('source-record', { ...source, revision: randomUUID(), currentSha: 'newer-version' }, source.revision);
    expect(management.listReviews()[0].differences[0].state).toBe('changed');
  });

  it('keeps issue identity in review facts without inventing MR review or commit status', () => {
    const task = workbench.createTask({ title: 'Issue 个人行动' });
    workbench.storage.put('source-record', { id: randomUUID(), revision: randomUUID(), localTaskId: task.id, provider: 'gitlab', objectType: 'issue', projectId: '1', projectName: '虚构项目', externalId: '11', number: '1', url: 'https://fixture.invalid/project/issues/1', sourceState: 'opened', lastSeenAt: new Date().toISOString(), currentSha: null, checkedSha: null, reviewStatus: 'not_started' });
    const review = management.createReview({ title: 'Issue 来源追溯', kind: 'week', ...range, selections: { taskIds: [task.id] } });
    expect(review.facts[0].sourceReferences[0]).toMatchObject({ objectType: 'issue', number: '1' });
    expect(review.facts[0].source).toContain('#1');
    expect(review.facts[0].source).not.toContain('评审');
    expect(review.facts[0].source).not.toContain('提交');
  });

  it('rolls back tasks, plans and history together when SQLite rejects a later transaction write', () => {
    const rule = management.createRecurrence({ title: '例行总结', kind: 'week' });
    workbench.storage.database.exec("CREATE TRIGGER fail_recurrence_event BEFORE INSERT ON events WHEN NEW.kind = 'recurrence.updated' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;");
    expect(() => management.materializeRecurrence({ recurrenceId: rule.id, start: '2026-11-02', end: '2026-11-08' })).toThrow(/storage failure/);
    expect(workbench.listTasks()).toEqual([]); expect(management.listRecurrences()[0].occurrences).toEqual([]);
    expect(workbench.getHistory(rule.id)).toHaveLength(1);
    workbench.storage.database.exec('DROP TRIGGER fail_recurrence_event;');
    expect(management.materializeRecurrence({ recurrenceId: rule.id, start: '2026-11-02', end: '2026-11-08' }).created).toBe(true);
    const period = management.createPeriod({ title: '结转重点', kind: 'week', lineId: line().id, ...range });
    workbench.storage.database.exec("CREATE TRIGGER fail_carry_event BEFORE INSERT ON events WHEN NEW.kind = 'period.carried' BEGIN SELECT RAISE(ABORT, 'injected carry failure'); END;");
    expect(() => management.carryPeriod(period.id, { revision: period.revision, start: '2026-11-02', end: '2026-11-08', reason: '继续' })).toThrow(/carry failure/);
    expect(management.listPeriods()).toHaveLength(1); expect(management.listPeriods()[0].revision).toBe(period.revision);
  });

  it('keeps published versions immutable while later drafts and publications create new versions', () => {
    const review = management.createReview({ title: '月回顾', kind: 'month', start: '2026-11-01', end: '2026-11-30' });
    const published = management.publishReview(review.id, { revision: review.revision });
    const original = structuredClone(published.versions[0]);
    const edited = management.patchReview(review.id, { revision: published.revision, sections: { progress: '人工核实后的进展' } });
    expect(edited.status).toBe('draft'); expect(edited.versions[0]).toEqual(original);
    const next = management.publishReview(review.id, { revision: edited.revision });
    expect(next.versions).toHaveLength(2); expect(next.versions[0]).toEqual(original);
    expect(() => management.patchReview(review.id, { revision: published.revision, title: '过期' })).toThrow(/更新/);
    workbench.close(); workbench = new Workbench(dir); management = new Management(workbench);
    expect(management.listReviews()[0].versions[0]).toEqual(original);
  });

  it('excludes personnel ancestry and sensitive associations in period, risk and milestone selections', () => {
    const parent = workbench.createTask({ title: '不能导出的人员事项', type: 'people', category: 'management' });
    const child = workbench.createTask({ title: '不能导出的人员子行动', parentId: parent.id });
    const period = management.createPeriod({ title: '不能导出的关联周期', kind: 'week', lineId: line().id, ...range, taskIds: [child.id] });
    const risk = management.createRisk({ title: '不能导出的关联风险', periodIds: [period.id] });
    const milestone = management.createMilestone({ title: '不能导出的关联节点', riskIds: [risk.id] });
    const review = management.createReview({ title: '脱敏回顾', kind: 'week', ...range, selections: { taskIds: [child.id], periodIds: [period.id], riskIds: [risk.id], milestoneIds: [milestone.id] } });
    expect(review.facts).toEqual([]); expect(review.excludedSensitiveCount).toBe(4);
    expect(JSON.stringify(review)).not.toContain('不能导出'); expect(review.exportBlocked).toBe(false);
  });

  it('blocks ordinary exports and new publications after snapshot facts become sensitive while preserving published history', () => {
    const task = workbench.createTask({ title: '原事实标题不得再次导出', status: 'done' });
    const review = management.createReview({ title: '既有回顾', kind: 'week', ...range, selections: { taskIds: [task.id] } });
    expect(review.exportBlocked).toBe(false);
    const published = management.publishReview(review.id, { revision: review.revision }); const originalVersion = structuredClone(published.versions[0]);
    workbench.patchTask(task.id, { revision: task.revision, type: 'recruitment' });
    const current = management.listReviews()[0];
    expect(current.exportBlocked).toBe(true); expect(current.exportWarning).toMatch(/敏感|人员|招聘/);
    expect(current.markdown).not.toContain(task.title); expect(current.markdown).toMatch(/禁止|不能/);
    expect(current.versions[0]).toEqual(originalVersion);
    const draft = management.patchReview(review.id, { revision: current.revision, sections: { nextPlan: '继续人工核查' } });
    expect(() => management.publishReview(review.id, { revision: draft.revision })).toThrow(/敏感|人员|招聘/);
  });

  it('separates deployment milestones from verified adoption and rejects unsupported effectiveness claims', () => {
    const milestone = management.createMilestone({ title: '环境部署', project: '虚构平台', deliveryResult: '服务已启动', status: 'done' });
    expect(milestone.validation).toBe('unverified'); expect(milestone.adoptionResult).toBe('');
    expect(() => management.patchMilestone(milestone.id, { revision: milestone.revision, validation: 'passed' })).toThrow(/依据/);
  });

  it('serves collection envelopes, durable changes and revision conflicts through real routes', async () => {
    const app = Fastify();
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => { reply.code(error.statusCode ?? 400).send({ error: error.message }); });
    registerManagementRoutes(app, workbench);
    try {
      const created = await app.inject({ method: 'POST', url: '/api/lines', payload: { name: '接口产线' } });
      expect(created.statusCode).toBe(200); const record = created.json();
      expect((await app.inject('/api/lines')).json()).toEqual({ items: [record] });
      expect((await app.inject({ method: 'PATCH', url: `/api/lines/${record.id}`, payload: { revision: record.revision, name: '新名称' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PATCH', url: `/api/lines/${record.id}`, payload: { revision: record.revision, name: '旧输入' } })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
});
