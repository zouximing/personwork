import { useState } from "react";
import { Search, Plus, Check, CalendarDays } from "lucide-react";
import {
  statusLabels,
  statuses,
  priorities,
  priorityLabels,
  priorityOrder,
  type Task,
  type TaskPatch,
} from "../../../../packages/contracts/src/index";
import { Button, Empty, PageHeading, Modal, Field, ErrorNotice, type Guard, type Notify } from "../components/ui";
import { api, errorText } from "../api";
import { taskTypeLabels } from "../components/TaskEditor";
import { sourceNumber, sourceAssignmentLabel, type SourceObject } from "../../../../packages/contracts/src/sources";

export function TaskRow({
  task,
  onOpen,
  onComplete,
  source,
}: {
  task: Task;
  onOpen: (task: Task) => void;
  onComplete?: (task: Task) => void;
  source?: SourceObject;
}) {
  return (
    <article className="task-row">
      <button
        className={`task-check ${task.status === "done" ? "done" : ""}`}
        aria-label={
          task.status === "done" ? `重开 ${task.title}` : `完成 ${task.title}`
        }
        onClick={() => onComplete?.(task)}
        disabled={!onComplete}
      >
        {task.status === "done" && <Check size={12} />}
      </button>
      <div className="grow">
        <button
          className={`task-title ${task.status === "done" ? "done" : ""}`}
          onClick={() => onOpen(task)}
        >
          {task.title}
        </button>
        <div className="task-meta">
          <span className={`badge ${task.priority === "high" ? "red" : task.priority === "medium" ? "amber" : ""}`}>
            {priorityLabels[task.priority]}优先级
          </span>
          <span className="badge">{taskTypeLabels[task.type]}</span>
          {source && (
            <span>
              {source.provider === "gitlab" ? "GitLab" : "PingCode"} ·{" "}
              {sourceNumber(source)}
            </span>
          )}
          {source && sourceAssignmentLabel(source) && (
            <span className="badge green">{sourceAssignmentLabel(source)}</span>
          )}
          {task.project && <span>{task.project}</span>}
          {task.planDate && (
            <span>
              <CalendarDays size={11} /> {task.planDate}
            </span>
          )}
          {task.sourceState && <span>来源：{task.sourceState}</span>}
        </div>
        <p className="task-next">
          {task.nextAction || "补充下一步，让行动更清楚"}
        </p>
      </div>
      <span
        className={`badge ${task.status === "blocked" ? "red" : task.status === "waiting" ? "amber" : task.status === "doing" ? "blue" : ""}`}
      >
        {statusLabels[task.status]}
      </span>
    </article>
  );
}
export function Tasks({
  tasks,
  onOpen,
  onCapture,
  onComplete,
  initialQuery = "",
  sourceRecords = [],
  today, onSaved, onDeleted, guard, notify,
}: {
  tasks: Task[];
  onOpen: (task: Task) => void;
  onCapture: () => void;
  onComplete: (task: Task) => void;
  initialQuery?: string;
  sourceRecords?: SourceObject[];
  today: string;
  onSaved: (task: Task) => void;
  onDeleted: (id: string) => void;
  guard: Guard;
  notify: Notify;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(() => {
    const value = new URLSearchParams(location.search).get("status");
    return statuses.includes(value as Task["status"]) ? value! : "all";
  });
  const [priority, setPriority] = useState("all");
  const [type, setType] = useState("all");
  const [project, setProject] = useState("all");
  const [showArchive, setShowArchive] = useState(false);
  const [sort, setSort] = useState("order");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [changing, setChanging] = useState<{ task: Task; status: 'waiting' | 'blocked'; waitingFor: string; waitingWhat: string; blockedReason: string; nextAction: string; followUpDate: string } | null>(null);
  async function update(task: Task, patch: Omit<TaskPatch, 'revision'>) {
    setBusy(true); setError("");
    try {
      onSaved(await api.patchTask(task.id, { ...patch, revision: task.revision }));
      if (changing) { setChanging(null); guard.dirty(false); }
      notify("任务已更新");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  function changeStatus(task: Task, status: Task['status']) {
    setError("");
    if (status === 'waiting' || status === 'blocked') {
      setChanging({ task, status, waitingFor: task.waitingFor, waitingWhat: task.waitingWhat, blockedReason: task.blockedReason, nextAction: task.nextAction, followUpDate: task.followUpDate || '' });
      guard.dirty(true);
    } else void update(task, { status });
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true); setError("");
    try {
      await api.deleteTask(deleting.id, { revision: deleting.revision, confirm: true });
      onDeleted(deleting.id); setDeleting(null); notify("任务已永久删除");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  const sourceMap = new Map(
    sourceRecords.filter((s) => s.localTaskId).map((s) => [s.localTaskId, s]),
  );
  const filtered = tasks
    .filter(
      (t) =>
        t.archived === showArchive &&
        (status === "all" || t.status === status) &&
        (priority === "all" || t.priority === priority) &&
        (type === "all" || t.type === type) &&
        (project === "all" || t.project === project) &&
        (sourceFilter === "all" ||
          (sourceFilter === "local"
            ? !sourceMap.has(t.id)
            : sourceMap.get(t.id)?.provider === sourceFilter)) &&
        `${t.title} ${t.nextAction} ${t.project} ${t.notes} ${t.sourceState || ""} ${sourceMap.has(t.id) ? sourceNumber(sourceMap.get(t.id)!) : ""} ${sourceMap.get(t.id)?.projectName || ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "date"
        ? (a.planDate || "9999").localeCompare(b.planDate || "9999")
        : sort === "priority"
          ? priorityOrder[a.priority] - priorityOrder[b.priority] || a.order - b.order
        : sort === "updated"
          ? b.updatedAt.localeCompare(a.updatedAt)
          : a.order - b.order,
    );
  return (
    <>
      <PageHeading
        eyebrow="TASK CENTER"
        title="每项工作，都有下一步。"
        description="研发、人员、招聘、交办与周期任务统一跟进。个人安排与来源事实分别保留。"
      >
        <Button primary onClick={onCapture}>
          <Plus size={15} />
          快速记录
        </Button>
      </PageHeading>
      <div className="filter-row">
        <label className="search-box">
          <Search size={16} />
          <input
            aria-label="搜索任务"
            placeholder="搜索标题、任务描述、来源编号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="筛选任务来源"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          <option value="all">全部来源</option>
          <option value="local">本地记录</option>
          <option value="pingcode">PingCode</option>
          <option value="gitlab">GitLab</option>
        </select>
        <select
          aria-label="筛选个人状态"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">全部状态</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选优先级"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          <option value="all">全部优先级</option>
          {priorities.map((p) => (
            <option key={p} value={p}>{priorityLabels[p]}</option>
          ))}
        </select>
        <select
          aria-label="筛选类型"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="all">全部类型</option>
          {Object.entries(taskTypeLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="筛选项目"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="all">全部项目</option>
          {[...new Set(tasks.map((t) => t.project).filter(Boolean))].map(
            (value) => (
              <option key={value}>{value}</option>
            ),
          )}
        </select>
        <select
          aria-label="任务排序"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="order">个人排序</option>
          <option value="priority">优先级：高到低</option>
          <option value="date">计划日期</option>
          <option value="updated">最近更新</option>
        </select>
        <label className="check-line">
          <input
            type="checkbox"
            checked={showArchive}
            onChange={(e) => setShowArchive(e.target.checked)}
          />
          归档
        </label>
      </div>
      <div className="section-heading">
        <h2>
          {showArchive ? "已归档" : "行动清单"}{" "}
          <span className="count">{filtered.length}</span>
        </h2>
      </div>
      {!deleting && !changing && <ErrorNotice error={error} />}
      <div className="task-list task-table" aria-label="行动清单">
        {!!filtered.length && <div className="task-list-head" aria-hidden="true"><span>任务 / 任务描述</span><span>优先级</span><span>状态</span><span>计划日期</span><span>快捷操作</span></div>}
        {filtered.length ? (
          filtered.map((task) => (
            <article key={task.id} className="task-row task-list-item">
              <div className="task-list-main">
                <button className={`task-check ${task.status === "done" ? "done" : ""}`} aria-label={task.status === "done" ? `重开 ${task.title}` : `完成 ${task.title}`} disabled={busy} onClick={() => onComplete(task)}>{task.status === "done" && <Check size={12} />}</button>
                <div className="grow">
                  <button className={`task-title ${task.status === "done" ? "done" : ""}`} onClick={() => onOpen(task)}>{task.title}</button>
                  <p className="task-next">{task.nextAction || "待补充任务描述"}</p>
                  {sourceMap.has(task.id) && <span className="task-meta">{sourceMap.get(task.id)!.provider === 'gitlab' ? 'GitLab' : 'PingCode'} · {sourceNumber(sourceMap.get(task.id)!)} {sourceAssignmentLabel(sourceMap.get(task.id)!)}</span>}
                </div>
              </div>
              <span className={`badge ${task.priority === 'high' ? 'red' : task.priority === 'medium' ? 'amber' : ''}`}>{priorityLabels[task.priority]}优先级</span>
              <span className={`badge ${task.status === 'blocked' ? 'red' : task.status === 'waiting' ? 'amber' : task.status === 'doing' ? 'blue' : ''}`}>{statusLabels[task.status]}</span>
              <span className="task-list-date">{task.planDate || '未安排'}</span>
              <div className="task-list-actions">
                <Button disabled={busy || ['done', 'cancelled'].includes(task.status) || task.planDate === today} aria-label={`安排今日 ${task.title}`} onClick={() => void update(task, { planDate: today, ...(task.status === 'inbox' ? { status: 'todo' } : {}) })}>安排今日</Button>
                <select aria-label={`修改状态 ${task.title}`} value={task.status} disabled={busy} onChange={e => changeStatus(task, e.target.value as Task['status'])}>{statuses.map(value => <option key={value} value={value}>改为{statusLabels[value]}</option>)}</select>
                <Button className="danger-text" disabled={busy} aria-label={`删除 ${task.title}`} onClick={() => { setError(''); setDeleting(task); }}>删除</Button>
              </div>
            </article>
          ))
        ) : (
          <Empty
            title={
              query || status !== "all" || priority !== "all" || type !== "all" || project !== "all" || sourceFilter !== "all"
                ? "没有找到匹配的任务"
                : "让第一项工作，有个着落"
            }
            action={<Button onClick={onCapture}>记录一项任务</Button>}
          >
            已保存的本地任务和同步后的来源任务会显示在这里。
          </Empty>
        )}
      </div>
      {deleting && <Modal title="永久删除任务" onClose={() => { if (!busy) { setDeleting(null); setError(''); } }}>
        <p>确认永久删除“{deleting.title}”？</p>
        <p className="muted">任务及操作历史将清除，无法恢复。子任务会保留并解除关联。历史回顾、备份和导出副本仍保留；来源再次同步或周期重新生成时可能重新出现。</p>
        <ErrorNotice error={error} />
        <div className="form-actions"><Button disabled={busy} onClick={() => { setDeleting(null); setError(''); }}>取消</Button><Button className="danger-text" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '确认永久删除'}</Button></div>
      </Modal>}
      {changing && <Modal title="修改任务状态" onClose={() => { if (!busy) guard.protect(() => { setChanging(null); setError(''); guard.dirty(false); }); }}>
        <form onSubmit={e => { e.preventDefault(); void update(changing.task, { status: changing.status, waitingFor: changing.waitingFor, waitingWhat: changing.waitingWhat, blockedReason: changing.blockedReason, nextAction: changing.nextAction, followUpDate: changing.followUpDate || null }); }}>
          <p>{changing.task.title} · {statusLabels[changing.status]}</p>
          {changing.status === 'waiting' ? <><Field label="等待对象"><input required value={changing.waitingFor} onChange={e => setChanging({ ...changing, waitingFor: e.target.value })} /></Field><Field label="等待内容"><textarea required value={changing.waitingWhat} onChange={e => setChanging({ ...changing, waitingWhat: e.target.value })} /></Field></> : <><Field label="阻塞原因"><textarea required value={changing.blockedReason} onChange={e => setChanging({ ...changing, blockedReason: e.target.value })} /></Field><Field label="任务描述"><textarea required={!changing.waitingFor.trim()} value={changing.nextAction} onChange={e => setChanging({ ...changing, nextAction: e.target.value })} /></Field></>}
          <Field label="下次跟进日期"><input required type="date" value={changing.followUpDate} onChange={e => setChanging({ ...changing, followUpDate: e.target.value })} /></Field>
          <ErrorNotice error={error} />
          <div className="form-actions"><Button disabled={busy} onClick={() => guard.protect(() => { setChanging(null); setError(''); guard.dirty(false); })}>取消</Button><Button primary type="submit" disabled={busy}>{busy ? '正在保存…' : '保存状态'}</Button></div>
        </form>
      </Modal>}
    </>
  );
}
