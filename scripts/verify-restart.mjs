import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Only synthetic verification data is created. Existing product data is never opened.
const root = resolve(import.meta.dirname, '..');
const dataDir = join(root, '.runtime', 'restart', randomUUID());
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`;
let child;
async function start() {
  child = spawn(process.execPath, ['apps/server/dist/index.js'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_PORT: String(port), WORKBENCH_HOST: '127.0.0.1', WORKBENCH_ORIGIN: origin } });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Verification backend exited before readiness');
    try { const response = await fetch(`${origin}/api/session`); if (response.ok) return (await response.json()).csrfToken; } catch { /* Wait only for the isolated verification backend. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('Verification backend readiness timed out');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, 'exit'); child.kill(); await exit;
}
async function post(path, body, token) {
  const response = await fetch(`${origin}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workbench-csrf': token }, body: JSON.stringify(body) });
  assert.ok(response.ok, `Unexpected HTTP ${response.status}`); return response.json();
}
try {
  const token = await start();
  const dashboardBefore = await (await fetch(`${origin}/api/dashboard`)).json();
  const task = await post('tasks', { title: '进程重启验证 synthetic', nextAction: '重新读取持久保存的行动', planDate: '2026-11-07', startDate: dashboardBefore.date, keyDate: dashboardBefore.date }, token);
  const completedTask = await post('tasks', { title: '进程重启完成 synthetic', status: 'done' }, token);
  const settingsResponse = await fetch(`${origin}/api/dashboard/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-workbench-csrf': token }, body: JSON.stringify({ ...dashboardBefore.settings, deadlineLeadDays: 4, mrBacklogDays: 5 }) });
  assert.ok(settingsResponse.ok);
  const body = '首行\n  {{placeholder}} <>&\n结尾保持换行\n';
  const prompt = await post('prompts', { title: '进程重启模板 synthetic', body, tag: 'verification' }, token);
  const line = await post('lines', { name: '进程重启产线 synthetic', reminderWeekday: 4 }, token);
  const month = await post('periods', { title: '进程重启月目标 synthetic', kind: 'month', lineId: line.id, start: '2026-11-01', end: '2026-11-30', completion: 42, notes: '合成备注保留' }, token);
  const week = await post('periods', { title: '进程重启周目标 synthetic', kind: 'week', lineId: line.id, start: '2026-11-02', end: '2026-11-08', monthlyId: month.id, progressStatus: 'blocked', actual: '合成进展说明' }, token);
  const risk = await post('risks', { title: '进程重启风险 synthetic', lineIds: [line.id], level: 'high', targetCloseDate: '2026-11-09', escalated: true }, token);
  const review = await post('reviews', { title: '进程重启产线周报 synthetic', kind: 'week', start: '2026-11-02', end: '2026-11-08' }, token);
  assert.ok(review.reportBody.includes('## 产线进展'));
  await stop();
  await start();
  const loaded = await (await fetch(`${origin}/api/bootstrap`)).json();
  assert.equal(loaded.tasks.length, 2); assert.equal(loaded.prompts.length, 1);
  const loadedTask = loaded.tasks.find(value => value.id === task.id);
  assert.equal(loadedTask.revision, task.revision);
  assert.equal(loadedTask.nextAction, '重新读取持久保存的行动');
  assert.equal(loadedTask.startDate, dashboardBefore.date); assert.equal(loadedTask.keyDate, dashboardBefore.date);
  assert.equal(loaded.tasks.find(value => value.id === completedTask.id).completedAt, completedTask.completedAt);
  const dashboard = await (await fetch(`${origin}/api/dashboard`)).json();
  assert.equal(dashboard.keyTasks[0].id, task.id); assert.equal(dashboard.completedToday[0].id, completedTask.id);
  assert.equal(dashboard.settings.deadlineLeadDays, 4); assert.equal(dashboard.settings.mrBacklogDays, 5);
  assert.equal(loaded.prompts[0].id, prompt.id); assert.equal(loaded.prompts[0].body, body);
  const lines = await (await fetch(`${origin}/api/lines`)).json();
  const periods = await (await fetch(`${origin}/api/periods`)).json();
  const risks = await (await fetch(`${origin}/api/risks`)).json();
  const reviews = await (await fetch(`${origin}/api/reviews`)).json();
  assert.equal(lines.items.find(value => value.id === line.id).reminderWeekday, 4);
  const savedMonth = periods.items.find(value => value.id === month.id); const savedWeek = periods.items.find(value => value.id === week.id);
  assert.equal(savedMonth.completion, 42); assert.equal(savedMonth.notes, '合成备注保留');
  assert.equal(savedWeek.monthlyId, month.id); assert.equal(savedWeek.progressStatus, 'blocked'); assert.equal(savedWeek.actual, '合成进展说明');
  assert.equal(risks.items.find(value => value.id === risk.id).level, 'high');
  assert.equal(risks.items.find(value => value.id === risk.id).escalated, true);
  assert.equal(reviews.items.find(value => value.id === review.id).reportBody, review.reportBody);
  const result = { testedAt: new Date().toISOString(), passed: true, method: 'Independent Node backend process exit and restart; real HTTP and SQLite', checks: ['task id, revision and next action retained', 'dashboard keys, start date, completion timestamp and reminder preferences retained', 'prompt id and exact multiline body retained', 'production reminder day, month completion and notes retained', 'weekly progress, monthly linkage and explanation retained', 'risk level, escalation and production report snapshot retained'], dataDir };
  const evidence = join(root, '.runtime', 'verification'); mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, 'restart.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write('PASS: real backend process restart retained tasks, prompts, production fields, risks and report snapshot. Evidence: .runtime/verification/restart.json\n');
} finally { await stop(); }
