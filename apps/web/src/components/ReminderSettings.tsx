import { useEffect, useState } from "react";
import type { DashboardSettings } from "../../../../packages/contracts/src/dashboard";
import { errorText, request } from "../api";
import { Busy, Button, ErrorNotice, Field, Section, type Guard, type Notify } from "./ui";

export function ReminderSettings({ guard, notify }: { guard: Guard; notify: Notify }) {
  const [saved, setSaved] = useState<DashboardSettings | null>(null);
  const [draft, setDraft] = useState<DashboardSettings | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState("");
  const load = async () => {
    try { const value = await request<DashboardSettings>("/dashboard/settings"); setSaved(value); setDraft(value); setError(""); }
    catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { guard.dirty(JSON.stringify(saved) !== JSON.stringify(draft)); }, [saved, draft, guard]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const value = await request<DashboardSettings>("/dashboard/settings", { method: "PUT", body: JSON.stringify(draft) });
      setDraft(value); setSaved(value); guard.dirty(false); notify("提醒设置已保存");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const enableNotifications = async (enabled: boolean) => {
    if (!draft) return;
    setDraft({ ...draft, browserNotify: enabled });
    if (!enabled) { setPermission(""); return; }
    if (!("Notification" in window)) { setPermission("当前浏览器不支持系统通知，应用内提醒继续可用。"); return; }
    try {
      const result = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      setPermission(result === "granted" ? "已允许系统通知，保存后生效。" : "未获得系统通知权限，应用内提醒继续可用。");
    } catch { setPermission("系统通知权限未确认，应用内提醒继续可用。"); }
  };
  return <Section title="提醒设置"><ErrorNotice error={error} />{!draft ? error ? <Button onClick={load}>重新读取设置</Button> : <Busy /> : <>
    <div className="form-grid">
      <Field label="截止提前提醒天数"><input type="number" min={0} max={30} className="input" value={draft.deadlineLeadDays} onChange={e => setDraft({ ...draft, deadlineLeadDays: Number(e.target.value) })} /></Field>
      <Field label="MR 积压天数"><input type="number" min={1} max={365} className="input" value={draft.mrBacklogDays} onChange={e => setDraft({ ...draft, mrBacklogDays: Number(e.target.value) })} /></Field>
      <Field label="产线周重点更新日"><select value={draft.lineUpdateWeekday} onChange={e => setDraft({ ...draft, lineUpdateWeekday: Number(e.target.value) })}>{["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((label, i) => <option value={i + 1} key={label}>{label}</option>)}</select></Field>
    </div>
    <label className="check-line"><input type="checkbox" checked={draft.browserNotify} onChange={e => void enableNotifications(e.target.checked)} />开启浏览器系统通知</label>
    <p className="hint">系统通知只显示通用提示；浏览器关闭后不保证送达。{permission}</p>
    <div className="editor-actions"><Button primary disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存提醒设置"}</Button></div>
  </>}</Section>;
}
