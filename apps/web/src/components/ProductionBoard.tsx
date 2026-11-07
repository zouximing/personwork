import { useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { Task } from "../../../../packages/contracts/src/index";
import { shiftDate } from "../../../../packages/contracts/src/index";
import type { Line, PeriodView, Risk } from "../../../../packages/contracts/src/management";
import { cycleRange, lineOverview, monthCompletion, periodsInCycle, progressLabels, progressState, riskLevelLabels, riskWarning, type MonthSummary } from "../../../../packages/contracts/src/production";
import { errorText, request } from "../api";
import { Button, Empty, ErrorNotice, Section } from "./ui";

const monthStatus: Record<string, string> = { planned: "未开始", doing: "进行中", waiting: "等待反馈", blocked: "受阻", done: "已完成", cancelled: "取消" };
const stateColor: Record<string, string> = { normal: "green", at_risk: "amber", blocked: "red", done: "green" };
export type PeriodDefaults = { lineId?: string; kind?: "week" | "month"; date?: string };

export function ProductionBoard({ lines, periods, risks, tasks, today, onEditLine, onEditPeriod, onCarry, onOpenTask, onChanged }: {
  lines: Line[]; periods: PeriodView[]; risks: Risk[]; tasks: Task[]; today: string;
  onEditLine: (line?: Line) => void; onEditPeriod: (period?: PeriodView, defaults?: PeriodDefaults) => void;
  onCarry: (period: PeriodView) => void; onOpenTask: (task: Task) => void; onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("line"));
  const [kind, setKind] = useState<"week" | "month">("week");
  const [date, setDate] = useState(today);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summaries, setSummaries] = useState<MonthSummary[]>([]);
  const [summaryError, setSummaryError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([request<{ summaries: MonthSummary[] }>("/production"), request<{ error: string }>("/production/status")]).then(([value, status]) => { if (active) { setSummaries(value.summaries); setSummaryError(status.error); } }).catch(e => { if (active) setSummaryError(errorText(e)); });
    return () => { active = false; };
  }, [periods]);
  const visibleLines = lines.filter(l => !l.archived);
  const line = visibleLines.find(l => l.id === selected);
  const overview = line ? lineOverview(line, periods, risks, today) : null;
  const [start, end] = cycleRange(kind, date);
  const selectedPeriods = line ? periodsInCycle(periods, line.id, kind, date) as PeriodView[] : [];
  const previousDate = shiftDate(start, -1);
  const previous = line ? periodsInCycle(periods, line.id, kind, previousDate) as PeriodView[] : [];
  const move = (direction: number) => {
    if (kind === "week") setDate(shiftDate(start, direction * 7));
    else if (direction < 0) setDate(shiftDate(start, -1));
    else setDate(shiftDate(end, 1));
  };
  const carryPrevious = async () => {
    if (!line) return;
    setBusy(true); setError("");
    try {
      await request("/periods/carry-previous", { method: "POST", body: JSON.stringify({ lineId: line.id, kind, start, end, reason: `从上${kind === "week" ? "周" : "月"}结转未完成重点` }) });
      onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const renderPeriod = (p: PeriodView, old = false) => (
    <div className="period-item" data-testid={old ? `previous-${p.id}` : `period-${p.id}`} key={p.id}>
      <div className="section-heading">
        <button className="task-title" onClick={() => onEditPeriod(p)}>{p.title}</button>
        <span className={`badge ${p.kind === "week" ? stateColor[progressState(p)] : p.status === "blocked" ? "red" : p.status === "done" ? "green" : ""}`}>
          {p.kind === "week" ? p.status === "cancelled" ? "取消" : progressLabels[progressState(p)] : monthStatus[p.status]}
        </span>
      </div>
      <p className="hint">负责人：{p.owner || "待填写"} · {p.kind === "month" ? `完成度 ${p.completion ?? 0}%` : `更新 ${new Date(p.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`}</p>
      <p className="card-description">{p.expectedResult || "尚未填写目标／交付物"}</p>
      <p className="card-description">{p.actual || "尚未记录进展"}</p>
      {p.notes && <p className="hint">备注：{p.notes}</p>}
      <div className="task-meta">
        {p.flags.overdue && <span className="badge red">节点延期</span>}
        {p.flags.pendingConfirmation && <span className="badge amber">待反馈确认</span>}
        {p.carriedFromId && <span className="badge amber">{previous.some(v => v.id === p.carriedFromId) ? "上周／月遗留" : "结转事项"}</span>}
      </div>
      {p.monthlyId && <p className="hint">关联月重点：{periods.find(v => v.id === p.monthlyId)?.title || "关联月目标"}</p>}
      {p.taskIds.map(id => {
        const task = tasks.find(t => t.id === id);
        return task ? <button key={id} className="linked-task" onClick={() => onOpenTask(task)}>{task.title}</button> : null;
      })}
      <div className="inline-actions">
        <Button onClick={() => onEditPeriod(p)}>{p.kind === "week" ? "更新进展" : "编辑月重点"}</Button>
        {!["done", "cancelled"].includes(p.status) && <Button onClick={() => onCarry(p)}>结转…</Button>}
      </div>
    </div>
  );
  return <div className="production-board">
    <ErrorNotice error={error} />
    {!line ? <>
      <div className="section-heading"><div><h2>产线总览</h2><p className="hint">本月 {today.slice(0, 7)} · 本周 {cycleRange("week", today).join(" — ")}</p></div></div>
      {!visibleLines.length ? <Section title="从产线目标开始"><Empty title="还没有建立产线" action={<Button onClick={() => onEditLine()}>新建产线</Button>}>填写真实产线名称和负责人，再安排月目标与周重点。</Empty></Section> : <div className="production-overview-grid">
        {visibleLines.map(l => {
          const summary = lineOverview(l, periods, risks, today);
          return <section className="panel production-card" key={l.id} data-testid={`production-card-${l.id}`}>
            <div className="section-heading"><h2>{l.name}</h2><button className="text-link" onClick={() => onEditLine(l)}>编辑产线</button></div>
            <p className="hint">负责人 · {l.owner || "待填写"}</p>
            <p className="hint">本月重点完成率</p><strong className="production-rate">{summary.monthly.rate === null ? "暂无有效重点" : `${summary.monthly.rate}%`}</strong>
            <p className="hint">已完成 {summary.monthly.done} / {summary.monthly.total} 项 · 不含取消</p>
            <div className="production-statuses">{Object.entries(progressLabels).map(([key, label]) => <span key={key} className={`badge ${stateColor[key]}`}>{label === "已完成" ? "完成" : label} {summary.weekly[key as keyof typeof summary.weekly]}</span>)}</div>
            <p className="hint">开放风险 {Object.values(summary.openRisks).reduce((a, b) => a + b, 0)}</p>
            <div className="production-statuses">{Object.entries(riskLevelLabels).map(([key, label]) => <span key={key} className={`badge ${key === "high" ? "red" : key === "medium" ? "amber" : "green"}`}>{label} {summary.openRisks[key as keyof typeof summary.openRisks]}</span>)}</div>
            {!!summary.warningRiskIds.length && <p className="production-alert risk-warning">{summary.warningRiskIds.length} 项高等级／超期风险需关注</p>}
            <ul className="production-month-items">{summary.monthlyItems.length ? summary.monthlyItems.map(p => <li key={p.id}>{p.title}<span>{monthStatus[p.status]}</span></li>) : <li>本月尚未登记重点</li>}</ul>
            <p className="hint">当前周 {summary.weekStart} — {summary.weekEnd}</p>
            {summary.reminders.includes("weekly-update") && <p className="production-alert">请更新本周重点进展</p>}
            {summary.reminders.some(r => r.startsWith("initialize")) && <p className="hint">新周期待初始化：{summary.reminders.includes("initialize-month") ? "月重点 " : ""}{summary.reminders.includes("initialize-week") ? "周重点" : ""}，可新建或结转。</p>}
            <Button primary onClick={() => { setSelected(l.id); setDate(today); }}>{l.name} 查看详情</Button>
          </section>;
        })}
      </div>}
    </> : <>
      <div className="section-heading production-detail-heading"><div><Button onClick={() => setSelected(null)}><ArrowLeft size={14} />返回产线总览</Button><h2>{line.name} · 产线详情</h2><p className="hint">负责人：{line.owner || "待填写"}</p></div><Button onClick={() => onEditLine(line)}>编辑产线</Button></div>
      <div className="filter-row production-toolbar">
        <select aria-label="重点周期" value={kind} onChange={e => { setKind(e.target.value as typeof kind); setCompare(false); }}><option value="week">周重点</option><option value="month">月重点</option></select>
        <Button onClick={() => move(-1)}><ChevronLeft size={14} />上{kind === "week" ? "周" : "月"}</Button>
        <input className="input production-date" aria-label="定位重点日期" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} />
        <Button onClick={() => move(1)}>下{kind === "week" ? "周" : "月"}<ChevronRight size={14} /></Button>
        <Button onClick={() => setDate(today)}>回到本期</Button>
        {kind === "week" && <Button onClick={() => setCompare(v => !v)}>{compare ? "收起上周对比" : "与上周对比"}</Button>}
      </div>
      <p className="hint">{start} — {end} · Asia/Shanghai · 周一起始</p>
      {kind === "month" && <p className="production-metric" data-testid="monthly-completion">月重点完成率：{monthCompletion(selectedPeriods).rate === null ? "暂无有效重点" : `${monthCompletion(selectedPeriods).rate}%`}（{monthCompletion(selectedPeriods).done}/{monthCompletion(selectedPeriods).total}，不含取消）</p>}
      {kind === "month" && selectedPeriods.length > 5 && <p className="notice">本月已超过建议的5条重点，可继续登记，建议聚焦。</p>}
      {overview?.reminders.includes("weekly-update") && kind === "week" && cycleRange("week", date)[0] === cycleRange("week", today)[0] && <p className="production-alert">已到本线进展更新日，请更新本周重点进展。</p>}
      {!selectedPeriods.length && <p className="notice">本周期尚未初始化，可新建重点或从上{kind === "week" ? "周" : "月"}结转。</p>}
      <div className="inline-actions production-actions"><Button primary onClick={() => onEditPeriod(undefined, { lineId: line.id, kind, date })}><Plus size={14} />新建{kind === "week" ? "周" : "月"}重点</Button><Button disabled={busy || !previous.some(p => !["done", "cancelled"].includes(p.status))} onClick={() => void carryPrevious()}>{busy ? "正在结转…" : `一键结转上${kind === "week" ? "周" : "月"}未完成项`}</Button></div>
      {kind === "week" && !!overview?.leftovers.length && <div className="production-leftovers"><h3>上周遗留项</h3>{overview.leftovers.map(p => <p className="hint" key={p.id}>{p.title} · {p.carriedToCurrent ? "已结转本周" : "尚未结转，待安排"}</p>)}</div>}
      <div className={`production-period-grid ${compare && kind === "week" ? "comparing" : ""}`}>
        {compare && kind === "week" && <Section title="上周重点" className="production-previous"><div data-testid="previous-week"><p className="hint">{cycleRange("week", previousDate).join(" — ")}</p>{previous.length ? previous.map(p => renderPeriod(p, true)) : <p className="compact-empty">暂无上周重点</p>}</div></Section>}
        <Section title={kind === "week" ? "本周重点" : "本月重点"}>{selectedPeriods.length ? selectedPeriods.map(p => renderPeriod(p)) : <p className="compact-empty">暂无重点，请新建或结转。</p>}</Section>
      </div>
      <Section title="产线风险预警">{risks.filter(r => r.lineIds.includes(line.id) && riskWarning(r, today)).map(r => <p className="production-alert risk-warning" key={r.id}>{r.title} · {riskLevelLabels[r.level ?? "medium"]}等级{r.targetCloseDate && r.targetCloseDate < today ? " · 超期未闭环" : ""}</p>)}{!risks.some(r => r.lineIds.includes(line.id) && riskWarning(r, today)) && <p className="compact-empty">暂无高等级／超期未闭环风险</p>}</Section>
    </>}
    <Section title="月末汇总记录"><ErrorNotice error={summaryError} />{summaries.filter(s => !line || s.lineId === line.id).slice(0, 18).map(s => <p className="hint" key={`${s.lineId}:${s.month}`}>{s.lineName} · {s.month} · {s.rate === null ? "暂无有效重点" : `${s.rate}%（${s.done}/${s.total}）`}{!s.historyComplete ? " · 历史依据不完整，需复核" : ""}</p>)}{!summaries.some(s => !line || s.lineId === line.id) && <p className="compact-empty">月末当天显示实时完成率，月结束后自动保存汇总；关闭期间下次启动补算。</p>}</Section>
  </div>;
}
