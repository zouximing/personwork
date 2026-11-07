import { test, expect, type Page } from '@playwright/test';
import { sourceObjectSchema } from '../../packages/contracts/src/sources';

async function seed(page: Page, input: object) {
  const { csrfToken } = await (await page.request.get('/api/session')).json();
  const response = await page.request.post('/api/tasks', { headers: { 'X-Workbench-CSRF': csrfToken }, data: input });
  expect(response.ok()).toBe(true); return response.json();
}
test('dashboard selects up to three keys, completes tasks and links to the inbox and MR tab', async ({ page }) => {
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push(await seed(page, { title: `首页合成要事${i}` }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日工作台', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置要事', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置今日要事' });
  for (let i = 1; i <= 3; i++) await dialog.getByRole('checkbox', { name: `首页合成要事${i}`, exact: false }).check();
  await expect(dialog.getByRole('checkbox', { name: '首页合成要事4', exact: false })).toBeDisabled();
  await dialog.getByRole('button', { name: '保存要事', exact: true }).click();
  await expect(dialog).toBeHidden();
  const keys = page.getByTestId('key-tasks');
  await expect(keys.getByRole('heading', { name: '今日要事（3/3）' })).toBeVisible();
  await keys.getByRole('article').filter({ hasText: '首页合成要事1' }).getByRole('button', { name: '完成', exact: true }).click();
  await expect(keys.getByRole('heading', { name: '今日要事（2/3）' })).toBeVisible();
  await expect(page.getByTestId('completed-today').getByText('首页合成要事1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /收件箱未整理/ }).click();
  await expect(page.getByLabel('筛选个人状态')).toHaveValue('inbox');
  await page.goto('/'); await page.getByRole('button', { name: /待评审 MR.*项积压/ }).click();
  await expect(page.locator('.task-tabs button.active')).toHaveText('MR 评审');
});
test('waiting followup copies editable text and global shortcut captures from another page', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seed(page, { title: '首页合成等待', status: 'waiting', waitingFor: '代号A', waitingWhat: '合成资料', followUpDate: '2026-11-01' });
  await page.goto('/');
  const waiting = page.getByTestId('waiting-tasks');
  await waiting.getByRole('button', { name: '催办', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '催办文案' });
  await dialog.getByLabel('催办内容').fill('【催办】合成可编辑文案');
  await dialog.getByRole('button', { name: '复制催办文案' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('【催办】合成可编辑文案');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '内容尚未保存' })).toBeVisible();
  await page.getByRole('button', { name: '放弃修改并离开' }).click();
  await page.getByRole('button', { name: '提示词库', exact: true }).click();
  await page.keyboard.press('Control+Alt+n');
  const capture = page.getByRole('dialog', { name: '快速记录' });
  await capture.getByLabel('任务标题', { exact: true }).fill('首页合成快捷键捕获');
  await capture.getByLabel('任务标题', { exact: true }).press('Enter');
  await expect(capture).toBeHidden();
  await page.goto('/capture');
  await expect(page.getByRole('button', { name: /首页合成快捷键捕获/ })).toBeVisible();
  await page.getByRole('main').getByLabel('一句话任务', { exact: true }).fill('首页合成连续捕获');
  await page.getByRole('main').getByLabel('一句话任务', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: /首页合成连续捕获/ })).toBeVisible();
});
test('dashboard shows errors without fake empty success and supports narrow screens and reminder settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/dashboard', route => route.fulfill({ status: 503, json: { error: '合成聚合读取失败' } }));
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: '合成聚合读取失败' })).toBeVisible();
  await page.unroute('**/api/dashboard');
  await page.getByRole('button', { name: '重新读取首页' }).click();
  await expect(page.getByTestId('key-tasks')).toBeVisible();
  await page.getByRole('button', { name: '打开提醒' }).click();
  await expect(page.getByRole('dialog', { name: '全部提醒' })).toBeVisible();
  await page.getByRole('dialog', { name: '全部提醒' }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: '.runtime/verification/screenshots/dashboard-1440.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.runtime/verification/screenshots/dashboard-390.png', fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '系统设置', exact: true }).click();
  await page.getByRole('button', { name: '提醒设置', exact: true }).click();
  await page.getByLabel('截止提前提醒天数').fill('3');
  await page.getByRole('button', { name: '保存提醒设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('提醒设置已保存');
  await page.reload();
  await page.getByRole('button', { name: '提醒设置', exact: true }).click();
  await expect(page.getByLabel('截止提前提醒天数')).toHaveValue('3');
});

