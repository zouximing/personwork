import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('task priority and status survive editing and refresh, with filters and priority ordering', async ({ page }) => {
  const prefix = `优先级验证-${Date.now()}`;
  await page.goto('/?view=tasks');
  for (const [suffix, priority, status] of [['低', 'low', 'inbox'], ['中', 'medium', 'todo'], ['高', 'high', 'doing']]) {
    await page.getByRole('button', { name: '快速记录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '快速记录' });
    await dialog.getByLabel('任务标题', { exact: true }).fill(`${prefix}-${suffix}`);
    await expect(dialog.getByRole('combobox', { name: '优先级', exact: true })).toHaveValue('medium');
    await dialog.getByRole('combobox', { name: '优先级', exact: true }).selectOption(priority);
    await dialog.getByRole('checkbox', { name: /安排到今日/ }).check();
    await dialog.getByRole('combobox', { name: '个人行动状态', exact: true }).selectOption(status);
    await dialog.getByRole('button', { name: '保存任务', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await page.getByLabel('搜索任务').fill(prefix);
  await page.getByLabel('任务排序').selectOption('priority');
  await expect(page.locator('.task-list .task-title')).toHaveText([`${prefix}-高`, `${prefix}-中`, `${prefix}-低`]);
  const high = page.locator('.task-row').filter({ has: page.getByRole('button', { name: `${prefix}-高`, exact: true }) });
  await expect(high.getByText('高优先级', { exact: true })).toBeVisible();
  await expect(high.getByText('进行中', { exact: true })).toBeVisible();
  await page.getByLabel('筛选优先级').selectOption('low');
  await expect(page.locator('.task-list .task-title')).toHaveText([`${prefix}-低`]);
  await page.getByLabel('筛选个人状态').selectOption('doing');
  await expect(page.getByText('没有找到匹配的任务', { exact: true })).toBeVisible();
  await page.getByLabel('筛选优先级').selectOption('all');
  await expect(page.locator('.task-list .task-title')).toHaveText([`${prefix}-高`]);
  await page.getByRole('button', { name: `${prefix}-高`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '任务详情' });
  await expect(editor.getByRole('combobox', { name: '优先级', exact: true })).toHaveValue('high');
  await editor.getByRole('combobox', { name: '优先级', exact: true }).selectOption('low');
  await editor.getByRole('combobox', { name: '个人行动状态', exact: true }).selectOption('todo');
  await editor.getByRole('checkbox', { name: '设为当前专注' }).check();
  await editor.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('个人安排已保存');
  await expect(editor).toBeHidden();
  await page.reload();
  await page.getByLabel('搜索任务').fill(`${prefix}-高`);
  await expect(page.locator('.task-list .task-row').getByText('低优先级', { exact: true })).toBeVisible();
  await expect(page.locator('.task-list .task-row').getByText('待处理', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '今日工作', exact: true }).click();
  const today = page.locator('.dashboard-grid .dashboard-task').filter({ has: page.getByRole('button', { name: `${prefix}-高`, exact: true }) });
  await expect(today.getByText('低优先级', { exact: true })).toBeVisible();
  await expect(today.getByText('待处理', { exact: true })).toBeVisible();
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(today.getByText('低优先级', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/verification/screenshots/task-priority-today-${width}.png`, fullPage: true, animations: 'disabled' });
    if (width === 390) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('button', { name: '任务中心', exact: true }).click();
    await page.getByLabel('搜索任务').fill(prefix);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390) {
      const filterWidths = await page.locator('.filter-row select').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
      expect(filterWidths.every(controlWidth => controlWidth >= 150)).toBe(true);
    }
    await page.screenshot({ path: `.runtime/verification/screenshots/task-priority-list-${width}.png`, fullPage: true, animations: 'disabled' });
    if (width === 390) await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('button', { name: '今日工作', exact: true }).click();
  }
});

test('quick capture requires follow-up details for waiting and blocked states', async ({ page }) => {
  await page.goto('/?view=tasks');
  for (const status of ['waiting', 'blocked']) {
    await page.getByRole('button', { name: '快速记录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '快速记录' });
    await dialog.getByLabel('任务标题', { exact: true }).fill(`跟进状态验证-${status}-${Date.now()}`);
    await dialog.getByRole('combobox', { name: '个人行动状态', exact: true }).selectOption(status);
    const save = dialog.getByRole('button', { name: '保存任务', exact: true });
    await expect(save).toBeDisabled();
    await dialog.getByLabel('等待对象 / 求助对象', { exact: true }).fill('测试协作者');
    await dialog.getByLabel('下次跟进 / 检查日期', { exact: true }).fill('2026-11-09');
    if (status === 'waiting') await dialog.getByLabel('等待内容', { exact: true }).fill('确认测试反馈');
    else await dialog.getByLabel('阻塞原因', { exact: true }).fill('等待测试环境');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).toBeHidden();
  }
});
