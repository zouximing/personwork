import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { taskFields, type Task, type TaskInput } from '../../packages/contracts/src/index';

const makeTask = (fields: TaskInput): Task => ({
  ...taskFields.parse(fields), id: randomUUID(), revision: randomUUID(),
  createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z', sourceState: null, completedAt: null,
});

async function fixedCalendar(page: Page, tasks: Task[]) {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, tasks, today: '2026-11-07', week: '2026-11-02 — 2026-11-08' } });
  });
  await page.goto('/?view=calendar');
  await expect(page.getByRole('heading', { name: '任务日历', exact: true })).toBeVisible();
}

test('calendar merges same-day task dates, includes management and filters date kinds and ended tasks', async ({ page }) => {
  await fixedCalendar(page, [
    makeTask({ title: '同一天三个节点', category: 'management', order: -1, planDate: '2026-11-07', dueDate: '2026-11-07', followUpDate: '2026-11-07' }),
    makeTask({ title: '不同日期的任务', planDate: '2026-11-07', dueDate: '2026-11-09' }),
    makeTask({ title: '已结束任务', status: 'done', planDate: '2026-11-07' }),
    makeTask({ title: '已取消任务', status: 'cancelled', dueDate: '2026-11-07' }),
    makeTask({ title: '已归档任务', archived: true, archiveReason: '合成归档', planDate: '2026-11-07' }),
    makeTask({ title: '未安排日期的任务' }),
  ]);
  const day = page.getByRole('region', { name: '月日历', exact: true }).locator('[data-date="2026-11-07"]');
  const combined = day.getByRole('button', { name: '打开任务：同一天三个节点', exact: true });
  await expect(combined).toHaveCount(1);
  for (const text of ['计划', '截止', '跟进']) await expect(combined.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开任务：已结束任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开任务：已取消任务', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '显示已完成／已取消', exact: true }).check();
  const selected = page.getByRole('region', { name: '当日任务', exact: true });
  await expect(selected.getByRole('button', { name: '打开任务：已结束任务', exact: true })).toBeVisible();
  await expect(selected.getByRole('button', { name: '打开任务：已取消任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开任务：已归档任务', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '计划日期', exact: true }).uncheck();
  await expect(combined.getByText('计划', { exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '截止日期', exact: true }).uncheck();
  await expect(combined.getByText('跟进', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '跟进日期', exact: true }).uncheck();
  await expect(day.getByRole('button', { name: '打开任务：同一天三个节点', exact: true })).toHaveCount(0);
  await expect(page.getByText('请选择至少一种日期类型')).toBeVisible();
});

test('calendar navigates across years, clamps month ends and uses Monday weeks', async ({ page }) => {
  await fixedCalendar(page, []);
  await page.getByLabel('定位日期', { exact: true }).fill('2026-12-31');
  await page.getByRole('button', { name: '下一个月', exact: true }).click();
  await expect(page.getByLabel('定位日期', { exact: true })).toHaveValue('2027-01-31');
  await page.getByRole('button', { name: '下一个月', exact: true }).click();
  await expect(page.getByLabel('定位日期', { exact: true })).toHaveValue('2027-02-28');
  await page.getByRole('button', { name: '周视图', exact: true }).click();
  await expect(page.getByRole('region', { name: '周日历', exact: true }).locator('[data-date]').first()).toHaveAttribute('data-date', '2027-02-22');
  await page.getByRole('button', { name: '下一周', exact: true }).click();
  await expect(page.getByLabel('定位日期', { exact: true })).toHaveValue('2027-03-07');
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await expect(page.getByLabel('定位日期', { exact: true })).toHaveValue('2026-11-07');
  await expect(page.getByRole('region', { name: '周日历', exact: true }).locator('[data-date]').first()).toHaveAttribute('data-date', '2026-11-02');
});

test('a crowded day remains accessible and calendar fits desktop and phone', async ({ page }) => {
  await fixedCalendar(page, Array.from({ length: 6 }, (_, index) => makeTask({
    title: `合成任务${index + 1}：需要较长标题来验证窄屏显示`, planDate: '2026-11-07',
  })));
  const month = page.getByRole('region', { name: '月日历', exact: true });
  await month.getByRole('button', { name: '查看 2026-11-07 的全部 6 项任务', exact: true }).click();
  await expect(page.getByRole('region', { name: '当日任务', exact: true }).getByRole('button', { name: /^打开任务：/ })).toHaveCount(6);
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/verification/screenshots/calendar-month-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '周视图', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole('region', { name: '周日历', exact: true }).getByRole('button', { name: /^打开任务：/ })).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/verification/screenshots/calendar-week-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '月视图', exact: true }).click();
  }
});

test('calendar saves to the existing task, persists on reload, and keeps failed edits', async ({ page }) => {
  await page.goto('/?view=tasks');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  const title = `日历真实保存-${randomUUID()}`;
  const response = await page.request.post('/api/tasks', { headers, data: { title, planDate: '2026-11-07', dueDate: '2026-11-09' } });
  expect(response.ok()).toBe(true);
  const task: Task = await response.json();
  await page.goto('/?view=calendar');
  await page.getByLabel('定位日期', { exact: true }).fill('2026-11-07');
  const selected = page.getByRole('region', { name: '当日任务', exact: true });
  await selected.getByRole('button', { name: `打开任务：${title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '任务详情', exact: true });
  await dialog.getByLabel('个人计划日期', { exact: true }).fill('2026-11-08');
  await dialog.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(selected.getByRole('button', { name: `打开任务：${title}`, exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByLabel('定位日期', { exact: true }).fill('2026-11-08');
  await selected.getByRole('button', { name: `打开任务：${title}`, exact: true }).click();
  await expect(dialog.getByLabel('个人计划日期', { exact: true })).toHaveValue('2026-11-08');
  await dialog.getByLabel('本地硬截止日期', { exact: true }).fill('2026-11-10');
  await expect(dialog.getByRole('button', { name: '保存个人安排', exact: true })).toBeDisabled();
  await dialog.getByLabel('硬截止调整原因', { exact: true }).fill('合成日历调整原因');
  await page.route(`**/api/tasks/${task.id}`, route => route.fulfill({ status: 409, json: { error: '合成修订冲突，请重新读取' } }));
  await dialog.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('本地硬截止日期', { exact: true })).toHaveValue('2026-11-10');
  await page.unroute(`**/api/tasks/${task.id}`);
  await dialog.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('navigation', { name: '主要导航' }).getByRole('button', { name: '任务中心', exact: true }).click();
  await page.getByLabel('搜索任务', { exact: true }).fill(title);
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(dialog.getByLabel('个人计划日期', { exact: true })).toHaveValue('2026-11-08');
  await expect(dialog.getByLabel('本地硬截止日期', { exact: true })).toHaveValue('2026-11-10');
  const saved: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  expect(saved.filter(item => item.id === task.id)).toHaveLength(1);
});
