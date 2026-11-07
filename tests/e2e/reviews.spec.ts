import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { localDate, weekRange, shiftDate } from '../../packages/contracts/src/index';

test('new reviews preselect tasks by task dates and leave newly created out-of-period tasks unchecked', async ({ page }) => {
  const prefix = `回顾日期-${Date.now()}`;
  await page.goto('/?view=review');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  const today = localDate();
  const week = weekRange(today);
  const monday = week.slice(0, 10);
  const sunday = week.slice(-10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const monthOnly = monthStart < monday ? monthStart : monthEnd;
  for (const data of [
    { title: `${prefix}-周一起始`, planDate: monday },
    { title: `${prefix}-周日截止`, dueDate: sunday },
    { title: `${prefix}-本周开始`, startDate: today },
    { title: `${prefix}-仅在本月`, planDate: monthOnly },
    { title: `${prefix}-无日期` },
    { title: `${prefix}-过去`, planDate: `${Number(today.slice(0, 4)) - 1}-01-01` },
    { title: `${prefix}-未来`, planDate: `${Number(today.slice(0, 4)) + 1}-12-31` },
  ]) expect((await page.request.post('/api/tasks', { headers, data })).ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择周期与事实材料' });
  await dialog.getByRole('checkbox', { name: '下周计划', exact: true }).uncheck();
  const create = dialog.getByRole('button', { name: '创建事实草稿', exact: true });
  await expect(create).toBeEnabled();
  for (const suffix of ['周一起始', '周日截止', '本周开始']) await expect(dialog.getByRole('checkbox', { name: `${prefix}-${suffix}`, exact: true })).toBeChecked();
  for (const suffix of ['仅在本月', '无日期', '过去', '未来']) await expect(dialog.getByRole('checkbox', { name: `${prefix}-${suffix}`, exact: true })).not.toBeChecked();
  await dialog.getByLabel('周期类型').selectOption('month');
  await expect(create).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: `${prefix}-仅在本月`, exact: true })).toBeChecked();
  for (const suffix of ['无日期', '过去', '未来']) await expect(dialog.getByRole('checkbox', { name: `${prefix}-${suffix}`, exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: `${prefix}-无日期`, exact: true }).check();
  await create.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: '回顾报告', exact: true })).toHaveValue(new RegExp(`${prefix}-无日期`));
});

