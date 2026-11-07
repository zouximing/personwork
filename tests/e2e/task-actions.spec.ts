import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { Task } from '../../packages/contracts/src/index';

async function seed(page: Page, title: string) {
  await page.goto('/?view=tasks');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  const response = await page.request.post('/api/tasks', { headers, data: { title, nextAction: '合成任务描述' } });
  expect(response.ok()).toBe(true);
  const task: Task = await response.json();
  await page.reload();
  await page.getByLabel('搜索任务').fill(title);
  return { task, headers, row: page.locator('.task-row').filter({ has: page.getByRole('button', { name: title, exact: true }) }) };
}

test('task list schedules today, changes status and permanently deletes only after confirmation', async ({ page }) => {
  const title = `快捷操作-${Date.now()}`;
  const { task, row } = await seed(page, title);
  const today = (await (await page.request.get('/api/bootstrap')).json()).today;
  await expect(page.locator('.task-list-head')).toContainText('任务描述');
  await row.getByRole('button', { name: `安排今日 ${title}`, exact: true }).click();
  await expect(row).toContainText(today);
  await row.getByRole('combobox', { name: `修改状态 ${title}`, exact: true }).selectOption('doing');
  await expect(row.getByRole('combobox')).toHaveValue('doing');
  await row.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '永久删除任务' });
  await expect(dialog).toContainText(title);
  await expect(dialog).toContainText('无法恢复');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
  await dialog.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  await page.reload();
  const tasks: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  expect(tasks.some(item => item.id === task.id)).toBe(false);
  expect((await (await page.request.get(`/api/history/${task.id}`)).json()).items).toEqual([]);
});

test('waiting and blocked shortcuts collect required fields and list fits desktop and mobile', async ({ page }) => {
  const title = `状态操作-${Date.now()}`;
  const { row } = await seed(page, title);
  await row.getByRole('combobox').selectOption('waiting');
  let dialog = page.getByRole('dialog', { name: '修改任务状态' });
  await dialog.getByRole('button', { name: '保存状态', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('等待对象', { exact: true }).fill('合成协作方');
  await dialog.getByLabel('等待内容', { exact: true }).fill('合成反馈');
  await dialog.getByLabel('下次跟进日期', { exact: true }).fill('2026-11-12');
  await dialog.getByRole('button', { name: '保存状态', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('combobox')).toHaveValue('waiting');
  await row.getByRole('combobox').selectOption('blocked');
  dialog = page.getByRole('dialog', { name: '修改任务状态' });
  await dialog.getByLabel('阻塞原因', { exact: true }).fill('合成依赖');
  await dialog.getByRole('textbox', { name: '任务描述', exact: true }).fill('继续联络协作方');
  await dialog.getByLabel('下次跟进日期', { exact: true }).fill('2026-11-13');
  await dialog.getByRole('button', { name: '保存状态', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('combobox')).toHaveValue('blocked');
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(row.getByRole('button', { name: `删除 ${title}`, exact: true })).toBeVisible();
    await page.screenshot({ path: `.runtime/verification/screenshots/task-actions-${width}.png`, fullPage: true, animations: 'disabled' });
  }
});

test('failed and stale delete keeps the task visible without claiming success', async ({ page }) => {
  const title = `删除冲突-${Date.now()}`;
  const { task, headers, row } = await seed(page, title);
  await row.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
  const edited = await page.request.patch(`/api/tasks/${task.id}`, { headers, data: { revision: task.revision, notes: '并发编辑必须保留' } });
  expect(edited.ok()).toBe(true);
  const dialog = page.getByRole('dialog', { name: '永久删除任务' });
  await dialog.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('更新');
  await expect(row).toBeVisible();
  const latest: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  expect(latest.find(item => item.id === task.id)?.notes).toBe('并发编辑必须保留');
});

test('a delayed list shortcut does not clear unsaved protection in another task detail', async ({ page }) => {
  const prefix = `在途保护-${Date.now()}`;
  const { task, headers, row } = await seed(page, `${prefix}-安排`);
  const created = await page.request.post('/api/tasks', { headers, data: { title: `${prefix}-编辑` } });
  expect(created.ok()).toBe(true);
  await page.reload();
  await page.getByLabel('搜索任务').fill(prefix);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/tasks/${task.id}`, async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await row.getByRole('button', { name: `安排今日 ${task.title}`, exact: true }).click();
  await page.getByRole('button', { name: `${prefix}-编辑`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '任务详情' });
  await editor.getByRole('textbox', { name: '任务描述', exact: true }).fill('不能因其他任务保存而丢失');
  release();
  await expect(page.getByRole('status')).toContainText('任务已更新');
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '内容尚未保存' })).toBeVisible();
});
