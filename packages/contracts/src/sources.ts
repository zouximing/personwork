import { z } from 'zod';

const metadata = { id: z.string().uuid(), revision: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() };
export const sourceObjectTypes = ['work_item', 'issue', 'merge_request'] as const;
export type SourceObjectType = typeof sourceObjectTypes[number];
export const reviewStatuses = ['not_started', 'reviewing', 'waiting_author', 'reviewed', 'follow_up'] as const;
export const sourceObjectSchema = z.object({
  ...metadata, privacyRestricted: z.boolean().optional(), provider: z.enum(['pingcode', 'gitlab']), instanceId: z.string().uuid(), projectId: z.string().min(1), projectName: z.string(),
  objectType: z.enum(sourceObjectTypes).optional(), assignedAsAssignee: z.boolean().optional(), assignedAsReviewer: z.boolean().optional(),
  externalId: z.string().min(1), number: z.string(), title: z.string(), url: z.string(), sourceState: z.string(), sourceStateId: z.string(),
  sourceDueDate: z.string().nullable(), sourcePriority: z.string(), author: z.string(), assigneeId: z.string(),
  currentSha: z.string().nullable(), checkedSha: z.string().nullable(), reviewStatus: z.enum(reviewStatuses), conclusion: z.string(),
  followUpDate: z.string().nullable(), needsReview: z.boolean(), reviewAssignmentChanged: z.boolean(), assignedToMe: z.boolean(),
  attentionReason: z.string(), localTaskId: z.string().uuid().nullable(), lastSeenAt: z.string().datetime(),
  sourceUpdatedAt: z.string().nullable(), linkedSourceIds: z.array(z.string().uuid()).default([]),
  autoCreatedTaskId: z.string().uuid().nullable().default(null), autoCreatedTaskRevision: z.string().uuid().nullable().default(null)
});
export type SourceObject = z.infer<typeof sourceObjectSchema>;
// Records written before typed GitLab objects contain only MR snapshots. Keep their IDs and bindings.
export function sourceObjectType(source: Pick<SourceObject, 'provider' | 'objectType'>): SourceObjectType {
  return source.objectType ?? (source.provider === 'gitlab' ? 'merge_request' : 'work_item');
}
export function isMergeRequest(source: Pick<SourceObject, 'provider' | 'objectType'>): boolean {
  return source.provider === 'gitlab' && sourceObjectType(source) === 'merge_request';
}
export function sourceNumber(source: Pick<SourceObject, 'provider' | 'objectType' | 'number'>): string {
  return source.provider !== 'gitlab' || /^[#!]/.test(source.number) ? source.number : `${isMergeRequest(source) ? '!' : '#'}${source.number}`;
}
export function sourceAssignmentLabel(source: SourceObject): string {
  const reviewer = source.assignedAsReviewer ?? (isMergeRequest(source) && source.assignedToMe);
  const assignee = source.assignedAsAssignee ?? (!isMergeRequest(source) && source.assignedToMe);
  return [assignee && '指派给我', reviewer && '由我评审'].filter(Boolean).join(' · ');
}
export const writebackInputSchema = z.object({
  sourceRecordId: z.string().uuid(), field: z.enum(['state', 'comment']), value: z.string().trim().min(1).max(20000),
  expectedValue: z.string().max(1000).optional(), requestId: z.string().uuid()
}).strict();
export type WritebackInput = z.infer<typeof writebackInputSchema>;
export const writebackSchema = z.object({
  ...metadata, sourceRecordId: z.string().uuid(), provider: z.literal('pingcode'), instanceId: z.string().uuid(),
  baseUrl: z.string(), configurationRevision: z.string().uuid(), projectId: z.string(), externalId: z.string(),
  targetTitle: z.string(), targetNumber: z.string(), targetUrl: z.string(), field: z.enum(['state', 'comment']), value: z.string(),
  expectedValue: z.string().nullable(), requestId: z.string().uuid(), outboundValue: z.string(),
  status: z.enum(['preview', 'submitting', 'uncertain', 'confirmed', 'conflict', 'blocked', 'failed']), statusNote: z.string(),
  receiptId: z.string().nullable(), submittedAt: z.string().nullable(), verifiedAt: z.string().nullable()
});
export type Writeback = z.infer<typeof writebackSchema>;
export type SourceSyncResult = { status: 'success' | 'partial' | 'failed' | 'skipped'; count: number; message: string; lastSuccessAt: string | null };
export type SourceTestResult = {
  status: 'read_ok' | 'failed'; identity: string | null; message: string; writeStatus: 'not_verified';
  testedConfiguration: { provider: 'pingcode' | 'gitlab'; baseUrl: string; projectScope: string; identity: string; historyDays: number };
};
