import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { localDate } from '../../packages/contracts/src/index';
import { cycleRange } from '../../packages/contracts/src/production';
import type { Line, Period, Risk } from '../../packages/contracts/src/management';
import type { Task } from '../../packages/contracts/src/index';

async function post<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const { csrfToken } = await (await request.get('/api/session')).json();
  const response = await request.post(`/api${path}`, { headers: { 'X-Workbench-CSRF': csrfToken }, data });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
async function fixture(page: Page) {
  const date = localDate(); const [start, end] = cycleRange('month', date); const [ws, we] = cycleRange('week', date);
  const line = await post<Line>(page.request, '/lines', { name: `产线回归-${Date.now()}`, owner: '代号A' });
  const monthly = await post<Period>(page.request, '/periods', { kind: 'month', lineId: line.id, title: '月交付回归', start, end, completion: 30, notes: '保留备注' });
  const weekly = await post<Period>(page.request, '/periods', { kind: 'week', lineId: line.id, title: '本周回归重点', start: ws, end: we, monthlyId: monthly.id, progressStatus: 'at_risk', actual: '等待验证环境' });
  const risk = await post<Risk>(page.request, '/risks', { title: '高等级回归风险', lineIds: [line.id], level: 'high', escalated: true, targetCloseDate: date });
  return { line, monthly, weekly, risk, date, ws, we };
}

