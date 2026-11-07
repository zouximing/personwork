import { test, expect } from "@playwright/test";
test("private reclassification blocks review export and publication", async ({
  page,
}) => {
  const review = {
    id: "b6a804a7-ce5a-4bfa-b637-dc828811a2ca",
    revision: "e954c292-6551-4b26-b1aa-09f6e34c402e",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    title: "受保护回顾",
    kind: "week",
    start: "2026-11-02",
    end: "2026-11-08",
    selections: { taskIds: [], periodIds: [], riskIds: [], milestoneIds: [] },
    sections: {
      accomplishments: "本地仍可编辑的章节",
      progress: "",
      deviations: "",
      risks: "",
      nextPlan: "",
      support: "",
    },
    facts: [],
    versions: [],
    status: "draft",
    generator: "local-facts",
    excludedSensitiveCount: 1,
    differences: [],
    markdown: "已阻止导出",
    exportBlocked: true,
    exportWarning: "材料已重新标记为敏感，禁止导出",
  };
  await page.route("**/api/reviews", (route) =>
    route.fulfill({ json: { items: [review] } }),
  );
  await page.goto("/?view=review");
  await page.getByText("受保护回顾", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "复制已保存回顾", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "导出 Markdown", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存交付版本", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(review.exportWarning)).toBeVisible();
});
