import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateOnly, localDate, shiftDate, weekRange, priorityOrder, type Task, type SourceView } from '@workbench/contracts';
import { dashboardSettingsId, dashboardSettingsSchema, keySelectionSchema, type Dashboard, type DashboardSettings, type Reminder, type LineAlert } from '../../../packages/contracts/src/dashboard.js';
import { lineSchema, periodSchema, riskSchema } from '../../../packages/contracts/src/management.js';
import { isMergeRequest, type SourceObject } from '../../../packages/contracts/src/sources.js';
import { cycleRange, progressState } from '../../../packages/contracts/src/production.js';
import type { Workbench } from './workbench.js';
import { AppError } from './errors.js';
import { isPrivateMaterial } from './material-privacy.js';

const active = (task: Task) => !task.archived && !['done', 'cancelled'].includes(task.status);
const compareDate = (a: string | null, b: string | null) => (a ?? '9999').localeCompare(b ?? '9999');
const dueOrder = (a: Task, b: Task) => compareDate(a.dueDate, b.dueDate) || priorityOrder[a.priority] - priorityOrder[b.priority] || a.order - b.order || a.id.localeCompare(b.id);
const daysBetween = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export class DashboardService {
  constructor(private readonly store: Workbench, private readonly sources: () => SourceView[] = () => []) {
    if (!store.storage.get('dashboard-settings', dashboardSettingsId)) store.storage.put('dashboard-settings', dashboardSettingsSchema.parse({ id: dashboardSettingsId, revision: randomUUID() }));
  }
  settings(): DashboardSettings {
    return dashboardSettingsSchema.parse(this.store.storage.get('dashboard-settings', dashboardSettingsId) ?? { id: dashboardSettingsId, revision: dashboardSettingsId });
  }
  saveSettings(input: unknown): DashboardSettings {
    const parsed = dashboardSettingsSchema.parse(input);
    const value = { ...parsed, revision: randomUUID() };
    // Old backups may omit preferences. A default view still has a stable revision.
    if (!this.store.storage.get('dashboard-settings', dashboardSettingsId)) {
      if (parsed.revision !== dashboardSettingsId) throw new AppError(409, '提醒设置已更新，请重新读取');
      this.store.storage.put('dashboard-settings', value);
    } else this.store.storage.put('dashboard-settings', value, parsed.revision);
    return value;
  }
  selectKeys(input: unknown): Task[] {
    const { selected, current, date } = keySelectionSchema.parse(input);
    return this.store.storage.database.transaction(() => {
      const today = localDate(); const tasks = this.store.listTasks();
      if (date && date !== today) throw new AppError(409, '日期已变化，请刷新今日工作台后重试');
      const previous = tasks.filter(task => active(task) && task.keyDate === today);
      if (new Set(selected.map(item => item.id)).size !== selected.length || new Set(current.map(item => item.id)).size !== current.length) throw new AppError(400, '要事选择包含重复任务');
      if (previous.length !== current.length || previous.some(task => !current.some(item => item.id === task.id && item.revision === task.revision))) throw new AppError(409, '今日要事已更新，请重新读取后选择');
      for (const item of selected) {
        const task = tasks.find(task => task.id === item.id);
        if (!task || task.revision !== item.revision) throw new AppError(409, '任务已被更新，请重新读取后选择');
        if (!active(task) || !['todo', 'doing', 'inbox'].includes(task.status) && !previous.some(old => old.id === task.id)) throw new AppError(400, '只能选择未结束的待办、进行中或收件箱任务');
      }
      for (const task of previous.filter(task => !selected.some(item => item.id === task.id))) this.store.patchTask(task.id, { revision: task.revision, keyDate: null });
      for (const item of selected.filter(item => !previous.some(task => task.id === item.id))) this.store.patchTask(item.id, { revision: item.revision, keyDate: today });
      return this.store.listTasks().filter(task => active(task) && task.keyDate === today);
    })();
  }
  get(now = new Date()): Dashboard {
    return this.store.storage.database.transaction(() => this.aggregate(now))();
  }
  private aggregate(now: Date): Dashboard {
    const date = localDate(now); const week = weekRange(date); const settings = this.settings();
    const tasks = this.store.listTasks(); const ongoing = tasks.filter(active).sort(dueOrder);
    const keyTasks = ongoing.filter(task => task.keyDate === date);
    const keyCandidates = ongoing.filter(task => ['todo', 'doing', 'inbox'].includes(task.status) || task.keyDate === date);
    const start = Date.parse(`${date}T00:00:00+08:00`); const end = start + 86400000;
    const completedToday = tasks.filter(task => !task.archived && task.status === 'done' && task.completedAt && Date.parse(task.completedAt) >= start && Date.parse(task.completedAt) < end).sort((a, b) => b.completedAt!.localeCompare(a.completedAt!) || a.id.localeCompare(b.id));
    const mrItems = this.store.storage.list<SourceObject>('source-record')
      .filter(source => isMergeRequest(source) && source.sourceState === 'opened' && (source.assignedAsReviewer ?? source.assignedToMe) && (source.reviewStatus !== 'reviewed' || source.needsReview))
      .map(source => { const stayDays = Math.max(0, Math.floor((now.valueOf() - Date.parse(source.createdAt)) / 86400000)); return { ...source, stayDays, overdue: stayDays >= settings.mrBacklogDays }; })
      .sort((a, b) => b.stayDays - a.stayDays || a.id.localeCompare(b.id));
    const lines = this.store.storage.list('line').map(line => lineSchema.parse(line)).filter(line => !line.archived);
    const periods = this.store.storage.list('period').map(period => periodSchema.parse(period)).filter(period => !isPrivateMaterial(this.store.storage, 'period', period.id));
    const risks = this.store.storage.list('risk').map(risk => riskSchema.parse(risk)).filter(risk => !isPrivateMaterial(this.store.storage, 'risk', risk.id));
    const [weekStart, weekEnd] = cycleRange('week', date);
    const weekly = periods.filter(period => period.kind === 'week' && !['done', 'cancelled'].includes(period.status) && period.start <= weekEnd && period.end >= weekStart);
    const lineAlerts: LineAlert[] = [];
    for (const line of lines) {
      for (const risk of risks.filter(risk => risk.lineIds.includes(line.id) && risk.status !== 'closed' && (risk.level === 'high' || risk.targetCloseDate && risk.targetCloseDate < date))) {
        lineAlerts.push({ id: `${line.id}:${risk.id}`, kind: 'risk', lineId: line.id, lineName: line.name, title: risk.title, level: risk.level, owner: risk.owner || line.owner, detail: risk.impact || risk.response, overdue: !!risk.targetCloseDate && risk.targetCloseDate < date, escalated: risk.escalated, targetDate: risk.targetCloseDate });
      }
      for (const period of weekly.filter(period => period.lineId === line.id && ['at_risk', 'blocked'].includes(progressState(period)))) {
        lineAlerts.push({ id: `${line.id}:${period.id}`, kind: 'week', lineId: line.id, lineName: line.name, title: period.title, level: progressState(period) === 'blocked' ? 'high' : 'medium', owner: period.owner || line.owner, detail: period.actual || '尚未填写最新进展', overdue: false, escalated: false, targetDate: period.plannedDate });
      }
    }
    const reminderMap = new Map<string, Reminder>(); const severity = { danger: 0, warning: 1, info: 2 };
    const add = (targetId: string, type: string, level: Reminder['level'], title: string, detail: string, link: string) => {
      const id = link; const previous = reminderMap.get(id);
      if (previous) { previous.types.push(type); previous.detail += `；${detail}`; if (severity[level] < severity[previous.level]) previous.level = level; }
      else reminderMap.set(id, { id, targetId, types: [type], level, title, detail, link });
    };
    for (const task of ongoing) {
      const link = `?view=tasks&task=${task.id}`;
      if (['todo', 'doing', 'waiting', 'inbox'].includes(task.status) && task.dueDate) {
        const days = daysBetween(date, task.dueDate);
        if (days < 0) add(task.id, 'task_overdue', 'danger', task.title, `硬截止已逾期 · 截止 ${task.dueDate}，超期 ${-days} 天`, link);
        else if (days <= settings.deadlineLeadDays) add(task.id, 'task_near_due', 'warning', task.title, `截止 ${task.dueDate}，${days === 0 ? '今天到期' : `${days} 天后到期`}`, link);
      }
      if (task.status === 'waiting' && task.followUpDate && task.followUpDate < date) add(task.id, 'waiting_overdue', 'danger', task.title, `等待 ${task.waitingFor} · 预期回复 ${task.followUpDate}，超期 ${daysBetween(task.followUpDate, date)} 天`, link);
      if (task.type === 'recruitment' && task.followUpDate && task.followUpDate >= date && task.followUpDate <= shiftDate(date, 1)) add(task.id, 'interview', 'warning', task.title, `招聘跟进日期 ${task.followUpDate}，请核对面试安排`, link);
    }
    if (!keyTasks.length) add('keys', 'key_empty', 'info', '尚未设置今日要事', '建议每天最多选定 3 件最重要的事', '?view=today');
    for (const mr of mrItems.filter(mr => mr.overdue)) add(mr.id, 'mr_backlog', 'danger', mr.title, `${mr.projectName} · 本地待评审已停留 ${mr.stayDays} 天`, `?view=tasks&tab=mr&source=${mr.id}`);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    for (const line of lines) {
      const link = `?view=manage&line=${line.id}`;
      if (weekday === settings.lineUpdateWeekday) {
        const missing = weekly.filter(period => period.lineId === line.id && !period.actual.trim());
        if (missing.length) add(line.id, 'line_weekly_update', 'danger', `${line.name} · 周重点待更新`, `${missing.length} 项本周重点尚未填写进展说明`, link);
      }
      const [monthStart, monthEnd] = cycleRange('month', date); const nextMonth = shiftDate(monthEnd, 1);
      const months = periods.filter(period => period.kind === 'month' && period.lineId === line.id && period.status !== 'cancelled');
      if (Number(date.slice(-2)) >= 25 && months.some(period => period.start.slice(0, 7) === monthStart.slice(0, 7)) && !months.some(period => period.start.slice(0, 7) === nextMonth.slice(0, 7))) add(line.id, 'line_monthly_init', 'info', `${line.name} · 下月重点待登记`, `请登记 ${nextMonth.slice(0, 7)} 月重点，可在产线详情切换下月并从上月结转`, link);
    }
    return {
      date, week, keyTasks, keyCandidates,
      todayTodos: ongoing.filter(task => task.status === 'todo' && (!task.startDate || task.startDate <= date)),
      inProgress: ongoing.filter(task => task.status === 'doing'),
      waiting: ongoing.filter(task => task.status === 'waiting').sort((a, b) => compareDate(a.followUpDate, b.followUpDate) || dueOrder(a, b)),
      nearDue: ongoing.filter(task => ['todo', 'doing', 'waiting'].includes(task.status) && task.dueDate === date),
      overdue: ongoing.filter(task => ['todo', 'doing', 'waiting'].includes(task.status) && task.dueDate && task.dueDate < date),
      inboxCount: ongoing.filter(task => task.status === 'inbox').length, inboxItems: ongoing.filter(task => task.status === 'inbox'), completedToday,
      mrPendingCount: mrItems.length, mrOverdueCount: mrItems.filter(mr => mr.overdue).length, mrItems: mrItems.slice(0, 10),
      lineAlerts, reminders: [...reminderMap.values()].sort((a, b) => severity[a.level] - severity[b.level] || a.id.localeCompare(b.id)), settings, sources: this.sources()
    };
  }
}