test('reminders poll every minute and system notifications deduplicate without disclosing reminder content', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const calls: { title: string; body?: string }[] = [];
    Object.defineProperty(window, 'notificationCalls', { value: calls });
    Object.defineProperty(window, 'Notification', { value: class {
      static permission = 'granted';
      constructor(title: string, options?: { body?: string }) { calls.push({ title, body: options?.body }); }
    } });
  });
  let calls = 0;
  await page.route('**/api/reminders', route => { calls++; return route.fulfill({ json: { browserNotify: true, items: [{ id: 'synthetic-notification', targetId: 'fixture', types: ['waiting_overdue'], level: 'danger', title: '合成私人标题', detail: '不应出现在系统通知的正文', link: '?view=today' }] } }); });
  await page.goto('/');
  await expect(page.getByTestId('key-tasks')).toBeVisible();
  await expect.poll(() => calls).toBeGreaterThan(0);
  const previous = calls;
  await page.clock.runFor(60001);
  await expect.poll(() => calls).toBeGreaterThan(previous);
  const notifications = await page.evaluate(() => (window as unknown as { notificationCalls: { title: string; body?: string }[] }).notificationCalls);
  expect(notifications).toEqual([{ title: '工作台有需要关注的事项', body: '请打开工作台查看提醒。' }]);
});

test('failed key updates preserve selection and capture page keeps rejected input', async ({ page }) => {
  await seed(page, { title: '合成冲突候选' });
  await page.goto('/');
  await page.getByRole('button', { name: '设置要事', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置今日要事' });
  await dialog.getByRole('checkbox', { name: /合成冲突候选/ }).check();
  await page.route('**/api/dashboard/key-tasks', route => route.fulfill({ status: 409, json: { error: '合成修订冲突' } }));
  await dialog.getByRole('button', { name: '保存要事' }).click();
  await expect(dialog.getByRole('alert')).toContainText('合成修订冲突');
  await expect(dialog.getByRole('checkbox', { name: /合成冲突候选/ })).toBeChecked();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并离开' }).click();
  await page.route('**/api/tasks', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: '合成保存失败' } }) : route.continue());
  await expect(page.locator('.sidebar').getByLabel('一句话任务')).toHaveCount(0);
  await page.getByRole('button', { name: '快速捕获', exact: true }).click();
  const capturePage = page.getByRole('main');
  await capturePage.getByLabel('一句话任务').fill('合成失败保留');
  await capturePage.getByLabel('一句话任务').press('Enter');
  await expect(capturePage.getByRole('alert')).toContainText('合成保存失败');
  await expect(capturePage.getByLabel('一句话任务')).toHaveValue('合成失败保留');
  let prompted = false;
  page.once('dialog', async dialog => { prompted = dialog.type() === 'beforeunload'; await dialog.dismiss(); });
  await page.reload({ waitUntil: 'commit', timeout: 1000 }).catch(() => {});
  expect(prompted).toBe(true);
  await expect(capturePage.getByLabel('一句话任务')).toHaveValue('合成失败保留');
});