test('week and month preselect their items and save a concise editable report', async ({ page }) => {
  const prefix = `简报验证-${Date.now()}`;
  await page.goto('/?view=review');
  const session = await (await page.request.get('/api/session')).json();
  const today = localDate();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  for (const [suffix, status] of [['完成事项', 'done'], ['开发事项', 'doing'], ['待办事项', 'todo'], ['取消事项', 'cancelled']]) {
    const response = await page.request.post('/api/tasks', { headers, data: { title: `${prefix}-${suffix}`, status, planDate: today } });
    expect(response.ok()).toBe(true);
  }
  await page.reload();
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择周期与事实材料' });
  await dialog.getByRole('checkbox', { name: '下周计划', exact: true }).uncheck();
  const create = dialog.getByRole('button', { name: '创建事实草稿', exact: true });
  await expect(create).toBeEnabled();
  for (const suffix of ['完成事项', '开发事项', '待办事项']) await expect(dialog.getByRole('checkbox', { name: `${prefix}-${suffix}`, exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: `${prefix}-取消事项`, exact: true })).not.toBeChecked();
  await dialog.getByLabel('周期类型').selectOption('month');
  await expect(dialog.getByLabel('开始日期')).toHaveValue(`${today.slice(0, 7)}-01`);
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  await expect(dialog.getByLabel('结束日期')).toHaveValue(monthEnd);
  await expect(dialog.getByLabel('回顾标题')).toHaveValue(`${today.slice(0, 7)} 月回顾`);
  await expect(dialog.getByRole('checkbox', { name: `${prefix}-开发事项`, exact: true })).toBeChecked();
  await dialog.getByLabel('周期类型').selectOption('week');
  await expect(dialog.getByLabel('开始日期')).toHaveValue(weekRange(today).slice(0, 10));
  await expect(dialog.getByLabel('结束日期')).toHaveValue(weekRange(today).slice(-10));
  await expect(create).toBeEnabled();
  await dialog.getByRole('checkbox', { name: `${prefix}-待办事项`, exact: true }).uncheck();
  await dialog.getByLabel('回顾标题').fill(`${prefix}-周报`);
  await create.click();
  await expect(dialog).toBeHidden();
  const report = page.getByRole('textbox', { name: '回顾报告', exact: true });
  await expect(report).toBeVisible();
  const original = await report.inputValue();
  original.split('\n').forEach((line, index) => expect(line).toMatch(new RegExp(`^${index + 1}、`)));
  expect(original).toContain(`${prefix}-完成事项--完成`);
  expect(original).toContain(`${prefix}-开发事项--进行中`);
  expect(original).not.toContain(`${prefix}-待办事项`);
  expect(original).not.toContain(`${prefix}-取消事项`);
  const edited = original.replace(`${prefix}-开发事项--进行中`, `${prefix}-开发事项--进行中，正在联调`);
  await report.fill(edited);
  await page.route('**/api/reviews/*', async route => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 503, json: { error: '测试保存失败' } });
      await page.unroute('**/api/reviews/*');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存回顾', exact: true }).click();
  await expect(page.getByText('测试保存失败', { exact: true })).toBeVisible();
  await expect(report).toHaveValue(edited);
  await page.getByRole('button', { name: '保存回顾', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('回顾已保存');
  await page.getByRole('button', { name: '保存交付版本', exact: true }).click();
  await expect(page.getByRole('main').getByText('已保留交付版本 1', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const download = await downloadPromise;
  const exported = await readFile((await download.path())!, 'utf8');
  expect(exported).toContain(`${prefix}-开发事项--进行中，正在联调`);
  expect(exported).not.toMatch(/## 成果|事实来源|待补充/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制已保存回顾', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(exported.replace(/\r\n/g, '\n'));
  await page.reload();
  await page.getByText(`${prefix}-周报`, { exact: true }).click();
  await expect(report).toHaveValue(edited);
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/verification/screenshots/review-brief-${width}.png`, fullPage: true, animations: 'disabled' });
  }
});

test('month report handles selection failure, custom ranges and incomplete explanations', async ({ page }) => {
  const prefix = `月报验证-${Date.now()}`;
  await page.goto('/?view=review');
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.post('/api/tasks', { headers: { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin }, data: { title: prefix, status: 'todo', planDate: localDate() } });
  expect(response.ok()).toBe(true);
  await page.reload();
  await page.route('**/api/reviews/selections?*', route => route.fulfill({ status: 503, json: { error: '测试选材失败' } }));
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择周期与事实材料' });
  const create = dialog.getByRole('button', { name: '创建事实草稿', exact: true });
  await expect(dialog.getByText(/自动选取失败：测试选材失败/)).toBeVisible();
  await expect(create).toBeDisabled();
  await page.unroute('**/api/reviews/selections?*');
  await dialog.getByLabel('周期类型').selectOption('month');
  await expect(dialog.getByRole('checkbox', { name: prefix, exact: true })).toBeChecked();
  await dialog.getByLabel('结束日期').fill('2099-12-31');
  await dialog.getByLabel('开始日期').fill('2099-12-01');
  await expect(create).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: prefix, exact: true })).not.toBeChecked();
  await dialog.getByLabel('周期类型').selectOption('week');
  await dialog.getByLabel('周期类型').selectOption('month');
  await expect(dialog.getByRole('checkbox', { name: prefix, exact: true })).toBeChecked();
  await dialog.getByLabel('回顾标题').fill(prefix);
  await dialog.getByRole('checkbox', { name: '下周计划', exact: true }).uncheck();
  await create.click();
  const report = page.getByRole('textbox', { name: '回顾报告', exact: true });
  await expect(report).toHaveValue(new RegExp(`${prefix}--未完成`));
  (await report.inputValue()).split('\n').forEach((line, index) => expect(line).toMatch(new RegExp(`^${index + 1}、`)));
  await report.fill(`${prefix}--未完成，等待测试环境`);
  await page.getByRole('button', { name: '保存回顾', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('回顾已保存');
  await page.reload();
  await page.getByRole('button', { name: new RegExp(prefix) }).click();
  await expect(report).toHaveValue(`${prefix}--未完成，等待测试环境`);
});

test('unavailable material lists cannot submit invisible automatic selections', async ({ page }) => {
  await page.route('**/api/periods', route => route.fulfill({ status: 503, json: { error: '测试材料加载失败' } }));
  await page.route('**/api/reviews/selections?*', route => route.fulfill({ json: { taskIds: [], periodIds: ['00000000-0000-4000-8000-000000000001'], riskIds: [], milestoneIds: [] } }));
  await page.goto('/?view=review');
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择周期与事实材料' });
  await expect(dialog.getByRole('button', { name: '创建事实草稿', exact: true })).toBeDisabled();
  await expect(dialog.getByText(/材料列表读取失败/)).toBeVisible();
});

test('next-week plans default to scheduled unfinished tasks and retain independent numbering after edits and export', async ({ page }) => {
  const prefix = `下周计划-${Date.now()}`;
  await page.goto('/?view=review');
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': session.csrfToken, Origin: new URL(page.url()).origin };
  const week = weekRange(localDate());
  const nextMonday = shiftDate(week.slice(-10), 1);
  const nextSunday = shiftDate(nextMonday, 6);
  for (const data of [
    { title: `${prefix}-周一安排`, planDate: nextMonday },
    { title: `${prefix}-周日安排`, planDate: nextSunday },
    { title: `${prefix}-仅截止日期`, dueDate: nextMonday },
    { title: `${prefix}-已完成`, planDate: nextMonday, status: 'done' },
    { title: `${prefix}-手动补选` },
    { title: `${prefix}-跨年安排`, planDate: '2027-01-04' },
  ]) expect((await page.request.post('/api/tasks', { headers, data })).ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择周期与事实材料' });
  const create = dialog.getByRole('button', { name: '创建事实草稿', exact: true });
  const plan = dialog.getByRole('group', { name: '下周计划事项', exact: true });
  await expect(dialog.getByRole('checkbox', { name: '下周计划', exact: true })).toBeChecked();
  await expect(create).toBeEnabled();
  await expect(plan).toContainText(`${nextMonday} — ${nextSunday}`);
  for (const suffix of ['周一安排', '周日安排']) await expect(plan.getByRole('checkbox', { name: `下周计划：${prefix}-${suffix}`, exact: true })).toBeChecked();
  for (const suffix of ['仅截止日期', '手动补选']) await expect(plan.getByRole('checkbox', { name: `下周计划：${prefix}-${suffix}`, exact: true })).not.toBeChecked();
  await expect(plan.getByRole('checkbox', { name: `下周计划：${prefix}-已完成`, exact: true })).toHaveCount(0);
  await dialog.getByLabel('周期类型').selectOption('month');
  await dialog.getByLabel('结束日期').fill('2026-12-31');
  await expect(create).toBeEnabled();
  await expect(plan).toContainText('2027-01-04 — 2027-01-10');
  await expect(plan.getByRole('checkbox', { name: `下周计划：${prefix}-跨年安排`, exact: true })).toBeChecked();
  await dialog.getByLabel('周期类型').selectOption('week');
  await expect(create).toBeEnabled();
  await plan.getByRole('checkbox', { name: `下周计划：${prefix}-周日安排`, exact: true }).uncheck();
  await plan.getByRole('checkbox', { name: `下周计划：${prefix}-手动补选`, exact: true }).check();
  await dialog.getByLabel('回顾标题').fill(prefix);
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await plan.scrollIntoViewIfNeeded();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `.runtime/verification/screenshots/review-next-week-create-${width}.png`, fullPage: true, animations: 'disabled' });
  }
  await create.click();
  await expect(dialog).toBeHidden();
  const report = page.getByRole('textbox', { name: '回顾报告', exact: true });
  const original = await report.inputValue();
  const [retrospective, plans] = original.split('\n\n下周计划');
  retrospective.split('\n').slice(1).forEach((line, index) => expect(line).toMatch(new RegExp(`^${index + 1}、`)));
  plans.split('\n').slice(1).forEach((line, index) => expect(line).toMatch(new RegExp(`^${index + 1}、`)));
  expect(plans).toContain(`${prefix}-周一安排`);
  expect(plans).toContain(`${prefix}-手动补选`);
  expect(plans).not.toContain(`${prefix}-周日安排`);
  expect(plans).not.toContain(`${prefix}-仅截止日期`);
  expect(plans).not.toContain('--');
  await page.getByRole('button', { name: '保存交付版本', exact: true }).click();
  await expect(page.getByRole('main').getByText('已保留交付版本 1', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const exported = await readFile((await (await downloadPromise).path())!, 'utf8');
  expect(exported).toContain(original);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制已保存回顾', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(exported.replace(/\r\n/g, '\n'));
  await page.reload();
  await page.getByRole('button', { name: new RegExp(prefix) }).click();
  await expect(report).toHaveValue(original);
});

test('failed next-week selection blocks creation until plans are disabled', async ({ page }) => {
  await page.route('**/api/reviews/selections?*', route => new URL(route.request().url()).searchParams.get('purpose') === 'plan'
    ? route.fulfill({ status: 503, json: { error: '测试计划加载失败' } }) : route.continue());
  await page.goto('/?view=review');
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '选择周期与事实材料' });
  const create = dialog.getByRole('button', { name: '创建事实草稿', exact: true });
  await expect(dialog.getByText(/下周计划选取失败：测试计划加载失败/)).toBeVisible();
  await expect(create).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '下周计划', exact: true }).uncheck();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: '回顾报告', exact: true })).not.toHaveValue(/\n下周计划（/);
});
