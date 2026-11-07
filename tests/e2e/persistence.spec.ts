import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

test("real task and prompt survive a closed browser context", async ({
  browser,
}) => {
  const suffix = Date.now();
  const taskTitle = `持久化任务-${suffix}`;
  const promptTitle = `持久化提示词-${suffix}`;
  const body =
    "第一行\n  保留缩进、空行与 {{placeholder}}\n\n最后一行 <tag> & value";
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  await page.getByLabel("任务标题").fill(taskTitle);
  await page.getByRole("checkbox", { name: /安排到今日/ }).check();
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("任务已保存");
  await page.getByRole("button", { name: "任务中心", exact: true }).click();
  await page.getByRole("button", { name: taskTitle, exact: true }).click();
  await page
    .getByLabel("任务描述", { exact: true })
    .fill("验证重开仍有实际保存内容");
  await page.getByRole("checkbox", { name: "设为当前专注" }).check();
  await page.getByRole("button", { name: "保存个人安排", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("个人安排已保存");
  await expect(page.getByRole("dialog", { name: "任务详情" })).toBeHidden();
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  await page.getByLabel("任务标题").fill(`${taskTitle}-并行行动`);
  await page.getByRole("checkbox", { name: /安排到今日/ }).check();
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("任务已保存");
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  await page.getByLabel("任务标题").fill(`${taskTitle}-第三项`);
  await page.getByRole("checkbox", { name: /安排到今日/ }).check();
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("任务已保存");
  await page.getByRole("button", { name: "提示词库", exact: true }).click();
  await page.getByRole("button", { name: "新建提示词", exact: true }).click();
  await page.getByLabel("提示词标题").fill(promptTitle);
  await page.getByLabel("提示词正文").fill(body);
  await page.getByRole("button", { name: "保存提示词", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("提示词已保存");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制已保存正文", exact: true }).click();
  // The system clipboard uses platform line endings; SQLite retains the original LF text.
  const clipboardBody = process.platform === 'win32' ? body.replace(/\n/g, '\r\n') : body;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(clipboardBody);
  await context.close();

  const reopened = await browser.newContext();
  const next = await reopened.newPage();
  await next.goto("/?view=tasks");
  await next.getByLabel("搜索任务").fill(taskTitle);
  await next.getByRole("button", { name: taskTitle, exact: true }).click();
  await expect(
    next.getByRole("textbox", { name: "任务描述", exact: true }),
  ).toHaveValue("验证重开仍有实际保存内容");
  await next.getByRole("button", { name: "关闭", exact: true }).click();
  await next.getByRole("button", { name: "提示词库", exact: true }).click();
  await next.getByLabel("搜索提示词").fill(promptTitle);
  await next.getByRole("button", { name: promptTitle, exact: true }).click();
  await expect(next.getByLabel("提示词正文")).toHaveValue(body);
  await reopened.close();
});

test("today renders without horizontal overflow at four target widths", async ({
  page,
}, testInfo) => {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "今日工作台", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const columns = await page.locator('.dashboard-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(width <= 700 ? 1 : 2);
    const focus = await page.getByTestId('key-tasks').boundingBox();
    const taskGrid = await page.locator('.dashboard-grid').boundingBox();
    expect(focus?.width).toBe(taskGrid?.width);
    const completed = await page.getByTestId('completed-today').boundingBox();
    expect(completed!.y).toBeGreaterThanOrEqual(taskGrid!.y + taskGrid!.height);
    const screenshot = await page.screenshot({
      path: testInfo.outputPath(`today-${width}.png`),
      fullPage: true,
    });
    await mkdir(".runtime/verification/screenshots", { recursive: true });
    await writeFile(
      `.runtime/verification/screenshots/today-${width}.png`,
      screenshot,
    );
  }
});
