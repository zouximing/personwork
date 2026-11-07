import type { Task } from "../../../packages/contracts/src/index";
import type { SourceObject } from "../../../packages/contracts/src/sources";

export type AttentionItem = {
  id: string;
  title: string;
  task?: Task;
  reasons: string[];
  date: string | null;
};
export function attentionItems(
  tasks: Task[],
  sources: SourceObject[],
  today: string,
): AttentionItem[] {
  const byId = new Map<string, AttentionItem>();
  for (const task of tasks) {
    if (task.archived || ["done", "cancelled"].includes(task.status)) continue;
    const reasons: string[] = [];
    if (task.dueDate && task.dueDate <= today)
      reasons.push(task.dueDate < today ? "硬截止已逾期" : "今日硬截止");
    if (task.planDate && task.planDate < today) reasons.push("个人计划已过期");
    if (task.followUpDate && task.followUpDate <= today)
      reasons.push(task.followUpDate < today ? "跟进日期已过" : "今日需跟进");
    if (task.status === "waiting")
      reasons.push(
        task.followUpDate ? "等待反馈" : "等待反馈，尚未安排跟进日期",
      );
    if (task.status === "blocked")
      reasons.push(
        task.blockedReason ? `阻塞：${task.blockedReason}` : "存在阻塞",
      );
    if (
      new Date(`${today}T00:00:00+08:00`).valueOf() -
        new Date(task.updatedAt).valueOf() >=
      7 * 86400000
    )
      reasons.push("超过 7 天未更新");
    if (reasons.length)
      byId.set(task.id, {
        id: task.id,
        title: task.title,
        task,
        reasons,
        date: task.followUpDate || task.dueDate || task.planDate,
      });
  }
  for (const source of sources) {
    const reasons: string[] = [];
    if (source.needsReview) reasons.push("MR 当前版本待复查");
    if (source.attentionReason) reasons.push(source.attentionReason);
    if (!reasons.length) continue;
    const task = tasks.find((t) => t.id === source.localTaskId);
    if (task && (task.archived || ["done", "cancelled"].includes(task.status)))
      continue;
    const id = task?.id || source.id;
    const previous = byId.get(id);
    byId.set(id, {
      id,
      title: task?.title || source.title,
      task,
      reasons: [...new Set([...(previous?.reasons || []), ...reasons])],
      date: previous?.date || source.followUpDate,
    });
  }
  return [...byId.values()].sort((a, b) =>
    (a.date || "9999").localeCompare(b.date || "9999"),
  );
}
