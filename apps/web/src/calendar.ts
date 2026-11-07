import { priorityOrder, shiftDate, weekRange, type Task } from '../../../packages/contracts/src/index';

export type CalendarView = 'month' | 'week';
export const calendarKinds = ['planDate', 'dueDate', 'followUpDate'] as const;
export type CalendarKind = typeof calendarKinds[number];
export type CalendarEntry = { task: Task; kinds: CalendarKind[] };

export function calendarDays(date: string, view: CalendarView): string[] {
  if (view === 'week') {
    const first = weekRange(date).slice(0, 10);
    return Array.from({ length: 7 }, (_, index) => shiftDate(first, index));
  }
  const first = `${date.slice(0, 7)}-01`;
  const next = new Date(`${first}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = shiftDate(next.toISOString().slice(0, 10), -1);
  const start = weekRange(first).slice(0, 10);
  const end = weekRange(last).slice(-10);
  const days: string[] = [];
  for (let day = start; day <= end; day = shiftDate(day, 1)) days.push(day);
  return days;
}

export function moveCalendarDate(date: string, view: CalendarView, direction: number): string {
  if (view === 'week') return shiftDate(date, direction * 7);
  const target = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  target.setUTCMonth(target.getUTCMonth() + direction);
  const first = target.toISOString().slice(0, 10);
  target.setUTCMonth(target.getUTCMonth() + 1);
  const last = shiftDate(target.toISOString().slice(0, 10), -1);
  const day = Math.min(Number(date.slice(-2)), Number(last.slice(-2)));
  return `${first.slice(0, 7)}-${String(day).padStart(2, '0')}`;
}

export function indexCalendarTasks(tasks: Task[], kinds: readonly CalendarKind[], showEnded = false): Map<string, CalendarEntry[]> {
  const index = new Map<string, CalendarEntry[]>();
  const visible = tasks.filter(task => !task.archived && (showEnded || !['done', 'cancelled'].includes(task.status)));
  visible.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const task of visible) {
    const dates = new Map<string, CalendarKind[]>();
    for (const kind of kinds) {
      const date = task[kind];
      if (date) dates.set(date, [...(dates.get(date) || []), kind]);
    }
    for (const [date, entryKinds] of dates) {
      const entries = index.get(date) || [];
      entries.push({ task, kinds: entryKinds });
      index.set(date, entries);
    }
  }
  return index;
}
