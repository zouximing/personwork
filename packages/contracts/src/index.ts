import { z } from 'zod';
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, '日期无效');
export const statuses = ['inbox', 'todo', 'doing', 'waiting', 'blocked', 'done', 'cancelled'] as const;
export const statusLabels: Record<typeof statuses[number], string> = {
  inbox: '收件箱', todo: '待处理', doing: '进行中', waiting: '等待反馈', blocked: '阻塞', done: '已完成', cancelled: '已取消'
};
export const priorities = ['high', 'medium', 'low'] as const;
export const priorityLabels: Record<typeof priorities[number], string> = { high: '高', medium: '中', low: '低' };
export const priorityOrder: Record<typeof priorities[number], number> = { high: 0, medium: 1, low: 2 };
const text = z.string().max(20000);
export const taskFields = z.object({
  title: z.string().trim().min(1, '请输入标题').max(300),
  category: z.enum(['personal', 'management']).default('personal'), status: z.enum(statuses).default('inbox'),
  priority: z.enum(priorities).default('medium'),
  type: z.enum(['task', 'bug', 'feature', 'platform', 'coordination', 'people', 'recruitment', 'summary']).default('task'),
  project: z.string().max(200).default(''), expectedResult: text.default(''), nextAction: text.default(''), notes: text.default(''),
  planDate: dateOnly.nullable().default(null), dueDate: dateOnly.nullable().default(null),
  startDate: dateOnly.nullable().default(null), keyDate: dateOnly.nullable().default(null),
  followUpDate: dateOnly.nullable().default(null), waitingFor: z.string().max(300).default(''), waitingWhat: text.default(''),
  blockedReason: text.default(''), focus: z.boolean().default(false), order: z.number().finite().default(0),
  parentId: z.string().uuid().nullable().default(null),
  validation: z.enum(['unverified', 'passed', 'failed', 'pending']).default('unverified'), validationNote: text.default(''),
  delivery: z.enum(['not_delivered', 'pending', 'delivered']).default('not_delivered'), deliveryNote: text.default(''),
  archived: z.boolean().default(false), archiveReason: text.default(''), sensitive: z.boolean().default(false)
}).strict();
const metadata = z.object({ id: z.string().uuid(), revision: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
// Context restrictions are server-owned and cannot be cleared through task PATCH.
export const taskSchema = taskFields.extend({ ...metadata.shape, completedAt: z.string().datetime().nullable().default(null), sourceState: z.string().nullable().default(null), privacyRestricted: z.boolean().optional(), internalContext: z.boolean().optional() });
export const deleteTaskSchema = z.object({ revision: z.string().uuid(), confirm: z.literal(true) }).strict();
export type TaskDelete = z.infer<typeof deleteTaskSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = z.input<typeof taskFields>;
export type TaskPatch = Partial<z.infer<typeof taskFields>> & { revision: string; dateChangeReason?: string };
// Zod defaults belong to creation only; partial updates must not materialize them.
export const patchTaskSchema: z.ZodType<TaskPatch> = z.object(Object.fromEntries(Object.entries(taskFields.shape).map(([key, schema]) => [key, schema instanceof z.ZodDefault ? schema.removeDefault().optional() : schema.optional()]))).extend({ revision: z.string().uuid(), dateChangeReason: text.optional() }).strict() as unknown as z.ZodType<TaskPatch>;
export const promptInputSchema = z.object({
  id: z.string().uuid().optional(), revision: z.string().uuid().optional(),
  title: z.string().trim().min(1, '请输入标题').max(300), body: z.string().min(1, '请输入正文').max(200000).refine(v => v.trim().length > 0, '请输入正文'),
  tag: z.string().max(100).default('')
}).strict();
export const promptSchema = metadata.extend({ title: z.string().min(1).max(300), body: z.string().min(1).max(200000), tag: z.string().max(100) });
export type Prompt = z.infer<typeof promptSchema>;
export type PromptInput = z.input<typeof promptInputSchema>;
export const providerSchema = z.enum(['pingcode', 'gitlab']);
export type Provider = z.infer<typeof providerSchema>;
export const sourceFields = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().max(1000).refine(value => {
    if (!value) return true;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  }, '地址应为 HTTP(S)，不能包含凭据、查询参数或片段'),
  projectScope: z.string().max(2000), identity: z.string().max(200), historyDays: z.number().int().min(1).max(3650),
  enabled: z.boolean(), intervalMinutes: z.number().int().min(5).max(1440), scheduleEnabled: z.boolean()
}).strict();
export const sourceSchema = sourceFields.extend({
  ...metadata.shape, provider: providerSchema, instanceId: z.string().uuid(), credentialRef: z.string().uuid().nullable(),
  connectionStatus: z.literal('not_tested'), writeStatus: z.literal('not_verified'),
  lastAttemptAt: z.string().datetime().nullable().optional(), lastSuccessAt: z.string().datetime().nullable().optional(),
  lastError: z.string().optional(), syncStatus: z.enum(['never', 'success', 'partial', 'failed']).optional()
});
export const sourceUpdateSchema = sourceFields.extend({
  revision: z.string().uuid(), credentialAction: z.enum(['keep', 'replace', 'clear']), credential: z.string().max(10000).optional()
}).strict();
export type SourceRecord = z.infer<typeof sourceSchema>;
export type SourceView = Omit<SourceRecord, 'credentialRef'> & { hasCredential: boolean; syncImplemented: boolean };
export type SourceUpdate = z.infer<typeof sourceUpdateSchema>;
export const eventSchema = z.object({ id: z.string().uuid(), resourceId: z.string().uuid(), kind: z.string().max(100), at: z.string().datetime(), details: z.record(z.string(), z.unknown()) });
export type RecordEvent = z.infer<typeof eventSchema>;
export const snapshotSchema = z.object({
  format: z.literal(1), createdAt: z.string().datetime(), timezone: z.literal('Asia/Shanghai'),
  tasks: z.array(taskSchema).max(100000), prompts: z.array(promptSchema).max(20000),
  sources: z.array(sourceSchema.omit({ credentialRef: true })).max(2), events: z.array(eventSchema).max(500000),
  documents: z.array(z.object({ kind: z.enum(['source-record', 'writeback', 'line', 'period', 'risk', 'review', 'recurrence', 'milestone', 'model', 'execution', 'dashboard-settings']), data: z.object({ id: z.string().uuid(), revision: z.string().uuid() }).passthrough() })).max(100000).default([])
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export function localDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
export function weekRange(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); const start = shiftDate(date, -(day || 7) + 1);
  return `${start} — ${shiftDate(start, 6)}`;
}
