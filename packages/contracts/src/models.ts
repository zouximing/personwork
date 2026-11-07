import { z } from 'zod';

export const modelFields = z.object({
  name: z.string().trim().min(1).max(200), kind: z.enum(['local', 'deepseek', 'newapi']),
  baseUrl: z.string().url().max(1000).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, '模型地址必须是无凭据和查询参数的 HTTP(S) 地址'),
  protocol: z.enum(['openai', 'ollama']).default('openai'), model: z.string().trim().min(1).max(300),
  upstream: z.string().max(1000).default(''), upstreamLocation: z.enum(['internal', 'external', 'unknown']).default('unknown'),
  allowInternal: z.boolean().default(false), timeoutSeconds: z.number().int().min(1).max(300).default(30),
  maxCalls: z.number().int().min(1).max(100).default(8), maxTokens: z.number().int().min(1).max(100000).default(2048),
  isDefault: z.boolean().default(false), enabled: z.boolean().default(true)
}).strict();
export const modelInputSchema = modelFields.extend({ id: z.string().uuid().optional(), revision: z.string().uuid().optional(), credentialAction: z.enum(['keep', 'replace', 'clear']).default('keep'), credential: z.string().max(10000).optional() }).strict();
export const modelCapabilitySchema = z.object({
  text: z.enum(['untested', 'passed', 'failed']), tools: z.enum(['untested', 'passed', 'failed']),
  testedAt: z.string().datetime().nullable().default(null), configurationRevision: z.string().uuid().nullable().default(null), message: z.string().max(3000).default('恢复或配置变化后需重新测试'),
  lastErrorKind: z.string().nullable().default(null)
}).strict();
export const modelSchema = modelFields.extend({
  id: z.string().uuid(), revision: z.string().uuid(), configurationRevision: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  credentialRef: z.string().uuid().nullable(), capabilities: modelCapabilitySchema
});
export type ModelRecord = z.infer<typeof modelSchema>;
export type ModelView = Omit<ModelRecord, 'credentialRef'> & { hasCredential: boolean };
export type ModelInput = z.input<typeof modelInputSchema>;
export type ModelDataClass = 'public' | 'deidentified' | 'internal';
export type ToolDefinition = { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } };
export type ModelToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ModelToolCall[]; tool_call_id?: string; name?: string };
export type ModelBudget = { calls: number; tokens: number };
export type ModelChatOptions = {
  tools?: ToolDefinition[]; toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  signal?: AbortSignal; dataClass?: ModelDataClass; budget?: ModelBudget;
};
export type ModelChatResult = { content: string; toolCalls: { id: string; name: string; arguments: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
export const decompositionSuggestionSchema = z.object({ title: z.string().trim().min(1).max(300), expectedResult: z.string().max(20000).default(''), nextAction: z.string().max(20000).default('') }).strict();
export type DecompositionSuggestion = z.infer<typeof decompositionSuggestionSchema>;
export const decomposeInputSchema = z.object({ modelId: z.string().uuid(), taskId: z.string().uuid(), instruction: z.string().max(10000).default(''), dataClass: z.enum(['public', 'deidentified', 'internal']).default('internal') }).strict();
export const adoptInputSchema = z.object({ taskId: z.string().uuid(), suggestions: z.array(decompositionSuggestionSchema).min(1).max(30) }).strict();
export const summarizeInputSchema = z.object({ modelId: z.string().uuid(), reviewId: z.string().uuid(), dataClass: z.enum(['public', 'deidentified', 'internal']).default('internal') }).strict();
