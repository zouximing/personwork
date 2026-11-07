import { test, expect } from "@playwright/test";
import { taskFields } from "../../packages/contracts/src/index";

test.use({ channel: "chrome" });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        tasks: [],
        prompts: [],
        sources: [],
        today: "2026-11-07",
        week: "2026-11-02 — 2026-11-08",
        timezone: "Asia/Shanghai",
        dataDir: "test-data",
        stage: "test",
      },
    }),
  );
});

test("empty workbench shows real empty states and can open quick capture", async ({
  page,
}) => {
  await page.route("**/api/dashboard", async route => {
    const response = await route.fetch(); const value = await response.json();
    await route.fulfill({ json: { ...value, keyTasks: [], keyCandidates: [], todayTodos: [], inProgress: [], waiting: [], nearDue: [], overdue: [], inboxCount: 0, completedToday: [], mrPendingCount: 0, mrOverdueCount: 0, mrItems: [], lineAlerts: [], reminders: [] } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "今日工作台" }),
  ).toBeVisible();
  await expect(page.getByText("今天没有待办任务")).toBeVisible();
  await page.getByRole("button", { name: "快速记录", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "快速记录" })).toBeVisible();
});

test("one item combines deadline and waiting reminder reasons", async ({ page }) => {
  const { csrfToken } = await (await page.request.get('/api/session')).json();
  const title = `需要统一跟进的任务-${Date.now()}`;
  await page.request.post('/api/tasks', { headers: { 'X-Workbench-CSRF': csrfToken }, data: { title, status: 'waiting', waitingFor: '代号A', waitingWhat: '合成反馈', followUpDate: '2026-11-05', dueDate: '2026-11-06' } });
  await page.goto('/');
  const reminders = page.locator('.dashboard-reminders');
  await expect(reminders.getByText(title, { exact: true })).toHaveCount(1);
  await expect(reminders.locator('button').filter({ hasText: title })).toContainText('硬截止已逾期');
  await expect(reminders.locator('button').filter({ hasText: title })).toContainText('等待 代号A');
});

test("changing an existing hard deadline requires a reason", async ({
  page,
}) => {
  const task = {
    ...taskFields.parse({ title: "日期调整任务", dueDate: "2026-11-08" }),
    id: "4d760140-b055-4a10-84ef-111daea0ab29",
    revision: "e954c292-6551-4b26-b1aa-09f6e34c402e",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    sourceState: null,
  };
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        tasks: [task],
        prompts: [],
        sources: [],
        today: "2026-11-07",
        week: "2026-11-02 — 2026-11-08",
        timezone: "Asia/Shanghai",
        dataDir: "test-data",
        stage: "test",
      },
    }),
  );
  await page.goto("/?view=tasks");
  await page.getByRole("button", { name: "日期调整任务", exact: true }).click();
  await page.getByLabel("本地硬截止日期", { exact: true }).fill("2026-11-09");
  await expect(page.getByLabel("硬截止调整原因")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存个人安排", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("硬截止调整原因").fill("需要额外一天核对");
  await expect(
    page.getByRole("button", { name: "保存个人安排", exact: true }),
  ).toBeEnabled();
});

test("source numbers search the corresponding personal action", async ({
  page,
}) => {
  const task = {
    ...taskFields.parse({ title: "来源关联的个人行动" }),
    id: "4d760140-b055-4a10-84ef-111daea0ab29",
    revision: "e954c292-6551-4b26-b1aa-09f6e34c402e",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    sourceState: "开发中",
  };
  const source = {
    id: "b6a804a7-ce5a-4bfa-b637-dc828811a2ca",
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    provider: "pingcode",
    instanceId: task.id,
    projectId: "1",
    projectName: "测试项目",
    externalId: "42",
    number: "PC-42",
    title: task.title,
    url: "https://example.invalid/task/42",
    sourceState: "开发中",
    sourceStateId: "doing",
    sourceDueDate: null,
    sourcePriority: "",
    author: "",
    assigneeId: "",
    currentSha: null,
    checkedSha: null,
    reviewStatus: "not_started",
    conclusion: "",
    followUpDate: null,
    needsReview: false,
    reviewAssignmentChanged: false,
    assignedToMe: false,
    attentionReason: "",
    localTaskId: task.id,
    lastSeenAt: task.updatedAt,
    sourceUpdatedAt: null,
    linkedSourceIds: [],
  };
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        tasks: [task],
        prompts: [],
        sources: [],
        today: "2026-11-07",
        week: "2026-11-02 — 2026-11-08",
        timezone: "Asia/Shanghai",
        dataDir: "test-data",
        stage: "test",
      },
    }),
  );
  await page.route("**/api/source-records", (route) =>
    route.fulfill({ json: { items: [source] } }),
  );
  await page.goto("/?view=tasks");
  await page.getByLabel("搜索任务").fill("PC-42");
  await expect(
    page.getByRole("button", { name: task.title, exact: true }),
  ).toBeVisible();
});

