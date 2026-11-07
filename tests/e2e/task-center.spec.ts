import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { Task } from '../../packages/contracts/src/index';
import type { Recurrence } from '../../packages/contracts/src/management';

test('task center includes existing management tasks and counts all active tasks', async ({ page }) => {
  const prefix = `任务中心验证-${Date.now()}`;
  await page.goto('/?view=tasks');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  for (const fields of [
    { title: `${prefix}-研发`, category: 'personal', status: 'todo' },
    { title: `${prefix}-交办`, category: 'management', type: 'coordination', status: 'doing' },
    { title: `${prefix}-人员`, category: 'management', type: 'people', status: 'inbox' },
    { title: `${prefix}-已完成`, category: 'management', status: 'done' },
    { title: `${prefix}-已归档`, category: 'management', archived: true, archiveReason: '合成测试归档' },
  ]) {
    const response = await page.request.post('/api/tasks', { headers, data: fields });
    expect(response.ok()).toBe(true);
  }
  const saved: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  const activeCount = saved.filter(task => !task.archived && !['done', 'cancelled'].includes(task.status)).length;
  const assignment = saved.find(task => task.title === `${prefix}-交办`)!;
  await page.reload();
  await page.getByLabel('搜索任务').fill(prefix);
  await expect(page.locator('.task-list .task-title')).toHaveCount(4);
  for (const suffix of ['研发', '交办', '人员', '已完成']) {
    await expect(page.locator('.task-list').getByRole('button', { name: `${prefix}-${suffix}`, exact: true })).toBeVisible();
  }
  const navigation = page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: '任务中心', exact: true });
  await expect(navigation).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('small')).toHaveText(String(activeCount));
  await page.getByLabel('筛选类型').selectOption('coordination');
  await expect(page.locator('.task-list .task-title')).toHaveText([`${prefix}-交办`]);
  await page.getByRole('button', { name: `${prefix}-交办`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '任务详情' });
  await editor.getByLabel('任务描述', { exact: true }).fill('统一入口继续跟进');
  await editor.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('个人安排已保存');
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: `完成 ${prefix}-交办`, exact: true }).click();
  await expect(navigation.locator('small')).toHaveText(String(activeCount - 1));
  await page.reload();
  await page.getByLabel('搜索任务').fill(prefix);
  const row = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `${prefix}-交办`, exact: true }) });
  await expect(row.getByText('已完成', { exact: true })).toBeVisible();
  await expect(row.getByText('统一入口继续跟进', { exact: true })).toBeVisible();
  const persisted: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  expect(persisted.find(task => task.id === assignment.id)).toMatchObject({ category: 'management', status: 'done', nextAction: '统一入口继续跟进' });
  await page.getByRole('checkbox', { name: '归档', exact: true }).check();
  await expect(page.locator('.task-list .task-title')).toHaveText([`${prefix}-已归档`]);
  await page.getByRole('checkbox', { name: '归档', exact: true }).uncheck();

  await page.getByRole('button', { name: '快速记录', exact: true }).click();
  const capture = page.getByRole('dialog', { name: '快速记录' });
  await capture.getByLabel('任务标题', { exact: true }).fill(`${prefix}-新协作`);
  await capture.getByRole('combobox', { name: '任务分类', exact: true }).selectOption('management');
  await capture.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(capture).toBeHidden();
  await expect(page.locator('.task-list').getByRole('button', { name: `${prefix}-新协作`, exact: true })).toBeVisible();
  await expect(navigation.locator('small')).toHaveText(String(activeCount));
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/verification/screenshots/task-center-${width}.png`, fullPage: true, animations: 'disabled' });
  }
});

test('old and newly generated recurring tasks share task center without duplicate occurrences', async ({ page }) => {
  const title = `周期入口验证-${Date.now()}`;
  await page.goto('/?view=manage');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  const created = await page.request.post('/api/recurrences', { headers, data: { title, kind: 'week', expectedResult: '合成周期交付要求' } });
  expect(created.ok()).toBe(true);
  const rule: Recurrence = await created.json();
  const previous = await page.request.post('/api/recurrences/materialize', { headers, data: { recurrenceId: rule.id, start: '2026-10-26', end: '2026-11-01' } });
  expect(previous.ok()).toBe(true);
  const old: { task: Task } = await previous.json();
  await page.reload();
  await expect(page.getByRole('button', { name: '其他管理事项', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '周期事项', exact: true }).click();
  const card = page.locator('.record-card').filter({ has: page.getByRole('heading', { name: new RegExp(title) }) });
  await expect(card).toContainText('已生成 1 期');
  await card.getByRole('button', { name: '生成本期任务…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '生成本期独立任务' });
  await dialog.getByLabel('新周期开始').fill('2026-11-09');
  await dialog.getByLabel('新周期结束').fill('2026-11-15');
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText('已生成 2 期');
  await card.getByRole('button', { name: '生成本期任务…', exact: true }).click();
  await dialog.getByLabel('新周期开始').fill('2026-11-09');
  await dialog.getByLabel('新周期结束').fill('2026-11-15');
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toContainText('本期任务已存在');
  await expect(card).toContainText('已生成 2 期');
  await page.getByRole('button', { name: '任务中心', exact: true }).click();
  await page.getByLabel('搜索任务').fill(title);
  await expect(page.locator('.task-list .task-title')).toHaveCount(2);
  await expect(page.getByRole('button', { name: old.task.title, exact: true })).toBeVisible();
  const generatedTitle = `${title}（2026-11-09 — 2026-11-15）`;
  await page.getByRole('button', { name: generatedTitle, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '任务详情' });
  const tasks: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  expect(tasks.find(task => task.title === generatedTitle)?.expectedResult).toBe('合成周期交付要求');
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.getByLabel('搜索任务').fill(title);
  await expect(page.locator('.task-list .task-title')).toHaveCount(2);
  const rules: { items: Recurrence[] } = await (await page.request.get('/api/recurrences')).json();
  const occurrences = rules.items.find(item => item.id === rule.id)!.occurrences;
  expect(occurrences).toHaveLength(2);
  expect(occurrences[0].taskId).toBe(old.task.id);
  expect(new Set(occurrences.map(item => item.taskId)).size).toBe(2);
});