export function registerDashboardRoutes(app: FastifyInstance, store: Workbench, sources: () => SourceView[]): void {
  const service = new DashboardService(store, sources);
  app.get('/api/dashboard', () => service.get());
  app.get('/api/reminders', () => { const dashboard = service.get(); return { items: dashboard.reminders, browserNotify: dashboard.settings.browserNotify }; });
  app.get('/api/dashboard/settings', () => service.settings());
  app.put('/api/dashboard/settings', request => service.saveSettings(request.body));
  app.put('/api/dashboard/key-tasks', request => ({ items: service.selectKeys(request.body) }));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/key', request => {
    const input = z.object({ revision: z.string().uuid(), isKey: z.boolean(), date: dateOnly.optional() }).strict().parse(request.body);
    if (input.date && input.date !== localDate()) throw new AppError(409, '日期已变化，请刷新今日工作台后重试');
    const task = store.listTasks().find(task => task.id === request.params.id);
    if (!task) throw new AppError(404, '任务不存在');
    if (input.isKey && (!active(task) || !['inbox', 'todo', 'doing', 'waiting'].includes(task.status))) throw new AppError(400, '该任务不能设为今日要事');
    return store.patchTask(task.id, { revision: input.revision, keyDate: input.isKey ? localDate() : null });
  });
}
