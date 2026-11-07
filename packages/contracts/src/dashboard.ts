import { z } from 'zod';
import { dateOnly, type SourceView, type Task } from './index.js';
import type { SourceObject } from './sources.js';

export const dashboardSettingsId = '116b7367-34ba-4acc-a0d5-1a1eab7e1cb9';
export const dashboardSettingsSchema = z.object({
  id: z.literal(dashboardSettingsId), revision: z.string().uuid(),
  deadlineLeadDays: z.number().int().min(0).max(30).default(1),
  lineUpdateWeekday: z.number().int().min(1).max(7).default(5),
  mrBacklogDays: z.number().int().min(1).max(365).default(2),
  browserNotify: z.boolean().default(false)
}).strict();
export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;
export type Reminder = {
  id: string; targetId: string; types: string[]; level: 'danger' | 'warning' | 'info';
  title: string; detail: string; link: string;
};
export type LineAlert = {
  id: string; kind: 'risk' | 'week'; lineId: string; lineName: string;
  title: string; level: 'high' | 'medium' | 'low'; owner: string; detail: string;
  overdue: boolean; escalated: boolean; targetDate: string | null;
};
export type Dashboard = {
  date: string; week: string; keyTasks: Task[]; keyCandidates: Task[];
  todayTodos: Task[]; inProgress: Task[]; waiting: Task[]; nearDue: Task[]; overdue: Task[];
  inboxCount: number; inboxItems: Task[]; completedToday: Task[];
  mrPendingCount: number; mrOverdueCount: number;
  mrItems: (SourceObject & { stayDays: number; overdue: boolean })[];
  lineAlerts: LineAlert[]; reminders: Reminder[]; settings: DashboardSettings; sources: SourceView[];
};
const reference = z.object({ id: z.string().uuid(), revision: z.string().uuid() }).strict();
export const keySelectionSchema = z.object({ date: dateOnly.optional(), selected: z.array(reference).max(3), current: z.array(reference).max(3) }).strict();
export type KeySelection = z.infer<typeof keySelectionSchema>;
