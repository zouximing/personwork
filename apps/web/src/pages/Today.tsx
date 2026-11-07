import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Flag, GitPullRequest, Inbox, Layers3, Plus } from "lucide-react";
import { priorityLabels, statusLabels, type Task } from "../../../../packages/contracts/src/index";
import type { Dashboard } from "../../../../packages/contracts/src/dashboard";
import { riskLevelLabels } from "../../../../packages/contracts/src/production";
import { api, errorText, request } from "../api";
import { Busy, Button, CopyButton, Empty, ErrorNotice, Field, Modal, PageHeading, Section, type Guard, type Notify } from "../components/ui";

export function Today({ tasks, onOpen, onSaved, onReload, onCapture, onNavigate, guard, notify }: {
  tasks: Task[]; onOpen: (task: Task) => void; onSaved: (task: Task) => void;
  onReload: () => Promise<void>; onCapture: () => void; onNavigate: (target: string) => void; guard: Guard; notify: Notify;
}) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [chase, setChase] = useState<Task | null>(null);
  const [chaseText, setChaseText] = useState("");
  const load = useCallback(async () => {
    try { setData(await request<Dashboard>("/dashboard")); setError(""); }
    catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => {
    let active = true;
    void request<Dashboard>("/dashboard").then(value => { if (active) { setData(value); setError(""); } }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [tasks]);
  const action = async (task: Task, changes: { status?: Task["status"]; keyDate?: null | string }) => {
    setBusy(true); setError("");
    try {
      const saved = "keyDate" in changes
        ? await request<Task>(`/tasks/${task.id}/key`, { method: "POST", body: JSON.stringify({ revision: task.revision, isKey: !!changes.keyDate, date: data?.date }) })
        : await api.patchTask(task.id, { revision: task.revision, ...changes });
      onSaved(saved); notify("任务已更新");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  if (!data) return error ? <><ErrorNotice error={error} /><Button onClick={load}>重新读取首页</Button></> : <Busy>正在读取今日工作台…</Busy>;
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(`${data.date}T12:00:00+08:00`));
  const chaseInitial = (task: Task) => `【催办】${task.title} —— ${task.waitingWhat}（预期回复 ${task.followUpDate || "未设置"}）`;
  const cards = (items: Task[], mode: "todo" | "doing" | "waiting" | "due" | "key") => items.map(task => (
    <article className={`dashboard-task ${mode === "key" ? "key-task" : ""}`} key={task.id}>
      <div className="row between"><button className="task-title" onClick={() => onOpen(task)}>{task.title}</button><span className={`badge ${task.priority === "high" ? "red" : ""}`}>{priorityLabels[task.priority]}优先级</span></div>
      <p className="card-description">{task.nextAction || "点击任务补充描述与下一步"}</p>
      <div className="task-meta"><span>{task.category === "personal" ? "个人任务" : "管理"}</span><span>{statusLabels[task.status]}</span>{task.dueDate && <span className={task.dueDate < data.date ? "danger-text" : ""}>截止 {task.dueDate}{task.dueDate < data.date ? " · 已超期" : task.dueDate === data.date ? " · 今天到期" : ""}</span>}</div>
      {task.status === "waiting" && <p className={task.followUpDate && task.followUpDate < data.date ? "danger-text" : "hint"}>等待 {task.waitingFor} · {task.waitingWhat}<br />预期回复 {task.followUpDate}{task.followUpDate && task.followUpDate < data.date ? " · 已超期" : ""}</p>}
      <div className="inline-actions">
        <Button disabled={busy} onClick={() => void action(task, { status: "done" })}><Check size={13} />完成</Button>
        {(mode === "todo" || mode === "key") && ["todo", "inbox"].includes(task.status) && <Button disabled={busy} onClick={() => void action(task, { status: "doing" })}>开始</Button>}
        {mode === "todo" && task.keyDate !== data.date && <Button disabled={busy || data.keyTasks.length >= 3} onClick={() => void action(task, { keyDate: data.date })}><Flag size={13} />设为要事</Button>}
        {mode === "key" && <Button disabled={busy} onClick={() => void action(task, { keyDate: null })}>移出要事</Button>}
        {mode === "waiting" && <Button onClick={() => { setChase(task); setChaseText(chaseInitial(task)); }}>催办</Button>}
      </div>
    </article>
  ));
  return <>
    <PageHeading eyebrow={`${data.date} ${weekday}`} title="今日工作台" description="每日开工：确定今日三件要事，处理临期/超期与等待超期事项"><Button onClick={() => onNavigate("?view=review")}>工作回顾</Button><Button primary onClick={onCapture}><Plus size={15} />快速记录</Button></PageHeading>
    <ErrorNotice error={error} />{error && <Button onClick={load}>重新读取首页</Button>}
    <div className="sync-strip"><div className="row wrap">{["pingcode", "gitlab"].map(provider => {
      const source = data.sources.find(source => source.provider === provider);
      return <span key={provider}><i className={`dot ${source?.syncStatus === "failed" || source?.syncStatus === "partial" ? "amber" : ""}`} />{provider === "pingcode" ? "PingCode" : "GitLab"} · {!source?.enabled ? "未启用" : source.syncStatus === "success" ? `同步成功 · ${source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "时间未返回"}` : source.syncStatus === "partial" ? "同步部分完成" : source.syncStatus === "failed" ? "同步失败，保留上次资料" : "尚未同步"}</span>;
    })}</div><button className="text-link" onClick={() => onNavigate("?view=settings")}>来源与同步 <ArrowRight size={12} /></button></div>
    <div className="dashboard-reminders" aria-label="今日提醒">{data.reminders.filter(item => item.level !== "info").map(item => <button className={`dashboard-reminder ${item.level}`} key={item.id} onClick={() => onNavigate(item.link)}><strong>{item.title}</strong><span>{item.detail}</span><ArrowRight size={14} /></button>)}</div>
    <div className="metric-strip dashboard-metrics">
      <button className={`metric ${data.inboxCount ? "metric-warning" : ""}`} onClick={() => onNavigate("?view=tasks&status=inbox")}><span className="metric-label"><Inbox size={14} />收件箱未整理</span><strong>{data.inboxCount}</strong><small>快速捕获后，在这里整理</small></button>
      <button className={`metric ${data.mrOverdueCount ? "metric-danger" : ""}`} onClick={() => onNavigate("?view=tasks&tab=mr")}><span className="metric-label"><GitPullRequest size={14} />待评审 MR（{data.mrOverdueCount} 项积压）</span><strong>{data.mrPendingCount}</strong><small>由我评审 · 打开中的 MR</small></button>
      <button className={`metric ${data.lineAlerts.length ? "metric-danger" : ""}`} onClick={() => onNavigate("?view=manage")}><span className="metric-label"><Layers3 size={14} />产线高风险/受阻</span><strong>{data.lineAlerts.length}</strong><small>风险登记册与本周重点</small></button>
      <div className="metric metric-success"><span className="metric-label"><Check size={14} />今日已完成</span><strong>{data.completedToday.length}</strong><small>上海时间 · 当日完成记录</small></div>
    </div>
    <div data-testid="key-tasks"><Section title={`今日要事（${data.keyTasks.length}/3）`} className="dashboard-keys" action={<Button onClick={() => setSelecting(true)}>设置要事</Button>}>{data.keyTasks.length ? <div className="dashboard-key-grid">{cards(data.keyTasks, "key")}</div> : <Empty title="尚未设置今日要事">建议每天最多选定 3 件最重要的事</Empty>}</Section></div>
    <div className="dashboard-grid">
      <Section title={`今日待办（${data.todayTodos.length}）`}>{data.todayTodos.length ? cards(data.todayTodos, "todo") : <Empty title="今天没有待办任务">从收件箱整理一项，或快速记下一件事。</Empty>}</Section>
      <Section title={`进行中（${data.inProgress.length}）`}>{data.inProgress.length ? cards(data.inProgress, "doing") : <Empty title="暂无进行中的任务">从今日待办点击“开始”推进工作。</Empty>}</Section>
      <div data-testid="waiting-tasks"><Section title={`等待他人（${data.waiting.length}）`}>{data.waiting.length ? cards(data.waiting, "waiting") : <Empty title="暂无等待反馈事项">需要他人回复时，记录对象、内容与预期日期。</Empty>}</Section></div>
      <Section title={`临期·超期（${data.overdue.length + data.nearDue.length}）`}>{data.overdue.length + data.nearDue.length ? cards([...data.overdue, ...data.nearDue], "due") : <Empty title="暂无临期或超期任务">提前到期预警显示在上方提醒中。</Empty>}</Section>
      <Section title="产线高风险·受阻" action={<button className="text-link" onClick={() => onNavigate("?view=manage")}>产线看板 →</button>}>
        {data.lineAlerts.length ? data.lineAlerts.map(item => <button className={`dashboard-alert-item ${item.kind === "risk" && (item.level === "high" || item.overdue) ? "risk-warning" : ""}`} key={item.id} onClick={() => onNavigate(`?view=manage&line=${item.lineId}`)}><span className={`badge ${item.level === "high" ? "red" : "amber"}`}>{riskLevelLabels[item.level]} · {item.kind === "risk" ? "风险" : "周重点"}</span><strong>{item.lineName} · {item.title}</strong><span>{item.detail || "待补充说明"}</span><small>负责人：{item.owner || "待填写"}{item.targetDate ? ` · 目标 ${item.targetDate}` : ""}{item.overdue ? " · 已超期" : ""}{item.escalated ? " · 已升级" : ""}</small></button>) : <Empty title="暂无产线高风险或受阻事项">进展与风险来自管理看板的实际记录。</Empty>}
      </Section>
      <Section title="待评审 MR" action={<button className="text-link" onClick={() => onNavigate("?view=tasks&tab=mr")}>全部 →</button>}>{data.mrItems.length ? data.mrItems.map(item => <button className="dashboard-alert-item" key={item.id} onClick={() => onNavigate(`?view=tasks&tab=mr&source=${item.id}`)}><strong>{item.title}</strong><span>{item.projectName} · !{item.number.replace(/^!/, "")}</span><small className={item.overdue ? "danger-text" : ""}>本地待评审 {item.stayDays} 天{item.overdue ? " · 已积压" : ""}</small></button>) : <Empty title="暂无待评审 MR">配置并同步 GitLab 后，显示由你评审的打开中 MR。</Empty>}</Section>
    </div>
    <div data-testid="completed-today"><Section title={`今日完成（${data.completedToday.length}）`}>{data.completedToday.length ? data.completedToday.map(task => <div className="dashboard-completed" key={task.id}><Check size={15} /><strong>{task.title}</strong><time>{new Date(task.completedAt!).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })}</time></div>) : <Empty title="今天还没有完成记录" />}</Section></div>
    {selecting && <KeyPicker data={data} guard={guard} onClose={() => setSelecting(false)} onSaved={() => { setSelecting(false); void onReload(); notify("今日要事已保存"); }} />}
    {chase && <Modal title="催办文案" onClose={() => guard.protect(() => { guard.dirty(false); setChase(null); })}><Field label="催办内容"><textarea className="input" value={chaseText} onChange={e => { setChaseText(e.target.value); guard.dirty(e.target.value !== chaseInitial(chase)); }} /></Field><p className="hint">复制后自行发送给对方。</p><CopyButton body={chaseText} notify={notify} label="复制催办文案" /></Modal>}
  </>;
}

function KeyPicker({ data, onClose, onSaved, guard }: { data: Dashboard; onClose: () => void; onSaved: () => void; guard: Guard }) {
  const [selected, setSelected] = useState(data.keyTasks.map(task => task.id));
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try {
      await request("/dashboard/key-tasks", { method: "PUT", body: JSON.stringify({ date: data.date, selected: selected.map(id => ({ id, revision: data.keyCandidates.find(task => task.id === id)!.revision })), current: data.keyTasks.map(task => ({ id: task.id, revision: task.revision })) }) });
      guard.dirty(false); onSaved();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <Modal title="设置今日要事" onClose={() => { if (!busy) guard.protect(() => { guard.dirty(false); onClose(); }); }}>
    <p className="muted">已选 {selected.length}/3 · 剩余 {3 - selected.length} 个名额。先取消一件即可调整选择。</p><ErrorNotice error={error} />
    <div className="key-picker-list">{data.keyCandidates.map(task => <label className="key-picker-item" key={task.id}><input type="checkbox" checked={selected.includes(task.id)} disabled={busy || !selected.includes(task.id) && selected.length >= 3} onChange={e => { setSelected(current => e.target.checked ? [...current, task.id] : current.filter(id => id !== task.id)); guard.dirty(true); }} /><span><strong>{task.title}</strong><small>{task.category === "personal" ? "个人任务" : "管理"} · {statusLabels[task.status]}</small></span></label>)}{!data.keyCandidates.length && <Empty title="暂无可选择的任务">先快速记录一件事。</Empty>}</div>
    <div className="editor-actions"><Button disabled={busy} onClick={() => guard.protect(() => { guard.dirty(false); onClose(); })}>取消</Button><Button primary disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存要事"}</Button></div>
  </Modal>;
}