test('rechecks current privacy before copying or exporting an already open production report', async ({ page, context }) => {
  const f = await fixture(page);
  const task = await post<Task>(page.request, '/tasks', { title: '隐私状态变化回归' });
  const { csrfToken } = await (await page.request.get('/api/session')).json();
  const headers = { 'X-Workbench-CSRF': csrfToken };
  expect((await page.request.patch(`/api/periods/${f.weekly.id}`, { headers, data: { revision: f.weekly.revision, taskIds: [task.id] } })).ok()).toBe(true);
  const title = `隐私周报-${Date.now()}`;
  await post(page.request, '/reviews', { title, kind: 'week', start: f.ws, end: f.we, format: 'brief' });
  await page.goto('/?view=review'); await page.getByText(title, { exact: true }).click();
  const other = await context.newPage();
  await other.goto('/?view=review'); await other.getByText(title, { exact: true }).click();
  let downloads = 0; page.on('download', () => downloads++); other.on('download', () => downloads++);
  await page.route('**/api/reviews/*', route => route.fulfill({ status: 503, json: { error: '隐私核验暂时不可用' } }));
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  await expect(page.getByText('隐私核验暂时不可用', { exact: true })).toBeVisible();
  expect(downloads).toBe(0); await page.unroute('**/api/reviews/*');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('未导出哨兵'));
  expect((await page.request.patch(`/api/tasks/${task.id}`, { headers, data: { revision: task.revision, type: 'people' } })).ok()).toBe(true);
  await page.getByRole('button', { name: '复制已保存回顾', exact: true }).click();
  await expect(page.getByRole('button', { name: '导出 Markdown', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('未导出哨兵');
  await other.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  await expect(other.getByRole('button', { name: '导出 Markdown', exact: true })).toBeDisabled();
  expect(downloads).toBe(0); await other.close();
  expect((await page.request.patch(`/api/lines/${f.line.id}`, { headers, data: { revision: f.line.revision, archived: true } })).ok()).toBe(true);
});

test('production cards, monthly and weekly forms, risk filters and report section persist', async ({ page }, testInfo) => {
  const f = await fixture(page);
  await page.goto('/?view=manage');
  const card = page.getByTestId(`production-card-${f.line.id}`);
  await expect(card).toContainText('本月重点完成率');
  await expect(card).toContainText('0%'); await expect(card).toContainText('有风险 1');
  await card.getByRole('button', { name: `${f.line.name} 查看详情`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `${f.line.name} · 产线详情` })).toBeVisible();
  await page.getByRole('combobox', { name: '重点周期', exact: true }).selectOption('month');
  await page.getByRole('button', { name: '月交付回归', exact: true }).click();
  await expect(page.getByLabel('完成度（%）')).toHaveValue('30');
  await page.getByLabel('备注', { exact: true }).fill('月目标确认备注');
  await page.getByLabel('月重点状态').selectOption('done');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('monthly-completion')).toContainText('100%');
  await page.getByRole('combobox', { name: '重点周期', exact: true }).selectOption('week');
  await page.getByRole('button', { name: '本周回归重点', exact: true }).click();
  await page.getByLabel('进展状态', { exact: true }).selectOption('blocked');
  await page.getByLabel('进展说明', { exact: true }).fill('等待合成环境，需协调');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByTestId(`period-${f.weekly.id}`)).toContainText('受阻');
  await page.reload();
  await page.getByTestId(`production-card-${f.line.id}`).getByRole('button', { name: `${f.line.name} 查看详情`, exact: true }).click();
  await expect(page.getByTestId(`period-${f.weekly.id}`)).toContainText('等待合成环境，需协调');
  await page.getByRole('button', { name: '与上周对比', exact: true }).click();
  await expect(page.getByTestId('previous-week')).toBeVisible();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const shot = await page.screenshot({ path: testInfo.outputPath(`production-${width}.png`), fullPage: true, animations: 'disabled' });
    await mkdir('.runtime/verification/screenshots', { recursive: true });
    await writeFile(`.runtime/verification/screenshots/production-${width}.png`, shot);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '风险与问题', exact: true }).click();
  await page.getByRole('combobox', { name: '风险产线' }).selectOption(f.line.id);
  await page.getByRole('combobox', { name: '风险等级' }).selectOption('high');
  const riskCard = page.getByTestId(`risk-${f.risk.id}`);
  await expect(riskCard).toHaveClass(/risk-warning/); await expect(riskCard).toContainText('已升级');
  await page.getByRole('combobox', { name: '风险等级' }).selectOption('low');
  await expect(riskCard).toHaveCount(0);
  await page.getByRole('combobox', { name: '风险等级' }).selectOption('high');
  await riskCard.getByRole('button', { name: '更新处置 / 关闭' }).click();
  await expect(page.getByLabel('目标闭环日期')).toHaveValue(f.date);
  await page.getByLabel('风险状态').selectOption('closed');
  await page.getByLabel('关闭结果（关闭必填）').fill('合成风险解决');
  await page.getByLabel('关闭依据与残余影响（关闭必填）').fill('合成检查通过');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(riskCard).not.toHaveClass(/risk-warning/);
  await page.goto('/?view=review');
  await page.getByRole('button', { name: '新建回顾', exact: true }).click();
  await page.getByLabel('回顾标题').fill(`产线周报-${Date.now()}`);
  await page.getByRole('button', { name: '创建事实草稿', exact: true }).click();
  await expect(page.getByLabel('回顾报告')).toContainText('产线进展');
  await expect(page.getByLabel('回顾报告')).toContainText('闭环：高等级回归风险');
  // Archive only this test's synthetic line so later browser cases retain capacity.
  const { csrfToken } = await (await page.request.get('/api/session')).json();
  await page.request.patch(`/api/lines/${f.line.id}`, { headers: { 'X-Workbench-CSRF': csrfToken }, data: { revision: f.line.revision, archived: true } });
});

test('homepage displays high-risk alerts and failed weekly saves retain entered progress', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/');
  const warning = page.locator('.dashboard-alert-item').filter({ hasText: f.risk.title });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveClass(/risk-warning/);
  await page.goto('/?view=manage');
  await page.getByTestId(`production-card-${f.line.id}`).getByRole('button', { name: `${f.line.name} 查看详情`, exact: true }).click();
  await page.getByRole('button', { name: '本周回归重点', exact: true }).click();
  await page.getByLabel('进展说明', { exact: true }).fill('失败后保留说明');
  await page.route(`**/api/periods/${f.weekly.id}`, route => route.fulfill({ status: 409, json: { error: '合成修订冲突' } }));
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByText('合成修订冲突', { exact: true })).toBeVisible();
  await expect(page.getByLabel('进展说明', { exact: true })).toHaveValue('失败后保留说明');
  const { csrfToken } = await (await page.request.get('/api/session')).json();
  await page.request.patch(`/api/lines/${f.line.id}`, { headers: { 'X-Workbench-CSRF': csrfToken }, data: { revision: f.line.revision, archived: true } });
});

