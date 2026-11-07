import { z } from 'zod';
const id = z.string().uuid();
export const executionInputSchema = z.object({
  title: z.string().trim().min(1).max(300), modelId: id, instruction: z.string().trim().min(1).max(20000),
  taskIds: z.array(id).max(200).default([]), sourceRecordIds: z.array(id).max(200).default([]), periodIds: z.array(id).max(200).default([]), riskIds: z.array(id).max(200).default([]),
  allowedTools: z.array(z.enum(['read_records', 'save_markdown', 'submit_writeback', 'verify_writeback'])).min(1).max(4),
  writebackIds: z.array(id).max(20).default([]), maxSteps: z.number().int().min(1).max(30).default(8),
  dataClass: z.enum(['public', 'deidentified', 'internal']).default('internal')
}).strict();
export type ExecutionInput = z.input<typeof executionInputSchema>;
export const executionSchema = executionInputSchema.extend({
  id, revision: id, createdAt: z.string().datetime(), updatedAt: z.string().datetime(), modelConfigurationRevision: z.string(),
  materialRevisions: z.record(z.string(), z.string()).default({}),
  status: z.enum(['awaiting_authorization', 'running', 'paused', 'completed', 'failed', 'partial', 'cancelled', 'pending_verification']),
  statusNote: z.string(), plan: z.array(z.string()),
  steps: z.array(z.object({ id, tool: z.string(), at: z.string().datetime(), status: z.enum(['started', 'completed', 'failed', 'uncertain']), result: z.string() })),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number(), verifiedAt: z.string().datetime() })),
  verification: z.string(), finalText: z.string(), calls: z.number().int(), tokens: z.number().int(), tokenUsageKnown: z.boolean(), outputDir: z.string()
});
export type Execution = z.infer<typeof executionSchema>;
