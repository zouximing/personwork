import { shiftDate, weekRange } from './index.js';
import type { Line, Period, Risk } from './management.js';
import { z } from 'zod';

export const progressLabels = { normal: '正常', at_risk: '有风险', blocked: '受阻', done: '已完成' } as const;
export const riskLevelLabels = { high: '高', medium: '中', low: '低' } as const;
export function cycleRange(kind: 'week' | 'month', date: string): [string, string] {
  if (kind === 'week') return weekRange(date).split(' — ') as [string, string];
  const start = `${date.slice(0, 7)}-01`;
  const end = new Date(`${start}T12:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1);
  return [start, shiftDate(end.toISOString().slice(0, 10), -1)];
}
export function progressState(period: Pick<Period, 'status'> & Partial<Pick<Period, 'progressStatus'>>): keyof typeof progressLabels {
  if (period.status === 'done') return 'done';
  if (period.status === 'blocked') return 'blocked';
  return period.progressStatus ?? (period.status === 'waiting' ? 'at_risk' : 'normal');
}
export function monthCompletion(periods: Pick<Period, 'status'>[]): { total: number; done: number; rate: number | null } {
  const valid = periods.filter(p => p.status !== 'cancelled'); const done = valid.filter(p => p.status === 'done').length;
  return { total: valid.length, done, rate: valid.length ? Math.round(done / valid.length * 100) : null };
}
export function riskWarning(risk: Pick<Risk, 'status'> & Partial<Pick<Risk, 'level' | 'targetCloseDate'>>, today: string): boolean {
  return risk.status !== 'closed' && (risk.level === 'high' || !!risk.targetCloseDate && risk.targetCloseDate < today);
}
export function periodsInCycle(periods: Period[], lineId: string, kind: 'week' | 'month', date: string): Period[] {
  const [start, end] = cycleRange(kind, date);
  return periods.filter(p => p.lineId === lineId && p.kind === kind && (kind === 'month' ? p.start.slice(0, 7) === start.slice(0, 7) : p.start <= end && p.end >= start));
}
export function lineOverview(line: Line, periods: Period[], risks: Risk[], today: string) {
  const [weekStart, weekEnd] = cycleRange('week', today);
  const monthPeriods = periodsInCycle(periods, line.id, 'month', today);
  const weekPeriods = periodsInCycle(periods, line.id, 'week', today);
  const previousWeek = periodsInCycle(periods, line.id, 'week', shiftDate(weekStart, -7));
  const active = weekPeriods.filter(p => p.status !== 'cancelled');
  const weekly = { normal: 0, at_risk: 0, blocked: 0, done: 0 };
  for (const p of active) weekly[progressState(p)]++;
  const open = risks.filter(r => r.lineIds.includes(line.id) && r.status !== 'closed');
  const openRisks = { high: 0, medium: 0, low: 0 };
  for (const risk of open) openRisks[risk.level ?? 'medium']++;
  const reminderDate = shiftDate(weekStart, (line.reminderWeekday ?? 5) - 1);
  const reminders: ('weekly-update' | 'initialize-week' | 'initialize-month')[] = [];
  if (!weekPeriods.length) reminders.push('initialize-week');
  if (!monthPeriods.length) reminders.push('initialize-month');
  // Shanghai day boundary, independent of the host operating system timezone.
  if (today >= reminderDate && (!weekPeriods.length || active.some(p => new Date(p.updatedAt) < new Date(`${reminderDate}T00:00:00+08:00`)))) reminders.push('weekly-update');
  return {
    id: line.id, name: line.name, owner: line.owner, weekStart, weekEnd,
    monthly: monthCompletion(monthPeriods), monthlyItems: monthPeriods, weekly, weeklyItems: weekPeriods,
    openRisks, warningRiskIds: open.filter(r => riskWarning(r, today)).map(r => r.id), reminders,
    previousWeek,
    leftovers: previousWeek.filter(p => !['done', 'cancelled'].includes(p.status)).map(p => ({ ...p, carriedToCurrent: weekPeriods.some(current => current.carriedFromId === p.id) }))
  };
}
export type LineOverview = ReturnType<typeof lineOverview>;
export const monthSummarySchema = z.object({
  lineId: z.string().uuid(), lineName: z.string().trim().min(1).max(300), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  total: z.number().int().nonnegative(), done: z.number().int().nonnegative(), rate: z.number().int().min(0).max(100).nullable(),
  historyComplete: z.boolean(), capturedAt: z.string().datetime()
}).strict().refine(value => value.done <= value.total && value.rate === (value.total ? Math.round(value.done / value.total * 100) : null), '月末汇总统计不一致');
export type MonthSummary = z.infer<typeof monthSummarySchema>;