test('three production cards, monthly batch carry, weekly leftovers and period navigation work', async ({ page }, testInfo) => {
  const date = localDate(); const [ms] = cycleRange('month', date); const [ws] = cycleRange('week', date);
  const prevMonthDate = new Date(`${ms}T12:00:00Z`); prevMonthDate.setUTCDate(prevMonthDate.getUTCDate() - 1);
  const [pmStart, pmEnd] = cycleRange('month', prevMonthDate.toISOString().slice(0, 10));
  const prevWeekDate = new Date(`${ws}T12:00:00Z`); prevWeekDate.setUTCDate(prevWeekDate.getUTCDate() - 1);
  const [pwStart, pwEnd] = cycleRange('week', prevWeekDate.toISOString().slice(0, 10));
  const lines = await Promise.all(['甲', '乙', '丙'].map(name => post<Line>(page.request, '/lines', { name: `合成三线${name}`, reminderWeekday: 5 })));
  for (let i = 0; i < 6; i++) await post<Period>(page.request, '/periods', { lineId: lines[0].id, kind: 'month', start: pmStart, end: pmEnd, title: `上月遗留${i}` });
  await post<Period>(page.request, '/periods', { lineId: lines[0].id, kind: 'month', start: pmStart, end: pmEnd, title: '上月完成不结转', status: 'done' });
  const oldWeek = await post<Period>(page.request, '/periods', { lineId: lines[0].id, kind: 'week', start: pwStart, end: pwEnd, title: '上周遗留回归' });
  await page.goto('/?view=manage');
  await expect(page.locator('[data-testid^="production-card-"]')).toHaveCount(3);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.evaluate(() => window.scrollTo(0, 0));
  const overviewShot = await page.screenshot({ path: testInfo.outputPath('production-overview-1440.png'), fullPage: true, animations: 'disabled' });
  await mkdir('.runtime/verification/screenshots', { recursive: true });
  await writeFile('.runtime/verification/screenshots/production-overview-1440.png', overviewShot);
  await page.getByRole('button', { name: `${lines[0].name} 查看详情`, exact: true }).click();
  await expect(page.getByText('上周遗留回归 · 尚未结转，待安排')).toBeVisible();
  await page.getByRole('button', { name: '一键结转上周未完成项', exact: true }).click();
  await expect(page.getByText('上周遗留回归 · 已结转本周')).toBeVisible();
  const persisted = await (await page.request.get('/api/periods')).json() as { items: Period[] };
  const carried = persisted.items.filter(p => p.carriedFromId === oldWeek.id);
  expect(carried).toHaveLength(1);
  await page.getByRole('button', { name: '一键结转上周未完成项', exact: true }).click();
  await expect(page.getByTestId(`period-${carried[0].id}`)).toBeVisible();
  await page.getByRole('button', { name: '下周', exact: true }).click();
  await expect(page.getByTestId(`period-${carried[0].id}`)).toHaveCount(0);
  await page.getByRole('button', { name: '回到本期', exact: true }).click();
  await page.getByRole('combobox', { name: '重点周期', exact: true }).selectOption('month');
  await page.getByRole('button', { name: '一键结转上月未完成项', exact: true }).click();
  await expect(page.getByText('本月已超过建议的5条重点，可继续登记，建议聚焦。')).toBeVisible();
  await expect(page.getByRole('button', { name: '上月完成不结转', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '上月遗留0', exact: true }).click();
  await expect(page.getByLabel('完成度（%）')).toHaveValue('0');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const { csrfToken } = await (await page.request.get('/api/session')).json();
  for (const line of lines) await page.request.patch(`/api/lines/${line.id}`, { headers: { 'X-Workbench-CSRF': csrfToken }, data: { revision: line.revision, archived: true } });
});