test('reminder navigation updates detail targets while staying on the management page', async ({ page }) => {
  const first = 'e71a0e4b-ad5e-4ef4-9b6b-e27f7b5fd6ba';
  const id = 'e71a0e4b-ad5e-4ef4-9b6b-e27f7b5fd6be';
  await page.route('**/api/lines', route => route.fulfill({ json: { items: [{ id: first, name: '合成产线A', archived: false }, { id, name: '合成产线B', archived: false }] } }));
  await page.route('**/api/production', route => route.fulfill({ json: { lines: [{ id: first, name: '合成产线A', archived: false }, { id, name: '合成产线B', archived: false }], publicPeriodIds: [], publicRiskIds: [], summaries: [], date: '2026-11-07' } }));
  await page.route('**/api/reminders', route => route.fulfill({ json: { browserNotify: false, items: [{ id: 'synthetic-line', targetId: id, types: ['line_weekly_update'], level: 'danger', title: '合成产线定位', detail: '请核对', link: `?view=manage&line=${id}` }] } }));
  await page.goto(`/?view=manage&line=${first}`);
  await expect(page.getByRole('heading', { name: '合成产线A · 产线详情' })).toBeVisible();
  await page.getByRole('button', { name: '打开提醒' }).click();
  await page.getByRole('dialog', { name: '全部提醒' }).getByRole('button', { name: /合成产线定位/ }).click();
  await expect(page).toHaveURL(new RegExp(`line=${id}`));
  await expect(page.getByRole('heading', { name: '合成产线B · 产线详情' })).toBeVisible();
  await page.getByRole('button', { name: '返回产线总览' }).click();
  await page.getByRole('button', { name: '打开提醒' }).click();
  await page.getByRole('dialog', { name: '全部提醒' }).getByRole('button', { name: /合成产线定位/ }).click();
  await expect(page.getByRole('heading', { name: '合成产线B · 产线详情' })).toBeVisible();
});

test('reminder navigation opens another MR while staying on the MR tab', async ({ page }) => {
  const first = 'e71a0e4b-ad5e-4ef4-9b6b-e27f7b5fd6ba';
  const second = 'e71a0e4b-ad5e-4ef4-9b6b-e27f7b5fd6be';
  const items = [first, second].map((id, index) => sourceObjectSchema.parse({ id, revision: id, createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', provider: 'gitlab', instanceId: first, projectId: '1', projectName: '合成项目', externalId: String(index + 1), number: String(index + 1), title: `合成MR${index + 1}`, url: 'https://gitlab.invalid/1', sourceState: 'opened', sourceStateId: 'opened', sourceDueDate: null, sourcePriority: '', author: '合成', assigneeId: '', currentSha: null, checkedSha: null, reviewStatus: 'not_started', conclusion: '', followUpDate: null, needsReview: false, reviewAssignmentChanged: false, assignedToMe: true, assignedAsReviewer: true, attentionReason: '', localTaskId: null, lastSeenAt: '2026-11-06T00:00:00Z', sourceUpdatedAt: null }));
  await page.route('**/api/source-records', route => route.fulfill({ json: { items } }));
  await page.route('**/api/reminders', route => route.fulfill({ json: { browserNotify: false, items: [{ id: 'synthetic-mr', targetId: second, types: ['mr_backlog'], level: 'danger', title: '合成MR定位', detail: '请核对', link: `?view=tasks&tab=mr&source=${second}` }] } }));
  await page.goto(`/?view=tasks&tab=mr&source=${first}`);
  await expect(page.getByRole('dialog', { name: '合成MR1', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '合成MR1', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '打开提醒' }).click();
  await page.getByRole('dialog', { name: '全部提醒' }).getByRole('button', { name: /合成MR定位/ }).click();
  await expect(page.getByRole('dialog', { name: '合成MR2', exact: true })).toBeVisible();
  await expect(page.locator('.task-tabs button.active')).toHaveText('MR 评审');
  await page.getByRole('dialog', { name: '合成MR2', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '打开提醒' }).click();
  await page.getByRole('dialog', { name: '全部提醒' }).getByRole('button', { name: /合成MR定位/ }).click();
  await expect(page.getByRole('dialog', { name: '合成MR2', exact: true })).toBeVisible();
});
