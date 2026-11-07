import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management } from '../apps/server/src/management.js';
import { ExecutionService, type ExecutionGateway, type ExecutionSources } from '../apps/server/src/executions.js';
import type { Execution } from '../packages/contracts/src/executions.js';

describe('independent execution boundary review regressions', () => {
  let dir: string; let workbench: Workbench; let management: Management; let service: ExecutionService;
  let modelId: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pwb-review-')); workbench = new Workbench(dir); management = new Management(workbench); modelId = randomUUID();
    const gateway: ExecutionGateway = {
      profile: () => ({ id: modelId, configurationRevision: randomUUID(), capabilities: { tools: 'passed' }, allowInternal: false, maxCalls: 8, maxTokens: 2000 }),
      chat: async () => { throw new Error('No model request may be made during this validation-only review'); }
    };
    const sources: ExecutionSources = { listRecords: () => workbench.storage.list('source-record'), listWritebacks: () => [], submitWriteback: async () => { throw new Error('Not authorized'); }, verifyWriteback: async () => { throw new Error('Not authorized'); } };
    service = new ExecutionService(workbench, gateway, sources, join(dir, 'artifacts'));
  });
  afterEach(async () => { await service.close(); workbench.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = () => ({ title: '独立审查计划', modelId, instruction: '仅核实已选记录', allowedTools: ['read_records'], dataClass: 'public' });

  it('rejects public/deidentified execution of a task linked to an internal source', () => {
    const task = workbench.createTask({ title: '虚构内部行动', expectedResult: '仅为测试的内部业务摘要' });
    const source = { id: randomUUID(), revision: randomUUID(), localTaskId: task.id }; workbench.storage.put('source-record', source);
    expect(() => service.create({ ...input(), taskIds: [task.id] })).toThrow(/内部|脱敏|许可/);
    expect(() => service.create({ ...input(), dataClass: 'deidentified', taskIds: [task.id] })).toThrow(/内部|脱敏|许可/);
  });

  it('rejects public execution of line periods, risks and management tasks without internal permission', () => {
    const line = management.createLine({ name: '虚构内网产线' });
    const task = workbench.createTask({ title: '虚构内部管理行动', category: 'management', type: 'coordination' });
    const period = management.createPeriod({ title: '内部月重点', lineId: line.id, kind: 'month', start: '2026-11-01', end: '2026-11-30', taskIds: [task.id] });
    const risk = management.createRisk({ title: '内部依赖风险', lineIds: [line.id] });
    expect(() => service.create({ ...input(), periodIds: [period.id] })).toThrow(/内部|脱敏|许可/);
    expect(() => service.create({ ...input(), riskIds: [risk.id] })).toThrow(/内部|脱敏|许可/);
    expect(() => service.create({ ...input(), taskIds: [task.id] })).toThrow(/内部|脱敏|许可/);
    const personal = workbench.createTask({ title: '人工脱敏练习材料' });
    expect(service.create({ ...input(), taskIds: [personal.id] }).status).toBe('awaiting_authorization');
  });

  it('rejects Windows device filenames during parameter validation before any filesystem operation', () => {
    const execution = service.create({ ...input(), allowedTools: ['save_markdown'] });
    // Calling the validator alone never invokes its returned action, including on an unfixed build.
    const validator = service as unknown as { prepareTool(item: Execution, name: string, raw: string): unknown };
    for (const filename of ['CON.md', 'NUL.md', 'AUX.md', 'COM1.md', 'LPT9.md', 'COM¹.md', 'LPT².md']) {
      expect(() => validator.prepareTool(execution, 'save_markdown', JSON.stringify({ filename, content: 'synthetic text' })), filename).toThrow(/参数|设备|文件名/);
    }
  });

  it('stops before further tools when the model response reports an exhausted token budget', async () => {
    const task = workbench.createTask({ title: '公开虚构练习' }); const configurationRevision = randomUUID();
    const gateway: ExecutionGateway = {
      profile: () => ({ id: modelId, configurationRevision, capabilities: { tools: 'passed' }, allowInternal: false, maxCalls: 8, maxTokens: 10 }),
      chat: async () => ({ content: '', toolCalls: [{ id: 'over-budget-fixture-call', name: 'read_records', arguments: JSON.stringify({ kind: 'task', ids: [task.id] }) }], usage: { total_tokens: 20 } })
    };
    const sources: ExecutionSources = { listRecords: () => [], listWritebacks: () => [], submitWriteback: async () => { throw new Error('Not authorized'); }, verifyWriteback: async () => { throw new Error('Not authorized'); } };
    service = new ExecutionService(workbench, gateway, sources, join(dir, 'artifacts'));
    const planned = service.create({ ...input(), taskIds: [task.id] }); service.authorize(planned.id, planned.revision); await service.wait(planned.id);
    expect(service.get(planned.id).steps).toEqual([]);
    expect(service.get(planned.id).status).not.toBe('completed');
  });

  it('excludes personnel associations inside periods, risks and sources even for internal models', () => {
    const privateTask = workbench.createTask({ title: '仅为测试的人员行动', category: 'management', type: 'people' });
    const privateParentChild = workbench.createTask({ title: '人员事项的子行动', parentId: privateTask.id });
    const line = management.createLine({ name: '虚构产线' });
    const period = management.createPeriod({ title: '带人员关联的周期', kind: 'month', lineId: line.id, start: '2026-11-01', end: '2026-11-30', taskIds: [privateTask.id] });
    const risk = management.createRisk({ title: '带人员关联的风险', taskIds: [privateTask.id] });
    const source = { id: randomUUID(), revision: randomUUID(), localTaskId: privateTask.id }; workbench.storage.put('source-record', source);
    const gateway: ExecutionGateway = { profile: () => ({ id: modelId, configurationRevision: 'synthetic-configuration', capabilities: { tools: 'passed' }, allowInternal: true, maxCalls: 8, maxTokens: 2000 }), chat: async () => { throw new Error('No model requests allowed'); } };
    const sources: ExecutionSources = { listRecords: () => workbench.storage.list('source-record'), listWritebacks: () => [], submitWriteback: async () => { throw new Error('Not authorized'); }, verifyWriteback: async () => { throw new Error('Not authorized'); } };
    service = new ExecutionService(workbench, gateway, sources, join(dir, 'artifacts'));
    for (const selection of [{ periodIds: [period.id] }, { riskIds: [risk.id] }, { sourceRecordIds: [source.id] }, { taskIds: [privateParentChild.id] }]) expect(() => service.create({ ...input(), dataClass: 'internal', ...selection })).toThrow(/敏感|人员|招聘|私密/);
  });
});
