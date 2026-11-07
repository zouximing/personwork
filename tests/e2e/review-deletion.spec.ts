import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

async function fixture(page: Page, published = false) {
  await page.goto('/?view=review');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  const title = `删除验证-${Date.now()}`;
  const taskResponse = await page.request.post('/api/tasks', { headers, data: { title: `${title}-保留任务` } });
  expect(taskResponse.ok()).toBe(true);
  const task = await taskResponse.json();
  const created = await page.request.post('/api/reviews', { headers, data: { title, kind: 'week', start: '2026-11-02', end: '2026-11-08', selections: { taskIds: [task.id] } } });
  expect(created.ok()).toBe(true);
  let review = await created.json();
  if (published) {
    const response = await page.request.post(`/api/reviews/${review.id}/publish`, { headers, data: { revision: review.revision } });
    expect(response.ok()).toBe(true);
    review = await response.json();
  }
  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  return { review, headers, task };
}

test('cancel, close and Escape preserve the review and unsaved input without a delete request', async ({ page }) => {
  const { review } = await fixture(page);
  const report = page.getByRole('textbox', { name: '回顾报告', exact: true });
  const edited = '1、合成事项--进行中，尚未保存的补充';
  await report.fill(edited);
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'DELETE') requests.push(request.url()); });
  const dialog = page.getByRole('dialog', { name: '删除回顾' });
  for (const close of ['cancel', 'close', 'escape']) {
    await page.getByRole('button', { name: '删除回顾', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(review.title);
    await expect(dialog).toContainText('未保存');
    if (close === 'escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: close === 'cancel' ? '取消' : '关闭', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(report).toHaveValue(edited);
  }
  expect(requests).toEqual([]);
  const saved = (await (await page.request.get('/api/reviews')).json()).items.find((item: { id: string }) => item.id === review.id);
  expect(saved.revision).toBe(review.revision);
  expect(saved.reportBody).toBe(review.reportBody);
});

test('delete failure and revision conflicts retain input and require another confirmation after reloading', async ({ page }) => {
  const { review, headers } = await fixture(page);
  const report = page.getByRole('textbox', { name: '回顾报告', exact: true });
  const edited = '1、合成事项--未完成，保留本地输入';
  await report.fill(edited);
  await page.getByRole('button', { name: '删除回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除回顾' });
  await page.route(`**/api/reviews/${review.id}`, async route => {
    if (route.request().method() === 'DELETE') await route.fulfill({ status: 503, json: { error: '合成删除失败' } });
    else await route.continue();
  });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('合成删除失败');
  await expect(report).toHaveValue(edited);
  expect((await (await page.request.get('/api/reviews')).json()).items.some((item: { id: string }) => item.id === review.id)).toBe(true);
  await page.unroute(`**/api/reviews/${review.id}`);
  const updated = await page.request.patch(`/api/reviews/${review.id}`, { headers, data: { revision: review.revision, title: `${review.title}-其他窗口已修改` } });
  expect(updated.ok()).toBe(true);
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('更新');
  await expect(report).toHaveValue(edited);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  page.once('dialog', prompt => prompt.accept());
  await page.reload();
  await page.getByRole('button', { name: new RegExp(`${review.title}-其他窗口已修改`) }).click();
  await page.getByRole('button', { name: '删除回顾', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toContainText('回顾已删除');
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(review.title) })).toHaveCount(0);
});

test('confirms deletion of a published review, blocks duplicate submission and retains its task', async ({ page }) => {
  const { review, task } = await fixture(page, true);
  await page.getByRole('button', { name: '删除回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除回顾' });
  await expect(dialog).toContainText('交付版本');
  await expect(dialog).toContainText('无法直接撤销');
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/verification/screenshots/review-delete-confirm-${width}.png`, fullPage: true, animations: 'disabled' });
  }
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/reviews/${review.id}`, async route => {
    if (route.request().method() === 'DELETE') { await pending; await route.continue(); }
    else await route.continue();
  });
  const deleting = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(review.id));
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await deleting;
  await expect(dialog.getByRole('button', { name: '正在删除…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toContainText('回顾已删除');
  await expect(page.getByRole('textbox', { name: '回顾报告', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(review.title) })).toHaveCount(0);
  expect((await (await page.request.get('/api/reviews')).json()).items.some((item: { id: string }) => item.id === review.id)).toBe(false);
  expect((await (await page.request.get('/api/tasks')).json()).items.some((item: { id: string }) => item.id === task.id)).toBe(true);
});
