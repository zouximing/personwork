import { z } from 'zod';
import { sourceObjectTypes } from './sources.js';
import { shiftDate, weekRange } from './index.js';
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, '日期无效');

const id = z.string().uuid();
const text = z.string().max(20000);
const title = z.string().trim().min(1).max(300);
const ids = z.array(id).max(10000).transform(values => [...new Set(values)]);
const metadata = z.object({ id, revision: id, createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
// Creation defaults must never be applied to omitted PATCH fields.
function optionalFields<S extends Record<string, z.ZodType>>(schema: z.ZodObject<S>): { [K in keyof S]: z.ZodOptional<z.ZodType<z.output<S[K]>>> } {
  return Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => {
    const inner = (value instanceof z.ZodDefault ? value.removeDefault() : value) as z.ZodType;
    return [key, inner.optional()];
  })) as { [K in keyof S]: z.ZodOptional<z.ZodType<z.output<S[K]>>> };
}
const feedbackDate = z.union([dateOnly, z.string().datetime()]).nullable();
export const lineFields = z.object({ name: title, owner: z.string().max(300).default(''), description: text.default(''), archived: z.boolean().default(false), reminderWeekday: z.number().int().min(1).max(7).default(5) }).strict();
export const lineSchema = lineFields.extend(metadata.shape);
export const linePatchSchema = z.object({ ...optionalFields(lineFields), revision: id }).strict();
export type Line = z.infer<typeof lineSchema>;

export const periodFields = z.object({
  title, kind: z.enum(['week', 'month']), lineId: id, start: dateOnly, end: dateOnly,
  expectedResult: text.default(''), owner: z.string().max(300).default(''), plannedDate: dateOnly.nullable().default(null),
  actual: text.default(''), feedbackAt: feedbackDate.default(null), feedbackSource: text.default(''),
  monthlyId: id.nullable().default(null), taskIds: ids.default([]),
  status: z.enum(['planned', 'doing', 'waiting', 'blocked', 'done', 'cancelled']).default('planned'),
  progressStatus: z.enum(['normal', 'at_risk', 'blocked', 'done']).nullable().default(null),
  completion: z.number().int().min(0).max(100).default(0), notes: text.default(''),
  nextAction: text.default(''), followUpDate: dateOnly.nullable().default(null), changeReason: text.default('')
}).strict();
export const periodSchema = periodFields.extend({ ...metadata.shape, privacyRestricted: z.boolean().optional(), carriedFromId: id.nullable().default(null), carriedToIds: ids.default([]) });
export const periodPatchSchema = z.object({ ...optionalFields(periodFields), revision: id }).strict();
export const carryPeriodSchema = z.object({ revision: id, start: dateOnly, end: dateOnly, reason: z.string().trim().min(1).max(20000), monthlyId: id.nullable().optional() }).strict();
export const carryPreviousSchema = z.object({ lineId: id, kind: z.enum(['week', 'month']), start: dateOnly, end: dateOnly, reason: z.string().trim().min(1).max(20000) }).strict();
export const productionQuerySchema = z.object({ date: dateOnly.optional() }).strict();
export type Period = z.infer<typeof periodSchema>;
export type PeriodView = Period & { flags: { overdue: boolean; pendingConfirmation: boolean } };

export const riskFields = z.object({
  title, kind: z.enum(['risk', 'issue']).default('risk'), status: z.enum(['open', 'watching', 'closed']).default('open'),
  lineIds: ids.default([]), periodIds: ids.default([]), taskIds: ids.default([]), owner: z.string().max(300).default(''),
  impact: text.default(''), response: text.default(''), nextCheckDate: dateOnly.nullable().default(null),
  level: z.enum(['high', 'medium', 'low']).default('medium'), targetCloseDate: dateOnly.nullable().default(null), escalated: z.boolean().default(false),
  result: text.default(''), evidence: text.default(''), sensitive: z.boolean().default(false)
}).strict();
export const riskSchema = riskFields.extend({ ...metadata.shape, privacyRestricted: z.boolean().optional() });
export const riskPatchSchema = z.object({ ...optionalFields(riskFields), revision: id }).strict();
export type Risk = z.infer<typeof riskSchema>;

export const milestoneFields = z.object({
  title, project: z.string().max(300).default(''), expectedResult: text.default(''), nextAction: text.default(''),
  taskIds: ids.default([]), riskIds: ids.default([]), status: z.enum(['planned', 'doing', 'done', 'cancelled']).default('planned'),
  plannedDate: dateOnly.nullable().default(null), deliveryResult: text.default(''), adoptionResult: text.default(''),
  validation: z.enum(['unverified', 'pending', 'passed', 'failed']).default('unverified'), validationNote: text.default('')
}).strict();
export const milestoneSchema = milestoneFields.extend({ ...metadata.shape, privacyRestricted: z.boolean().optional() });
export const milestonePatchSchema = z.object({ ...optionalFields(milestoneFields), revision: id }).strict();
export type Milestone = z.infer<typeof milestoneSchema>;

