import { useEffect, useState } from "react";
import { Save, CalendarDays, History, Plus } from "lucide-react";
import {
  statusLabels,
  statuses,
  priorities,
  priorityLabels,
  taskFields,
  type Task,
  type RecordEvent,
} from "../../../../packages/contracts/src/index";
import { api, errorText } from "../api";
import { AiDecompose } from "./AiAssist";
import {
  Button,
  ErrorNotice,
  Field,
  Modal,
  type Guard,
  type Notify,
} from "./ui";

export function QuickCapture({
  onClose,
  onSaved,
  guard,
  notify,
  today,
}: {
  onClose: () => void;
  onSaved: (task: Task) => void;
  guard: Guard;
  notify: Notify;
  today: string;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<"personal" | "management">(
    "personal",
  );
  const [planned, setPlanned] = useState(false);
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [status, setStatus] = useState<Task["status"]>("inbox");
  const [waitingFor, setWaitingFor] = useState("");
  const [waitingWhat, setWaitingWhat] = useState("");
  const [blockedReason, setBlockedReason] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const needsFollowUp = status === "waiting" || status === "blocked";
  const followUpIncomplete = needsFollowUp && (!waitingFor.trim() || !followUpDate || (status === "waiting" ? !waitingWhat.trim() : !blockedReason.trim()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(
    () => guard.dirty(!!title || category !== "personal" || planned || priority !== "medium" || status !== "inbox" || !!waitingFor || !!waitingWhat || !!blockedReason || !!followUpDate),
    [title, category, planned, priority, status, waitingFor, waitingWhat, blockedReason, followUpDate, guard],
  );
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const task = await api.createTask({
        title,
        category,
        priority,
        status,
        ...(planned ? { planDate: today } : {}),
        ...(needsFollowUp ? { waitingFor, followUpDate: followUpDate || null } : {}),
        ...(status === "waiting" ? { waitingWhat } : {}),
        ...(status === "blocked" ? { blockedReason } : {}),
      });
      onSaved(task);
      guard.dirty(false);
      notify("任务已保存");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="快速记录" onClose={() => guard.protect(onClose)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted">
          先记下来，再决定下一步。只填标题即可进入收件箱。
        </p>
        <ErrorNotice error={error} />
        <Field label="任务标题">
          <input
            autoFocus
            className="input"
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="有什么事需要推进？"
          />
        </Field>
        <Field label="任务分类">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
          >
            <option value="personal">日常工作</option>
            <option value="management">管理协作</option>
          </select>
        </Field>
        <div className="form-grid">
          <Field label="优先级">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
              {priorities.map((p) => <option key={p} value={p}>{priorityLabels[p]}</option>)}
            </select>
          </Field>
          <Field label="个人行动状态">
            <select value={status} onChange={(e) => setStatus(e.target.value as Task["status"])}>
              {statuses.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
            </select>
          </Field>
        </div>
        {needsFollowUp && (
          <>
            <Field label="等待对象 / 求助对象">
              <input className="input" value={waitingFor} maxLength={300} onChange={(e) => setWaitingFor(e.target.value)} />
            </Field>
            {status === "waiting" ? (
              <Field label="等待内容">
                <textarea className="input" value={waitingWhat} onChange={(e) => setWaitingWhat(e.target.value)} />
              </Field>
            ) : (
              <Field label="阻塞原因">
                <textarea className="input" value={blockedReason} onChange={(e) => setBlockedReason(e.target.value)} />
              </Field>
            )}
            <Field label="下次跟进 / 检查日期">
              <input className="input" type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
            </Field>
          </>
        )}
        <label className="check-line">
          <input
            type="checkbox"
            checked={planned}
            onChange={(e) => {
              setPlanned(e.target.checked);
              if (e.target.checked && status === "inbox") setStatus("todo");
            }}
          />
          安排到今日 · {today}
        </label>
        <div className="editor-actions">
          <Button onClick={() => guard.protect(onClose)}>取消</Button>
          <Button type="submit" primary disabled={!title.trim() || followUpIncomplete || busy}>
            {busy ? "正在保存…" : "保存任务"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const types: Record<string, string> = {
  task: "普通任务",
  bug: "Bug",
  feature: "功能",
  platform: "平台提效 / AI 基建",
  coordination: "协调 / 交办",
  people: "人员沟通",
  recruitment: "招聘",
  summary: "周期总结",
};
const validationLabels = {
  unverified: "未验证",
  pending: "待验证",
  passed: "验证通过",
  failed: "验证失败",
};
const deliveryLabels = {
  not_delivered: "未交付",
  pending: "待交付确认",
  delivered: "已交付",
};
export function TaskEditor({
  task,
  tasks,
  today,
  onSaved,
  onClose,
  onOpen,
  guard,
  notify,
}: {
  task: Task;
  tasks: Task[];
  today: string;
  onSaved: (task: Task) => void;
  onClose: () => void;
  onOpen: (task: Task) => void;
  guard: Guard;
  notify: Notify;
}) {
  const [draft, setDraft] = useState<Task>({ ...task });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<RecordEvent[] | null>(null);
  const [childTitle, setChildTitle] = useState("");
  const [aiDirty, setAiDirty] = useState(false);
  const [dateChangeReason, setDateChangeReason] = useState("");
  const deadlineChanged = !!task.dueDate && draft.dueDate !== task.dueDate;
  const dirty = JSON.stringify(draft) !== JSON.stringify(task);
  useEffect(
    () => guard.dirty(dirty || !!childTitle || aiDirty),
    [dirty, childTitle, aiDirty, guard],
  );
  const set = <K extends keyof Task>(name: K, value: Task[K]) =>
    setDraft((v) => ({ ...v, [name]: value }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const value = taskFields.parse(
        Object.fromEntries(
          Object.keys(taskFields.shape).map((key) => [
            key,
            draft[key as keyof Task],
          ]),
        ),
      );
      const saved = await api.patchTask(task.id, {
        ...value,
        revision: draft.revision,
        ...(deadlineChanged ? { dateChangeReason } : {}),
      });
      onSaved(saved);
      setDraft(saved);
      setDateChangeReason("");
      guard.dirty(false);
      notify("个人安排已保存");
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const addChild = async () => {
    setBusy(true);
    try {
      const saved = await api.createTask({
        title: childTitle,
        parentId: task.id,
        category: task.category,
        project: task.project,
      });
      onSaved(saved);
      setChildTitle("");
      notify("子任务已保存");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const loadHistory = async () => {
    try {
      setHistory((await api.history(task.id)).items);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const textField = (label: string, name: keyof Task, area = false) => (
    <Field label={label}>
      {area ? (
        <textarea
          className="input"
          value={String(draft[name] ?? "")}
          onChange={(e) => set(name, e.target.value as never)}
        />
      ) : (
        <input
          className="input"
          value={String(draft[name] ?? "")}
          onChange={(e) => set(name, e.target.value as never)}
        />
      )}
    </Field>
  );
  const dateField = (
    label: string,
    name: "planDate" | "dueDate" | "followUpDate" | "startDate",
  ) => (
    <Field label={label}>
      <input
        type="date"
        className="input"
        value={draft[name] || ""}
        onChange={(e) => set(name, e.target.value || null)}
      />
    </Field>
  );
  return (
    <Modal title="任务详情" wide onClose={() => guard.protect(onClose)}>
      <div className="task-detail">
        <ErrorNotice error={error} />
        {textField("任务标题", "title")}
        <div className="form-grid">
          <Field label="优先级">
            <select
              value={draft.priority}
              onChange={(e) => set("priority", e.target.value as Task["priority"])}
            >
              {priorities.map((p) => (
                <option key={p} value={p}>{priorityLabels[p]}</option>
              ))}
            </select>
          </Field>
          <Field label="个人行动状态">
            <select
              value={draft.status}
              onChange={(e) => set("status", e.target.value as Task["status"])}
            >
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="任务类型">
            <select
              value={draft.type}
              onChange={(e) => set("type", e.target.value as Task["type"])}
            >
              {Object.entries(types).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="任务分类">
            <select
              value={draft.category}
              onChange={(e) =>
                set("category", e.target.value as Task["category"])
              }
            >
              <option value="personal">日常工作</option>
              <option value="management">管理协作</option>
            </select>
          </Field>
        </div>
        <div className="notice">
          来源状态：{task.sourceState || "本地任务，无外部来源"}
          。个人行动、验证和交付分别记录。
        </div>
        {textField("任务描述", "nextAction", true)}
        <div className="form-grid three">
          {dateField("开始日期", "startDate")}
          {dateField("个人计划日期", "planDate")}
          {dateField("本地硬截止日期", "dueDate")}
          {dateField("下次跟进 / 检查日期", "followUpDate")}
        </div>
        {deadlineChanged && (
          <Field label="硬截止调整原因">
            <textarea
              className="input"
              value={dateChangeReason}
              onChange={(e) => setDateChangeReason(e.target.value)}
              placeholder="说明延期、提前或清除截止日期的依据；原因会保留在历史。"
            />
          </Field>
        )}
        <div className="row wrap">
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.focus}
              onChange={(e) => set("focus", e.target.checked)}
            />
            设为当前专注
          </label>
          <Button
            onClick={() => {
              set("planDate", today);
              if (draft.status === "inbox") set("status", "todo");
            }}
          >
            <CalendarDays size={14} />
            安排今日
          </Button>
        </div>
        {(draft.status === "waiting" || draft.status === "blocked") && (
          <div className="form-grid">
            {textField("等待谁 / 求助对象", "waitingFor")}
            {textField("等待什么", "waitingWhat", true)}
            {textField("阻塞原因", "blockedReason", true)}
          </div>
        )}
        {draft.status === "blocked" && (
          <p className="hint">
            阻塞需填写原因，并在“任务描述”记录解除动作，或在“等待谁 /
            求助对象”指定求助对象。
          </p>
        )}
        {["people", "recruitment"].includes(draft.type) && (
          <p className="notice">
            只记录脱敏行动与材料收集状态。敏感人员或候选人正文暂不在此持久保存，普通回顾默认排除此类任务。
          </p>
        )}
        {textField("个人备注（不自动回写来源）", "notes", true)}
        <details>
          <summary>
            子任务 · {tasks.filter((t) => t.parentId === task.id).length}
          </summary>
          {tasks
            .filter((t) => t.parentId === task.id)
            .map((t) => (
              <button
                key={t.id}
                className="linked-task"
                onClick={() => guard.protect(() => onOpen(t))}
              >
                {statusLabels[t.status]} · {t.title}
              </button>
            ))}
          <div className="row">
            <input
              className="input"
              aria-label="子任务标题"
              placeholder="添加一个明确的行动"
              value={childTitle}
              onChange={(e) => setChildTitle(e.target.value)}
            />
            <Button disabled={busy || !childTitle.trim()} onClick={addChild}>
              <Plus size={14} />
              保存子任务
            </Button>
          </div>
        </details>
        <details>
          <summary>归档与排序</summary>
          <div className="form-grid">
            <Field label="个人排序（数字越小越靠前）">
              <input
                type="number"
                className="input"
                value={draft.order}
                onChange={(e) => set("order", Number(e.target.value))}
              />
            </Field>
            <label className="check-line">
              <input
                type="checkbox"
                checked={draft.archived}
                onChange={(e) => set("archived", e.target.checked)}
              />
              归档（保留历史）
            </label>
          </div>
          {draft.archived &&
            textField("归档原因与后续安排", "archiveReason", true)}
        </details>
        <AiDecompose
          task={task}
          onTaskSaved={onSaved}
          onDirty={setAiDirty}
          notify={notify}
        />
        <div className="editor-actions sticky-actions">
          <Button
            primary
            onClick={save}
            disabled={
              busy ||
              !draft.title.trim() ||
              (deadlineChanged && !dateChangeReason.trim())
            }
          >
            <Save size={14} />
            {busy ? "正在保存…" : "保存个人安排"}
          </Button>
          <Button onClick={loadHistory}>
            <History size={14} />
            查看历史
          </Button>
          <span className="hint">
            {dirty ? "尚未保存" : "已保存"} · 来源与交付不会随个人完成自动改变
          </span>
        </div>
        {history && (
          <div className="history-list">
            <h3>变更历史</h3>
            {history.length ? (
              history.map((event) => (
                <div key={event.id}>
                  <time>{new Date(event.at).toLocaleString("zh-CN")}</time>
                  <strong>{event.kind}</strong>
                  <pre>{JSON.stringify(event.details, null, 2)}</pre>
                </div>
              ))
            ) : (
              <p className="muted">暂无历史记录</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
export { types as taskTypeLabels, validationLabels, deliveryLabels };
