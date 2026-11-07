import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { taskFields, type Task, type TaskInput } from '../packages/contracts/src/index';
import { calendarDays, calendarKinds, indexCalendarTasks, moveCalendarDate } from '../apps/web/src/calendar';

const task = (fields: TaskInput): Task => ({
  ...taskFields.parse(fields), id: randomUUID(), revision: randomUUID(),
  createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z', sourceState: null, completedAt: null,
});

describe('calendar dates', () => {
  it('uses full Monday-to-Sunday month rows including the leap day', () => {
    const days = calendarDays('2024-02-15', 'month');
    expect(days[0]).toBe('2024-01-29');
    expect(days.at(-1)).toBe('2024-03-03');
    expect(days).toContain('2024-02-29');
    expect(days).toHaveLength(35);
    expect(new Set(days).size).toBe(days.length);
  });

  it('includes six rows when a month needs them and four when sufficient', () => {
    expect(calendarDays('2026-11-07', 'month')).toHaveLength(42);
    expect(calendarDays('2021-02-01', 'month')).toHaveLength(28);
  });

  it('keeps Monday weeks across years and treats Sunday as the last day', () => {
    const days = calendarDays('2027-01-03', 'week');
    expect(days).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    expect(calendarDays('2026-12-28', 'week')).toEqual(days);
  });

  it.each([
    ['2026-12-31', 1, '2027-01-31'],
    ['2027-01-31', 1, '2027-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2027-01-31', -1, '2026-12-31'],
  ])('moves %s by %s month and clamps to %s', (date, direction, expected) => {
    expect(moveCalendarDate(date, 'month', direction)).toBe(expected);
  });

  it('moves complete weeks across month boundaries', () => {
    expect(moveCalendarDate('2027-02-28', 'week', 1)).toBe('2027-03-07');
    expect(moveCalendarDate('2027-01-03', 'week', -1)).toBe('2026-12-27');
  });
});

describe('calendar task indexing', () => {
  it('merges same-day kinds but retains separate days and both task categories', () => {
    const management = task({ title: '管理任务', category: 'management', planDate: '2026-11-07', dueDate: '2026-11-07', followUpDate: '2026-11-09' });
    const personal = task({ title: '个人任务', planDate: '2026-11-07' });
    const index = indexCalendarTasks([management, personal], calendarKinds);
    expect(index.get('2026-11-07')).toHaveLength(2);
    expect(index.get('2026-11-07')?.find(entry => entry.task.id === management.id)?.kinds).toEqual(['planDate', 'dueDate']);
    expect(index.get('2026-11-09')).toEqual([{ task: management, kinds: ['followUpDate'] }]);
  });

  it('excludes archived and undated tasks, showing ended tasks only on request', () => {
    const tasks = [
      task({ title: '进行中', status: 'doing', planDate: '2026-11-07' }),
      task({ title: '已完成', status: 'done', planDate: '2026-11-07' }),
      task({ title: '已取消', status: 'cancelled', planDate: '2026-11-07' }),
      task({ title: '已归档', archived: true, archiveReason: '合成归档', planDate: '2026-11-07' }),
      task({ title: '没有日期' }),
    ];
    expect(indexCalendarTasks(tasks, calendarKinds).get('2026-11-07')?.map(entry => entry.task.title)).toEqual(['进行中']);
    expect(indexCalendarTasks(tasks, calendarKinds, true).get('2026-11-07')).toHaveLength(3);
  });

  it('filters individual date kinds without changing original task data', () => {
    const original = task({ title: '日期筛选', planDate: '2026-11-07', dueDate: '2026-11-07', followUpDate: '2026-11-08' });
    const before = JSON.stringify(original);
    const index = indexCalendarTasks([original], ['dueDate']);
    expect(index.get('2026-11-07')?.[0].kinds).toEqual(['dueDate']);
    expect(index.has('2026-11-08')).toBe(false);
    expect(indexCalendarTasks([original], [])).toHaveProperty('size', 0);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps high-priority tasks first and preserves personal order within a priority', () => {
    const tasks = [
      task({ title: '低优先', priority: 'low', order: 0, planDate: '2026-11-07' }),
      task({ title: '高优先后', priority: 'high', order: 2, planDate: '2026-11-07' }),
      task({ title: '高优先前', priority: 'high', order: 1, planDate: '2026-11-07' }),
    ];
    expect(indexCalendarTasks(tasks, calendarKinds).get('2026-11-07')?.map(entry => entry.task.title)).toEqual(['高优先前', '高优先后', '低优先']);
    expect(tasks[0].title).toBe('低优先');
  });
});