export const recurrenceFields = z.object({
  title, kind: z.enum(['week', 'month']), expectedResult: text.default(''), collectionSource: text.default(''),
  waitingFor: z.string().max(300).default(''), waitingWhat: text.default(''), followUpDate: dateOnly.nullable().default(null), enabled: z.boolean().default(true)
}).strict();
export const recurrenceSchema = recurrenceFields.extend({ ...metadata.shape, occurrences: z.array(z.object({ start: dateOnly, end: dateOnly, taskId: id })).default([]) });
export const recurrencePatchSchema = z.object({ ...optionalFields(recurrenceFields), revision: id }).strict();
export const materializeSchema = z.object({ recurrenceId: id, start: dateOnly, end: dateOnly }).strict();
export type Recurrence = z.infer<typeof recurrenceSchema>;

export const reviewSelectionsSchema = z.object({ taskIds: ids.default([]), periodIds: ids.default([]), riskIds: ids.default([]), milestoneIds: ids.default([]) }).strict();
export const reviewSectionsSchema = z.object({ accomplishments: text.default(''), progress: text.default(''), deviations: text.default(''), risks: text.default(''), nextPlan: text.default(''), support: text.default('') }).strict();
export const reviewRangeSchema = z.object({ kind: z.enum(['week', 'month']), start: dateOnly, end: dateOnly, purpose: z.enum(['review', 'plan']).default('review') }).strict();
export function nextWeekRange(end: string): { start: string; end: string } {
  const start = shiftDate(weekRange(dateOnly.parse(end)).slice(0, 10), 7);
  return { start, end: shiftDate(start, 6) };
}
const reviewPlanFields = { includeNextWeekPlan: z.boolean().default(false), nextWeekTaskIds: ids.default([]) };
const reportBody = z.string().max(200000);
const reviewFormat = z.enum(['brief', 'sections']);
export const factSourceReferenceSchema = z.object({ id, revision: id, provider: z.enum(['pingcode', 'gitlab']), objectType: z.enum(sourceObjectTypes).optional(), projectId: z.string(), projectName: z.string(), externalId: z.string(), number: z.string(), url: z.string(), sourceState: z.string(), lastSeenAt: z.string(), currentSha: z.string().nullable(), checkedSha: z.string().nullable(), reviewStatus: z.string() }).strict();
export const factSnapshotSchema = z.object({
  id, kind: z.enum(['task', 'period', 'risk', 'milestone']), revision: id, title, status: z.string(),
  actual: text, expectedResult: text, nextAction: text, verification: text, source: text, reason: z.string().max(21000).default(''),
  capturedAt: z.string().datetime(), updatedAt: z.string().datetime(), inRange: z.boolean(), completedInRange: z.boolean().default(false), sensitive: z.literal(false), sourceReferences: z.array(factSourceReferenceSchema).default([])
}).strict();
export const publishedReviewSchema = z.object({
  version: z.number().int().positive(), publishedAt: z.string().datetime(), title, kind: z.enum(['week', 'month']),
  start: dateOnly, end: dateOnly, ...reviewPlanFields, format: reviewFormat.default('sections'), reportBody: reportBody.default(''), sections: reviewSectionsSchema, facts: z.array(factSnapshotSchema), markdown: z.string().max(2000000)
}).strict();
export const reviewFields = z.object({ title, kind: z.enum(['week', 'month']), start: dateOnly, end: dateOnly, ...reviewPlanFields, format: reviewFormat.default('brief'), selections: reviewSelectionsSchema.default({ taskIds: [], periodIds: [], riskIds: [], milestoneIds: [] }) }).strict();
export const aiReviewDraftSchema = metadata.extend({ modelId: id, configurationRevision: id, text: z.string().max(200000), factIds: z.array(z.string().max(100)).max(10000), status: z.literal('draft'), requiresReview: z.literal(true) });
export const reviewSchema = reviewFields.extend({
  ...metadata.shape, privacyRestricted: z.boolean().optional(), format: reviewFormat.default('sections'), reportBody: reportBody.default(''), sections: reviewSectionsSchema, facts: z.array(factSnapshotSchema), versions: z.array(publishedReviewSchema),
  status: z.enum(['draft', 'published']), generator: z.literal('local-facts'), excludedSensitiveCount: z.number().int().nonnegative(), aiDrafts: z.array(aiReviewDraftSchema).default([])
});
export const reviewPatchSchema = z.object({ revision: id, title: title.optional(), reportBody: reportBody.optional(), sections: z.object(optionalFields(reviewSectionsSchema)).strict().optional() }).strict();
export const publishReviewInputSchema = z.object({ revision: id }).strict();
export const deleteReviewInputSchema = z.object({ revision: id, confirm: z.literal(true) }).strict();
export type ReviewSelections = z.infer<typeof reviewSelectionsSchema>;
export type ReviewSections = z.infer<typeof reviewSectionsSchema>;
export type FactSnapshot = z.infer<typeof factSnapshotSchema>;
export type PublishedReview = z.infer<typeof publishedReviewSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ReviewView = Review & { differences: { id: string; kind: FactSnapshot['kind']; state: 'unchanged' | 'changed' | 'missing' }[]; markdown: string; exportBlocked: boolean; exportWarning: string };
