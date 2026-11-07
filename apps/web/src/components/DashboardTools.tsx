import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Plus } from "lucide-react";
import type { Task } from "../../../../packages/contracts/src/index";
import type { Reminder } from "../../../../packages/contracts/src/dashboard";
import { api, errorText, request } from "../api";
import { Button, Empty, ErrorNotice, Modal, PageHeading, Section, type Guard, type Notify } from "./ui";

export function ReminderBell({ enabled, tasks, onNavigate }: { enabled: boolean; tasks: Task[] | undefined; onNavigate: (link: string) => void }) {
  const [items, setItems] = useState<Reminder[]>([]); const [error, setError] = useState("");
  const [open, setOpen] = useState(false); const sent = useRef(new Set<string>());
  const revisions = tasks?.map(task => `${task.id}:${task.revision}`).join(",");
  const refresh = useCallback(async () => {
    try {
      const value = await request<{ items: Reminder[]; browserNotify: boolean }>("/reminders");
      setItems(value.items); setError("");
      if (value.browserNotify && "Notification" in window && Notification.permission === "granted") {
        for (const item of value.items.filter(item => item.level === "danger")) {
          const key = `${item.id}:${item.types.join(",")}:${item.detail}`;
          if (sent.current.has(key)) continue;
          try { new Notification("工作台有需要关注的事项", { body: "请打开工作台查看提醒。", tag: item.id }); sent.current.add(key); } catch { /* In-app reminders remain available. */ }
        }
      }
    } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh(); const timer = setInterval(() => void refresh(), 60000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  useEffect(() => { if (enabled && revisions) void refresh(); }, [enabled, revisions, refresh]);
  return <>
    <button className="icon-button reminder-bell" aria-label="打开提醒" title={error ? "提醒读取失败，点击重试" : "全部提醒"} onClick={() => { setOpen(true); void refresh(); }}><Bell size={18} />{(items.length > 0 || error) && <span className="reminder-count">{error ? "!" : Math.min(items.length, 9)}</span>}</button>
    {open && <Modal title="全部提醒" onClose={() => setOpen(false)}><ErrorNotice error={error} />{error && <Button onClick={refresh}>重新读取提醒</Button>}<div className="reminder-list">{items.map(item => <button className={`dashboard-reminder ${item.level}`} key={item.id} onClick={() => { onNavigate(item.link); setOpen(false); }}><strong>{item.title}</strong><span>{item.detail}</span></button>)}{!items.length && !error && <Empty title="暂无提醒">提醒每60秒更新一次。</Empty>}</div></Modal>}
  </>;
}

export function InboxInput({ onSaved, notify, multiline = false, guard }: { onSaved: (task: Task) => void; notify: Notify; multiline?: boolean; guard?: Guard }) {
  const [title, setTitle] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const inFlight = useRef(false);
  useEffect(() => { if (guard) guard.dirty(!!title); }, [title, guard]);
  const save = async () => {
    if (inFlight.current || !title.trim()) return;
    inFlight.current = true; setBusy(true); setError("");
    const lines = multiline ? title.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [title.trim()]; let completed = 0;
    try {
      for (const line of lines) { onSaved(await api.createTask({ title: line, category: "personal", status: "inbox" })); completed++; }
      setTitle(""); guard?.dirty(false); notify(`${completed} 条任务已保存到收件箱`);
    } catch (e) { setTitle(lines.slice(completed).join("\n")); setError(errorText(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const props = { className: "input", "aria-label": "一句话任务", placeholder: multiline ? "每行一件事，Enter 保存；Shift+Enter 换行" : "记下一件事，Enter 捕获", value: title, disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setTitle(e.target.value), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } } };
  return <form className="inbox-input" onSubmit={e => { e.preventDefault(); void save(); }}><ErrorNotice error={error} />{multiline ? <textarea {...props} rows={3} /> : <input {...props} maxLength={300} />}<Button primary type="submit" disabled={busy || !title.trim()}><Plus size={13} />{busy ? "正在捕获…" : "捕获"}</Button></form>;
}

export function CapturePage({ tasks, onSaved, onOpen, notify, guard }: { tasks: Task[]; onSaved: (task: Task) => void; onOpen: (task: Task) => void; notify: Notify; guard: Guard }) {
  const inbox = tasks.filter(task => !task.archived && task.status === "inbox");
  return <><PageHeading eyebrow="CAPTURE" title="快速捕获" description="先记下来，再统一整理。每行一件事，连续录入收件箱。" /><Section title="记下一件事"><InboxInput multiline onSaved={onSaved} notify={notify} guard={guard} /></Section><Section title={`收件箱未整理（${inbox.length}）`}>{inbox.length ? inbox.map(task => <button className="compact-item" key={task.id} onClick={() => onOpen(task)}>{task.title}<span className="badge">整理</span></button>) : <Empty title="收件箱已整理完毕" />}</Section></>;
}
