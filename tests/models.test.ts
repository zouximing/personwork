import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Workbench } from '../apps/server/src/workbench.js';
import { SecretVault } from '../apps/server/src/secrets.js';
import { Management } from '../apps/server/src/management.js';
import { ModelService, registerModelRoutes } from '../apps/server/src/models.js';

type RequestRecord = { url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };
type FixtureResponse = { status?: number; headers?: Record<string, string>; body?: unknown; hang?: boolean; delayMs?: number };
describe('real HTTP model adapters (loopback fixtures, not live provider acceptance)', () => {
  let dir: string; let workbench: Workbench; let vault: SecretVault; let models: ModelService;
  let server: Server; let baseUrl: string; let requests: RequestRecord[];
  let respond: (request: RequestRecord) => FixtureResponse;
  let cancelledUpstreamRequests: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pwb-models-')); workbench = new Workbench(dir); vault = new SecretVault(dir); models = new ModelService(workbench, vault); requests = []; cancelledUpstreamRequests = 0;
    respond = () => ({ body: { choices: [{ message: { content: 'fixture text', role: 'assistant' } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } } });
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const record = { url: request.url ?? '', headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }; requests.push(record);
      const result = respond(record); if (result.hang) return;
      response.on('close', () => { if (!response.writableEnded) cancelledUpstreamRequests++; });
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers });
      if (result.delayMs) { const timer = setTimeout(() => response.end(JSON.stringify(result.body ?? {})), result.delayMs); response.on('close', () => clearTimeout(timer)); }
      else response.end(JSON.stringify(result.body ?? {}));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback port'); baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); workbench.close(); rmSync(dir, { recursive: true, force: true }); });
  const fields = () => ({ name: 'Loopback fixture', kind: 'local' as const, baseUrl, protocol: 'openai' as const, model: 'fixture-model', upstream: 'loopback fixture', upstreamLocation: 'internal' as const, allowInternal: false, timeoutSeconds: 2, maxCalls: 5, maxTokens: 100, isDefault: false, enabled: true, credentialAction: 'keep' as const });

  it('persists named configurations and encrypts credentials without exposing them in views or history', async () => {
    const saved = await models.saveModel({ ...fields(), credentialAction: 'replace', credential: 'fixture-secret-private' });
    expect(saved.hasCredential).toBe(true); expect(JSON.stringify(saved)).not.toContain('fixture-secret-private');
    expect(JSON.stringify(workbench.storage.history())).not.toContain('fixture-secret-private');
    const paths = readdirSync(join(dir, 'secrets')); expect(paths).toHaveLength(1);
    expect(readFileSync(join(dir, 'secrets', paths[0])).includes(Buffer.from('fixture-secret-private'))).toBe(false);
    workbench.close(); workbench = new Workbench(dir); models = new ModelService(workbench, new SecretVault(dir));
    expect(models.listModels()[0]).toMatchObject({ id: saved.id, name: 'Loopback fixture', hasCredential: true, isDefault: true });
    await models.chat(saved.id, [{ role: 'user', content: 'public fixture' }], { dataClass: 'public' });
    expect(requests[0].headers.authorization).toBe('Bearer fixture-secret-private'); expect(requests[0].url).toBe('/v1/chat/completions');
    const second = await models.saveModel({ ...fields(), name: '另一配置', isDefault: true });
    expect(models.listModels().filter(value => value.isDefault).map(value => value.id)).toEqual([second.id]);
  });

  it('requires explicit credential handling on endpoint changes and preserves valid saved configuration on errors', async () => {
    const saved = await models.saveModel({ ...fields(), credentialAction: 'replace', credential: 'fixture-secret-private' });
    await expect(models.saveModel({ ...fields(), id: saved.id, revision: saved.revision, baseUrl: `${baseUrl}/other` })).rejects.toThrow(/凭据/);
    expect(models.listModels()[0].baseUrl).toBe(baseUrl);
    await expect(models.saveModel({ ...fields(), id: saved.id, revision: saved.revision, timeoutSeconds: 0 })).rejects.toThrow();
    const cleared = await models.saveModel({ ...fields(), id: saved.id, revision: saved.revision, baseUrl: `${baseUrl}/other`, credentialAction: 'clear' });
    expect(cleared.hasCredential).toBe(false); expect(cleared.capabilities.text).toBe('untested');
    await expect(models.saveModel({ ...fields(), id: saved.id, revision: saved.revision })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('checks data permission before requests, always treats DeepSeek as external and rejects unknown NewAPI upstream', async () => {
    const local = await models.saveModel(fields());
    await expect(models.chat(local.id, [{ role: 'user', content: 'internal fixture' }], { dataClass: 'internal' })).rejects.toMatchObject({ kind: 'permission' });
    const deepseek = await models.saveModel({ ...fields(), name: 'DeepSeek fixture', kind: 'deepseek', allowInternal: true, upstreamLocation: 'internal' });
    expect(deepseek.upstreamLocation).toBe('external');
    await expect(models.chat(deepseek.id, [{ role: 'user', content: 'internal fixture' }], { dataClass: 'internal' })).rejects.toMatchObject({ kind: 'permission' });
    const gateway = await models.saveModel({ ...fields(), name: 'NewAPI fixture', kind: 'newapi', allowInternal: true, upstreamLocation: 'unknown' });
    await expect(models.chat(gateway.id, [{ role: 'user', content: 'internal fixture' }], { dataClass: 'internal' })).rejects.toMatchObject({ kind: 'permission' });
    expect(requests).toHaveLength(0);
    await expect(models.chat(local.id, [{ role: 'user', content: 'unclassified fixture' }], { dataClass: 'invalid' as 'public' })).rejects.toMatchObject({ kind: 'permission' });
    const permitted = await models.saveModel({ ...fields(), id: local.id, revision: models.listModels().find(value => value.id === local.id)!.revision, allowInternal: true });
    expect((await models.chat(permitted.id, [{ role: 'user', content: 'internal fixture' }], { dataClass: 'internal' })).content).toBe('fixture text');
  });

  it('keeps prior credentials and configuration after a real database write failure', async () => {
    const saved = await models.saveModel({ ...fields(), credentialAction: 'replace', credential: 'fixture-previous-credential' });
    workbench.storage.database.exec("CREATE TRIGGER fail_model_event BEFORE INSERT ON events WHEN NEW.kind = 'model.updated' BEGIN SELECT RAISE(ABORT, 'model storage failure'); END;");
    await expect(models.saveModel({ ...fields(), id: saved.id, revision: saved.revision, credentialAction: 'replace', credential: 'fixture-replacement' })).rejects.toThrow(/model storage failure/);
    expect(models.listModels()[0].revision).toBe(saved.revision); expect(readdirSync(join(dir, 'secrets'))).toHaveLength(1);
    await models.chat(saved.id, [{ role: 'user', content: 'public fixture' }], { dataClass: 'public' });
    expect(requests[0].headers.authorization).toBe('Bearer fixture-previous-credential');
  });

  it('only passes tool capability after a real call, safe local execution and a second model response', async () => {
    const saved = await models.saveModel(fields());
    respond = request => {
      const messages = request.body.messages as { role: string; content: string }[];
      if (!request.body.tools) return { body: { choices: [{ message: { content: 'text probe ok' } }] } };
      if (messages.some(message => message.role === 'tool')) {
        expect(messages.find(message => message.role === 'tool')?.content).toContain('probe-ok');
        return { body: { choices: [{ message: { content: 'probe-ok' } }] } };
      }
      return { body: { choices: [{ message: { content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'workbench_probe', arguments: '{"value":"probe"}' } }] } }] } };
    };
    const tested = await models.testModel(saved.id, { testTools: true });
    expect(tested.capabilities).toMatchObject({ text: 'passed', tools: 'passed', configurationRevision: tested.configurationRevision });
    expect(requests).toHaveLength(3);
    const changed = await models.saveModel({ ...fields(), id: tested.id, revision: tested.revision, model: 'another-fixture' });
    expect(changed.capabilities.tools).toBe('untested');
  });

  it('fails tool verification for unrecognized tools without running or pretending success', async () => {
    const saved = await models.saveModel(fields());
    respond = request => ({ body: { choices: [{ message: request.body.tools ? { tool_calls: [{ id: 'bad', function: { name: 'delete_everything', arguments: '{}' } }] } : { content: 'text works' } }] } });
    const tested = await models.testModel(saved.id, { testTools: true });
    expect(tested.capabilities.text).toBe('passed'); expect(tested.capabilities.tools).toBe('failed'); expect(requests).toHaveLength(2);
  });

  it('adapts native Ollama endpoints, structured tool arguments, tool results and usage', async () => {
    const saved = await models.saveModel({ ...fields(), protocol: 'ollama' });
    respond = request => {
      expect(request.url).toBe('/api/chat'); expect(request.body.stream).toBe(false);
      const messages = request.body.messages as { role: string; content: string; tool_name?: string }[];
      if (!request.body.tools) return { body: { message: { role: 'assistant', content: 'native text' }, done: true, prompt_eval_count: 4, eval_count: 2 } };
      if (messages.some(message => message.role === 'tool')) { expect(messages.find(message => message.role === 'tool')?.tool_name).toBe('workbench_probe'); return { body: { message: { content: 'probe-ok' }, done: true } }; }
      return { body: { message: { tool_calls: [{ function: { name: 'workbench_probe', arguments: { value: 'probe' } } }] }, done: true } };
    };
    expect((await models.testModel(saved.id, { testTools: true })).capabilities.tools).toBe('passed');
    expect((await models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public' })).usage).toMatchObject({ total_tokens: 6 });
  });

  it('classifies authentication, rate, model and protocol failures without leaking remote bodies', async () => {
    const saved = await models.saveModel(fields());
    for (const [status, kind] of [[401, 'authentication'], [429, 'rate_limit'], [404, 'model'], [500, 'network']] as const) {
      respond = () => ({ status, body: { error: 'fixture-secret-that-must-not-return' } });
      const failure = await models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public' }).catch(error => error);
      expect(failure).toMatchObject({ kind }); expect(failure.message).not.toContain('fixture-secret');
    }
    respond = () => ({ body: { choices: [{ message: { tool_calls: [{ id: 'invalid', function: { name: 'probe', arguments: '{bad json' } }] } }] } });
    await expect(models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public' })).rejects.toMatchObject({ kind: 'protocol' });
    respond = () => ({ status: 302, headers: { location: `${baseUrl}/redirected` } });
    await expect(models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public' })).rejects.toMatchObject({ kind: 'network' });
    expect(requests.some(request => request.url === '/redirected')).toBe(false);
  });

  it('enforces shared call budgets and supports cancellation and real network timeouts', async () => {
    const saved = await models.saveModel({ ...fields(), timeoutSeconds: 1, maxCalls: 1 }); const budget = { calls: 0, tokens: 0 };
    await models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public', budget });
    await expect(models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public', budget })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort();
    await expect(models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public', signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
    respond = () => ({ hang: true });
    const pending = models.chat(saved.id, [{ role: 'user', content: 'fixture' }], { dataClass: 'public' });
    expect(models.isBusy()).toBe(true);
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    expect(models.isBusy()).toBe(false);
  });

  it('refuses to relabel internally linked task and management facts as deidentified for external AI', async () => {
    const saved = await models.saveModel({ ...fields(), upstreamLocation: 'external' }); const task = workbench.createTask({ title: '关联内部资料' });
    const source = { id: randomUUID(), revision: randomUUID(), localTaskId: task.id }; workbench.storage.put('source-record', source);
    await expect(models.decompose({ modelId: saved.id, taskId: task.id, dataClass: 'deidentified' })).rejects.toMatchObject({ kind: 'permission' });
    const management = new Management(workbench); const line = management.createLine({ name: '内网产线' });
    const period = management.createPeriod({ title: '内部月重点', kind: 'month', lineId: line.id, start: '2026-11-01', end: '2026-11-30' });
    const review = management.createReview({ title: '内部材料', kind: 'month', start: '2026-11-01', end: '2026-11-30', selections: { periodIds: [period.id] } });
    await expect(models.summarize({ modelId: saved.id, reviewId: review.id, dataClass: 'public' })).rejects.toMatchObject({ kind: 'permission' });
    expect(requests).toHaveLength(0);
  });

  it('does not trust stale tool capability metadata when reading restored configurations', async () => {
    const saved = await models.saveModel(fields()); const raw = workbench.storage.get<Record<string, unknown>>('model', saved.id)!;
    const restored = { ...raw, id: saved.id, revision: saved.revision, capabilities: { text: 'passed', tools: 'passed', testedAt: new Date().toISOString(), configurationRevision: randomUUID(), message: 'stale', lastErrorKind: null } };
    workbench.storage.put('model', restored, saved.revision);
    expect(models.listModels()[0].capabilities).toMatchObject({ text: 'untested', tools: 'untested' });
  });

  it('rechecks sensitive associations added to non-task facts before sending an existing review snapshot', async () => {
    const saved = await models.saveModel({ ...fields(), allowInternal: true }); const management = new Management(workbench);
    const line = management.createLine({ name: '虚构产线' });
    const period = management.createPeriod({ title: '原本普通周期', lineId: line.id, kind: 'month', start: '2026-11-01', end: '2026-11-30' });
    const risk = management.createRisk({ title: '原本普通风险' });
    const milestone = management.createMilestone({ title: '原本普通里程碑' });
    const review = management.createReview({ title: '既有事实快照', kind: 'month', start: '2026-11-01', end: '2026-11-30', selections: { periodIds: [period.id], riskIds: [risk.id], milestoneIds: [milestone.id] } });
    const privateTask = workbench.createTask({ title: '仅为测试的招聘行动', category: 'management', type: 'recruitment' });
    management.patchPeriod(period.id, { revision: period.revision, taskIds: [privateTask.id] });
    management.patchRisk(risk.id, { revision: risk.revision, taskIds: [privateTask.id] });
    management.patchMilestone(milestone.id, { revision: milestone.revision, taskIds: [privateTask.id] });
    await expect(models.summarize({ modelId: saved.id, reviewId: review.id })).rejects.toMatchObject({ kind: 'permission' });
    expect(requests).toHaveLength(0); expect(management.listReviews()[0].aiDrafts).toEqual([]);
  });

  it('excludes child actions of personnel or recruitment tasks from AI input and adoption', async () => {
    const saved = await models.saveModel({ ...fields(), allowInternal: true });
    const parent = workbench.createTask({ title: '仅为测试的人员事项', category: 'management', type: 'people' });
    const child = workbench.createTask({ title: '人员事项中的子行动', parentId: parent.id });
    await expect(models.decompose({ modelId: saved.id, taskId: child.id })).rejects.toMatchObject({ kind: 'permission' });
    expect(() => models.adopt({ taskId: child.id, suggestions: [{ title: '下一行动' }] })).toThrow(/人员|招聘|敏感|隐私/);
    expect(requests).toHaveLength(0);
  });

  it('returns editable decomposition proposals and only creates chosen local children on explicit adoption', async () => {
    const saved = await models.saveModel({ ...fields(), allowInternal: true }); const task = workbench.createTask({ title: '虚构研发任务' });
    respond = () => ({ body: { choices: [{ message: { content: JSON.stringify({ suggestions: [{ title: '核实边界', expectedResult: '边界记录', nextAction: '检查输入' }] }) } }] } });
    const app = Fastify(); registerModelRoutes(app, workbench, vault);
    try {
      const proposed = await app.inject({ method: 'POST', url: '/api/ai/decompose', payload: { modelId: saved.id, taskId: task.id } });
      expect(proposed.statusCode).toBe(200); expect(proposed.json().requiresReview).toBe(true); expect(workbench.listTasks()).toHaveLength(1);
      const adopted = await app.inject({ method: 'POST', url: '/api/ai/adopt', payload: { taskId: task.id, suggestions: proposed.json().suggestions } });
      expect(adopted.json().items[0]).toMatchObject({ parentId: task.id, title: '核实边界', validation: 'unverified' });
      const privateTask = workbench.createTask({ title: '私密姓名', type: 'people', category: 'management' });
      const denied = await app.inject({ method: 'POST', url: '/api/ai/decompose', payload: { modelId: saved.id, taskId: privateTask.id } });
      expect(denied.statusCode).toBe(400); expect(JSON.stringify(requests)).not.toContain('私密姓名');
    } finally { await app.close(); }
  });

  it('preserves AI summary drafts with provenance without replacing manual sections or published versions', async () => {
    const saved = await models.saveModel({ ...fields(), allowInternal: true }); const management = new Management(workbench);
    const task = workbench.createTask({ title: '虚构完成行动', status: 'done' });
    const plan = workbench.createTask({ title: '未来计划行动', planDate: '2026-11-09' });
    const review = management.createReview({ title: '待人工核实的总结', kind: 'week', start: '2026-11-02', end: '2026-11-08', selections: { taskIds: [task.id] }, includeNextWeekPlan: true, nextWeekTaskIds: [plan.id] });
    const published = management.publishReview(review.id, { revision: review.revision });
    respond = () => ({ body: { choices: [{ message: { content: '仅为可编辑的 fixture 草稿' } }] } });
    const app = Fastify(); registerModelRoutes(app, workbench, vault);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/ai/summarize', payload: { modelId: saved.id, reviewId: review.id } });
      expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ requiresReview: true, verified: false });
      const current = management.listReviews()[0]; expect(current.sections).toEqual(published.sections); expect(current.versions).toEqual(published.versions);
      expect(current.aiDrafts[0]).toMatchObject({ id: response.json().draftId, modelId: saved.id, text: expect.stringContaining(task.id) });
      expect(requests[0].body.messages).toBeDefined();
      expect(JSON.stringify(requests[0].body.messages)).toContain('任务标题--状态');
      expect(JSON.stringify(requests[0].body.messages)).toContain('正常完成只写');
      expect(JSON.stringify(requests[0].body.messages)).toContain('1、2、');
      const messages = requests[0].body.messages as { role: string; content: string }[];
      const payload = JSON.parse(messages.find(message => message.role === 'user')!.content);
      expect(payload.nextWeekPlan).toMatchObject({ start: '2026-11-09', end: '2026-11-15', taskIds: [plan.id] });
      expect(payload.reviewFactIds).toEqual([`task:${task.id}`]);
      expect(messages[0].content).toContain('未来计划不得写成本期成果');
    } finally { await app.close(); }
  });

  it('propagates a real browser disconnect to the upstream request and preserves the previous review draft', async () => {
    const saved = await models.saveModel({ ...fields(), allowInternal: true }); const management = new Management(workbench);
    const task = workbench.createTask({ title: '虚构可取消摘要' });
    const review = management.createReview({ title: '原草稿', kind: 'week', start: '2026-11-02', end: '2026-11-08', selections: { taskIds: [task.id] } });
    respond = () => ({ delayMs: 1200, body: { choices: [{ message: { content: '取消后不得继续写入的草稿' } }] } });
    const app = Fastify(); const routeModels = registerModelRoutes(app, workbench, vault); await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('Missing API fixture port');
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/api/ai/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: saved.id, reviewId: review.id }), signal: controller.signal });
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 1000 }); expect(routeModels.isBusy()).toBe(true);
      controller.abort(); await pending.catch(() => undefined);
      await vi.waitFor(() => { expect(routeModels.isBusy()).toBe(false); expect(cancelledUpstreamRequests).toBe(1); }, { timeout: 500, interval: 10 });
      expect(management.listReviews()[0]).toMatchObject({ revision: review.revision, sections: review.sections, aiDrafts: [] });
    } finally { controller.abort(); await app.close(); }
  });
});
