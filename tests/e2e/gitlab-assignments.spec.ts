import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import type { Task, SourceView } from '../../packages/contracts/src/index';
import type { SourceObject } from '../../packages/contracts/src/sources';

test('assigned issues and deduplicated MR roles appear in task center with distinct numbers', async ({ page }) => {
  let address = '';
  const prefix = `GitLab同步验证-${Date.now()}`;
  const fixture = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return; }
    if (url.pathname === '/api/v4/user') { res.end(JSON.stringify({ id: 7, name: 'Synthetic user' })); return; }
    const common = { id: 101, iid: 1, project_id: 1, state: 'opened', assignees: [{ id: 7 }], author: { id: 8, name: 'Synthetic author' } };
    const mr = { ...common, title: `${prefix}-MR`, web_url: `${address}/mr/1`, sha: 'synthetic-sha', reviewers: [{ id: 7 }] };
    const issue = { ...common, title: `${prefix}-Issue`, web_url: `${address}/issues/1`, due_date: '2026-12-01' };
    if (url.pathname === '/api/v4/projects/1/merge_requests') { res.setHeader('x-next-page', ''); res.end(JSON.stringify([mr])); return; }
    if (url.pathname === '/api/v4/projects/1/issues') { res.setHeader('x-next-page', ''); res.end(JSON.stringify([issue])); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const info = fixture.address(); address = `http://127.0.0.1:${typeof info === 'object' && info ? info.port : 0}`;
  let headers: Record<string, string> | undefined;
  try {
    await page.goto('/?view=tasks');
    const session = await (await page.request.get('/api/session')).json();
    headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
    const bootstrap = await (await page.request.get('/api/bootstrap')).json();
    const config: SourceView = bootstrap.sources.find((item: SourceView) => item.provider === 'gitlab');
    expect((await page.request.put('/api/sources/gitlab', { headers, data: { revision: config.revision, name: 'Synthetic GitLab', baseUrl: address, projectScope: '1', identity: '7', historyDays: 90, enabled: true, intervalMinutes: 5, scheduleEnabled: false, credentialAction: 'replace', credential: 'synthetic-e2e-token' } })).ok()).toBe(true);
    for (let pull = 0; pull < 2; pull++) {
      const sync = await page.request.post('/api/sources/gitlab/sync', { headers });
      expect(await sync.json()).toMatchObject({ status: 'success', count: 2 });
    }
    const records: SourceObject[] = (await (await page.request.get('/api/source-records')).json()).items;
    expect(records.filter(item => item.title.startsWith(prefix))).toHaveLength(2);
    const tasks: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
    expect(tasks.filter(item => item.title.startsWith(prefix))).toHaveLength(2);
    await page.reload();
    await page.getByLabel('搜索任务').fill(prefix);
    await page.getByLabel('筛选任务来源').selectOption('gitlab');
    await expect(page.locator('.task-list .task-title')).toHaveCount(2);
    const issueRow = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `${prefix}-Issue`, exact: true }) });
    const mrRow = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `${prefix}-MR`, exact: true }) });
    await expect(issueRow).toContainText('GitLab · #1');
    await expect(issueRow).toContainText('指派给我');
    await expect(mrRow).toContainText('GitLab · !1');
    await expect(mrRow).toContainText('由我评审');
    await page.getByLabel('搜索任务').fill('#1');
    await expect(page.locator('.task-list .task-title')).toHaveText([`${prefix}-Issue`]);
    await page.getByLabel('搜索任务').fill('!1');
    await expect(page.locator('.task-list .task-title')).toHaveText([`${prefix}-MR`]);
    await page.getByLabel('搜索任务').fill(prefix);
    await mkdir('.runtime/verification/screenshots', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `.runtime/verification/screenshots/gitlab-assignments-${width}.png`, fullPage: true, animations: 'disabled' });
    }
    await page.getByRole('button', { name: '来源任务与关联', exact: true }).click();
    await page.getByLabel('搜索来源记录').fill(prefix);
    await page.getByRole('button', { name: `${prefix}-Issue`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `${prefix}-Issue`, exact: true });
    await expect(dialog).toContainText('2026-12-01');
    await expect(dialog.getByRole('button', { name: '保存评审记录' })).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: 'MR 评审', exact: true }).click();
    await page.getByLabel('搜索来源记录').fill(prefix);
    await expect(page.locator('.record-card .task-title')).toHaveText([`${prefix}-MR`]);
  } finally {
    if (headers) {
      const bootstrap = await (await page.request.get('/api/bootstrap')).json();
      const source: SourceView | undefined = bootstrap.sources.find((item: SourceView) => item.provider === 'gitlab');
      if (source) await page.request.put('/api/sources/gitlab', { headers, data: { revision: source.revision, name: source.name, baseUrl: source.baseUrl, projectScope: source.projectScope, identity: source.identity, historyDays: source.historyDays, enabled: false, intervalMinutes: source.intervalMinutes, scheduleEnabled: false, credentialAction: 'clear' } });
    }
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  }
});
