import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../apps/server/src/app.js';

describe('HTTP model to authorized real tool integration', () => {
  it('round-trips tool results through the real adapter and verifies an actual Markdown artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwb-http-exec-'));
    let taskId = ''; let executionRequests = 0;
    const fixture = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const messages = body.messages as { role: string; name?: string; content: string }[];
      const tools = body.tools as { function: { name: string } }[] | undefined;
      const call = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      let message;
      if (!tools) message = { content: 'Loopback text probe' };
      else if (tools.some(tool => tool.function.name === 'workbench_probe')) {
        message = messages.some(value => value.role === 'tool') ? { content: 'probe-ok' } : call('workbench_probe', { value: 'probe' });
      } else {
        executionRequests++;
        const results = messages.filter(value => value.role === 'tool');
        if (!results.length) message = call('read_records', { kind: 'task', ids: [taskId] });
        else if (results.length === 1) {
          expect(results[0].content).toContain('saved_snapshot');
          expect(results[0].content).toContain('虚构整理材料');
          message = call('save_markdown', { filename: 'HTTP工具产物.md', content: '# Loopback fixture artifact\n\n真实工具保存与回读，非真实模型验收。\n' });
        } else { expect(results[1].content).toContain('sha256'); message = { content: 'Test fixture complete; review business content manually.' }; }
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 15 } }));
    });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address(); if (!address || typeof address === 'string') throw new Error('No loopback fixture port');
    const app = await createApp({ dataDir: dir, origin: 'http://127.0.0.1:4310', port: 4310, host: '127.0.0.1', remote: false });
    const headers = { host: '127.0.0.1:4310' };
    try {
      const token = (await app.inject({ url: '/api/session', headers })).json().csrfToken;
      const writeHeaders = { ...headers, 'x-workbench-csrf': token };
      const task = (await app.inject({ method: 'POST', url: '/api/tasks', headers: writeHeaders, payload: { title: '虚构整理材料', nextAction: '仅用于本地集成测试' } })).json(); taskId = task.id;
      const model = (await app.inject({ method: 'POST', url: '/api/models', headers: writeHeaders, payload: { name: 'HTTP fixture', kind: 'local', baseUrl: `http://127.0.0.1:${address.port}`, model: 'fixture', upstreamLocation: 'internal', allowInternal: true } })).json();
      const tested = await app.inject({ method: 'POST', url: `/api/models/${model.id}/test`, headers: writeHeaders, payload: { testTools: true } });
      expect(tested.json().capabilities.tools).toBe('passed');
      const planResponse = await app.inject({ method: 'POST', url: '/api/executions', headers: writeHeaders, payload: { title: 'HTTP工具闭环', modelId: model.id, instruction: '读取选定资料并在指定目录保存文件', taskIds: [taskId], allowedTools: ['read_records', 'save_markdown'] } });
      expect(planResponse.statusCode).toBe(200); const plan = planResponse.json();
      const authorized = await app.inject({ method: 'POST', url: `/api/executions/${plan.id}/authorize`, headers: writeHeaders, payload: { revision: plan.revision } }); expect(authorized.statusCode).toBe(200);
      let current = authorized.json();
      for (let attempt = 0; attempt < 100 && current.status === 'running'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10)); current = (await app.inject({ url: `/api/executions/${plan.id}`, headers })).json();
      }
      expect(current.status).toBe('completed'); expect(current.steps.map((step: { status: string }) => step.status)).toEqual(['completed', 'completed']);
      expect(current.artifacts).toHaveLength(1); expect(readFileSync(current.artifacts[0].path, 'utf8')).toContain('非真实模型验收');
      expect(executionRequests).toBe(3); expect(current.calls).toBe(3); expect(current.tokens).toBe(45);
      const preserved = (await app.inject({ url: '/api/bootstrap', headers })).json().tasks[0];
      expect(preserved).toMatchObject({ status: 'inbox', validation: 'unverified', delivery: 'not_delivered' });
    } finally {
      await app.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
    }
  });
});