test("failed prompt save retains input and protects unsaved navigation", async ({
  page,
}) => {
  await page.route("**/api/prompts", (route) =>
    route.fulfill({ status: 503, json: { error: "磁盘暂不可用" } }),
  );
  await page.goto("/?view=prompts");
  await page.getByRole("button", { name: "新建提示词" }).click();
  await page.getByLabel("提示词标题").fill("保留的草稿");
  await page.getByLabel("提示词正文").fill("第一行\n  保留缩进 {{value}}");
  await page.getByRole("button", { name: "保存提示词" }).click();
  await expect(page.getByRole("alert")).toContainText("磁盘暂不可用");
  await expect(page.getByLabel("提示词正文")).toHaveValue(
    "第一行\n  保留缩进 {{value}}",
  );
  await page.getByRole("button", { name: "今日工作", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "内容尚未保存" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑" }).click();
  await expect(page.getByLabel("提示词标题")).toHaveValue("保留的草稿");
});

test("clipboard fallback contains the most recently saved prompt body", async ({
  page,
}) => {
  const prompt = {
    id: "b6a804a7-ce5a-4bfa-b637-dc828811a2ca",
    revision: "e954c292-6551-4b26-b1aa-09f6e34c402e",
    title: "已保存模板",
    tag: "",
    body: "保存的正文\n  {{变量}}",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
  };
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({
      json: {
        tasks: [],
        prompts: [prompt],
        sources: [],
        today: "2026-11-07",
        week: "2026-11-02 — 2026-11-08",
        timezone: "Asia/Shanghai",
        dataDir: "test-data",
        stage: "test",
      },
    }),
  );
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  await page.goto("/?view=prompts");
  await page.getByRole("button", { name: "已保存模板", exact: true }).click();
  await page.getByLabel("提示词正文").fill("还没保存的新正文");
  await page.getByRole("button", { name: "复制已保存正文" }).click();
  await expect(page.getByLabel("手工复制正文")).toHaveValue(
    "保存的正文\n  {{变量}}",
  );
});

test("mobile workbench does not overflow horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "今日工作台" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("management can capture a line without invented initial records", async ({
  page,
}) => {
  await page.goto("/?view=manage");
  await page.getByRole("button", { name: "新建产线" }).first().click();
  await page.getByLabel("产线名称").fill(`前端测试线-${Date.now()}`);
  await page.getByRole("button", { name: "保存记录" }).click();
  await expect(page.getByRole("status")).toContainText("已保存");
});

test("manual review can preserve a published version", async ({ page }) => {
  // Keep the displayed material list consistent with the real automatic selections.
  await page.unroute("**/api/bootstrap");
  await page.goto("/?view=review");
  await page.getByRole("button", { name: "新建回顾" }).click();
  await page.getByLabel("回顾标题").fill(`前端周回顾-${Date.now()}`);
  await page.getByRole("button", { name: "创建事实草稿" }).click();
  await page.getByLabel("回顾报告").fill("部署核对--进行中，需要协助核对真实部署边界");
  await page.getByRole("button", { name: "保存回顾", exact: true }).click();
  await page.getByRole("button", { name: "保存交付版本" }).click();
  await expect(
    page.getByRole("main").getByText("已保留交付版本 1"),
  ).toBeVisible();
});

test("model configuration is editable without claiming tested capabilities", async ({
  page,
}) => {
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "模型配置", exact: true }).click();
  await page.getByRole("button", { name: "新增模型配置" }).click();
  await page.getByLabel("配置名称").fill("未连接本地模型");
  await expect(
    page.getByText("保存配置不会标记文本或工具能力通过"),
  ).toBeVisible();
});

test("execution requires a concrete plan before authorization", async ({
  page,
}) => {
  await page.goto("/?view=executions");
  await page.getByRole("button", { name: "新建执行计划" }).click();
  await expect(page.getByLabel("执行指令")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建待授权计划" }),
  ).toBeDisabled();
});

test("MR view keeps empty source state explicit", async ({ page }) => {
  await page.route("**/api/source-records", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto("/?view=tasks");
  await page.getByRole("button", { name: "MR 评审", exact: true }).click();
  await expect(page.getByText("还没有同步到 MR")).toBeVisible();
});

test("local snapshot recovery requires an explicit confirmation", async ({
  page,
}) => {
  await page.route("**/api/backups/snapshots", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            name: "2026-11-07.protected",
            savedAt: "2026-11-07T00:00:00Z",
            bytes: 2048,
          },
        ],
      },
    }),
  );
  await page.goto("/?view=settings");
  await page.getByRole("button", { name: "数据与备份", exact: true }).click();
  await page.getByRole("button", { name: "恢复此快照", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "确认恢复本机快照" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
