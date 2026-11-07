import { test, expect, type Page } from '@playwright/test';
import type { Task, TaskInput } from '../../packages/contracts/src/index';

async function createTask(page: Page, fields: TaskInput) {
  await page.goto('/?view=tasks');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  const response = await page.request.post('/api/tasks', { headers, data: fields });
  expect(response.ok()).toBe(true);
  const task: Task = await response.json();
  await page.reload();
  await page.getByRole('button', { name: task.title, exact: true }).click();
  return { task, headers, dialog: page.getByRole('dialog', { name: '任务详情' }) };
}

test('task details close after saving and preserve hidden legacy fields when reopened', async ({ page }) => {
  const title = `详情保存-${Date.now()}`;
  const { task, dialog } = await createTask(page, {
    title,
    nextAction: '旧行动继续作为任务描述',
    project: '合成存量项目',
    expectedResult: '合成存量预期结果',
    validation: 'passed',
    validationNote: '合成存量验证依据',
    delivery: 'delivered',
    deliveryNote: '合成存量交付说明',
  });
  await dialog.getByLabel('任务标题', { exact: true }).fill(`${title}-已更新`);
  await dialog.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toContainText('个人安排已保存');
  await page.reload();
  await page.getByRole('button', { name: `${title}-已更新`, exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue('旧行动继续作为任务描述');
  await dialog.getByRole('textbox', { name: '任务描述', exact: true }).fill('新的任务描述');
  await dialog.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: `${title}-已更新`, exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue('新的任务描述');
  const saved: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  expect(saved.find(item => item.id === task.id)).toMatchObject({
    title: `${title}-已更新`, nextAction: '新的任务描述', project: '合成存量项目',
    expectedResult: '合成存量预期结果', validation: 'passed', validationNote: '合成存量验证依据',
    delivery: 'delivered', deliveryNote: '合成存量交付说明',
  });
});

test('task details expose description without project, expected result or result and validation inputs', async ({ page }, testInfo) => {
  const { dialog } = await createTask(page, { title: `详情字段-${Date.now()}`, status: 'blocked', blockedReason: '合成阻塞', nextAction: '协调测试环境', waitingFor: '合成协作者', followUpDate: '2026-11-09' });
  await expect(dialog.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue('协调测试环境');
  for (const label of ['项目 / 专题', '预期结果', '验证依据', '交付说明', '下一步行动']) {
    await expect(dialog.getByRole('textbox', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(dialog.getByRole('combobox', { name: '验证结论', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: '交付结论', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('结果与验证', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/阻塞需填写原因，并在“任务描述”记录解除动作/)).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath(`task-details-${width}.png`), fullPage: true, animations: 'disabled' });
  }
});

test('a real revision conflict keeps task details and unsaved input open', async ({ page }) => {
  const title = `详情冲突-${Date.now()}`;
  const { task, headers, dialog } = await createTask(page, { title, nextAction: '原任务描述' });
  await dialog.getByLabel('任务标题', { exact: true }).fill(`${title}-未保存`);
  await dialog.getByRole('textbox', { name: '任务描述', exact: true }).fill('未保存的任务描述');
  const changed = await page.request.patch(`/api/tasks/${task.id}`, { headers, data: { revision: task.revision, notes: '合成并发更新' } });
  expect(changed.ok()).toBe(true);
  await dialog.getByRole('button', { name: '保存个人安排', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('任务标题', { exact: true })).toHaveValue(`${title}-未保存`);
  await expect(dialog.getByRole('textbox', { name: '任务描述', exact: true })).toHaveValue('未保存的任务描述');
  const saved: Task[] = (await (await page.request.get('/api/bootstrap')).json()).tasks;
  expect(saved.find(item => item.id === task.id)).toMatchObject({ title, notes: '合成并发更新' });
});
