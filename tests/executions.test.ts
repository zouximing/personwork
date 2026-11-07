import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../apps/server/src/workbench.js';
import { ExecutionService, type ExecutionGateway } from '../apps/server/src/executions.js';

describe('authorized real tools and verifiable artifacts', () => {
  let dir: string; let store: Workbench;
  const modelId = randomUUID();
  const profile = { id: modelId, configurationRevision: 'test-config', capabilities: { tools: 'passed' }, allowInternal: true, maxCalls: 8, maxTokens: 10000 };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pwb-exec-')); store = new Workbench(dir); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const sources = { listRecords: () => [], listWritebacks: () => [], submitWriteback: async () => { throw new Error('unexpected write'); }, verifyWriteback: async () => { throw new Error('unexpected verify'); } };
  it('executes the file tool, reads the actual artifact and preserves business verification independently', async () => {
    let call = 0; const gateway: ExecutionGateway = { profile: () => profile, chat: async () => ++call === 1 ? { content: '', toolCalls: [{ id: 'call-1', name: 'save_markdown', arguments: JSON.stringify({ filename: 'summary.md', content: '# 实际产物\n\n已核对输入。' }) }] } : { content: '文件已生成，请人工复核。', toolCalls: [] } };
    const task = store.createTask({ title: '待查询事项' }); const service = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    const plan = service.create({ title: '整理资料', modelId, instruction: '保存Markdown', allowedTools: ['save_markdown'], taskIds: [task.id] });
    expect(plan.status).toBe('awaiting_authorization'); expect(plan.steps).toHaveLength(0);
    service.authorize(plan.id, plan.revision); await service.wait(plan.id);
    const result = service.get(plan.id);
    expect(result.status).toBe('completed'); expect(result.artifacts).toHaveLength(1);
    expect(readFileSync(result.artifacts[0].path, 'utf8')).toBe('# 实际产物\n\n已核对输入。');
    expect(result.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.listTasks()[0]).toMatchObject({ validation: 'unverified', delivery: 'not_delivered' });
  });
  it('pauses unknown or out-of-scope tool calls before any effect', async () => {
    const gateway: ExecutionGateway = { profile: () => profile, chat: async () => ({ content: '', toolCalls: [{ id: 'call-x', name: 'gitlab_merge', arguments: '{}' }] }) };
    const service = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    const plan = service.create({ title: '受限计划', modelId, instruction: '只读', allowedTools: ['read_records'] });
    service.authorize(plan.id, plan.revision); await service.wait(plan.id);
    expect(service.get(plan.id).status).toBe('paused');
    expect(service.get(plan.id).steps).toHaveLength(0);
  });
  it('rejects directory traversal and never writes outside the authorized artifact folder', async () => {
    const gateway: ExecutionGateway = { profile: () => profile, chat: async () => ({ content: '', toolCalls: [{ id: 'path-x', name: 'save_markdown', arguments: JSON.stringify({ filename: '../escape.md', content: '不能写出' }) }] }) };
    const service = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    const plan = service.create({ title: '文件权限', modelId, instruction: '保存', allowedTools: ['save_markdown'] });
    service.authorize(plan.id, plan.revision); await service.wait(plan.id);
    expect(service.get(plan.id).status).toBe('paused'); expect(existsSync(join(dir, 'escape.md'))).toBe(false);
  });
  it('does not accept a plain completion reply as verified execution', async () => {
    const gateway: ExecutionGateway = { profile: () => profile, chat: async () => ({ content: '全部完成', toolCalls: [] }) };
    const service = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    const plan = service.create({ title: '无工具回复', modelId, instruction: '做事', allowedTools: ['read_records'] });
    service.authorize(plan.id, plan.revision); await service.wait(plan.id);
    expect(service.get(plan.id).status).toBe('pending_verification'); expect(service.get(plan.id).artifacts).toHaveLength(0);
  });
  it('records cancellation and never starts another tool after stopping', async () => {
    const gateway: ExecutionGateway = { profile: () => profile, chat: async (_id, _messages, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
    const service = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    const plan = service.create({ title: '取消', modelId, instruction: '等待', allowedTools: ['read_records'] });
    service.authorize(plan.id, plan.revision); service.stop(plan.id); await service.wait(plan.id);
    expect(service.get(plan.id).status).toBe('cancelled'); expect(service.get(plan.id).steps).toHaveLength(0);
  });
  it('requires a new plan when selected materials change before authorization', () => {
    const gateway: ExecutionGateway = { profile: () => profile, chat: async () => ({ content: '', toolCalls: [] }) };
    const task = store.createTask({ title: '原材料' });
    const service = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    const plan = service.create({ title: '固定范围', modelId, instruction: '只用原材料', allowedTools: ['read_records'], taskIds: [task.id] });
    store.patchTask(task.id, { revision: task.revision, title: '范围已变化' });
    expect(() => service.authorize(plan.id, plan.revision)).toThrow(/材料已变更/);
  });
  it('preserves the receipt of an already-issued operation after stopping and starts no further tool', async () => {
    const writebackId = randomUUID(); let release!: (value: { id: string; status: string }) => void;
    let started!: () => void; const issued = new Promise<void>(resolve => { started = resolve; });
    const pendingSources = { ...sources, listWritebacks: () => [{ id: writebackId, status: 'preview' }], submitWriteback: async () => { started(); return new Promise<{ id: string; status: string }>(resolve => { release = resolve; }); } };
    let calls = 0; const gateway: ExecutionGateway = { profile: () => profile, chat: async () => { calls++; return { content: '', toolCalls: [{ id: 'issued', name: 'submit_writeback', arguments: JSON.stringify({ writebackId }) }, { id: 'later', name: 'save_markdown', arguments: JSON.stringify({ filename: 'later.md', content: 'must not be written' }) }] }; } };
    const service = new ExecutionService(store, gateway, pendingSources, join(dir, 'artifacts'));
    const plan = service.create({ title: '停止在途操作', modelId, instruction: '只处理已批准预览', allowedTools: ['submit_writeback', 'save_markdown'], writebackIds: [writebackId] });
    service.authorize(plan.id, plan.revision); await issued;
    expect(service.stop(plan.id).status).toBe('pending_verification');
    release({ id: writebackId, status: 'confirmed' }); await service.wait(plan.id);
    const result = service.get(plan.id); expect(result.status).toBe('pending_verification');
    expect(result.steps).toHaveLength(1); expect(result.steps[0].result).toContain('confirmed');
    expect(result.artifacts).toHaveLength(0); expect(calls).toBe(1);
  });
  it('reopens a persisted interrupted execution as pending verification without automatically running it', () => {
    const gateway: ExecutionGateway = { profile: () => profile, chat: async () => { throw new Error('must not resume'); } };
    const service = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    const plan = service.create({ title: '中断快照', modelId, instruction: '需核实的原操作', allowedTools: ['save_markdown'] });
    store.storage.put('execution', { ...plan, revision: randomUUID(), status: 'running' }, plan.revision);
    store.close(); store = new Workbench(dir);
    const reopened = new ExecutionService(store, gateway, sources, join(dir, 'artifacts'));
    expect(reopened.get(plan.id).status).toBe('pending_verification'); expect(reopened.isBusy()).toBe(false);
  });
});
