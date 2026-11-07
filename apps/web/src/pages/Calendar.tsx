import { useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, ListTodo } from "lucide-react";
import { dateOnly, statusLabels, type Task } from "../../../../packages/contracts/src/index";
import {
  calendarDays, calendarKinds, indexCalendarTasks, moveCalendarDate,
  type CalendarEntry, type CalendarKind, type CalendarView,
} from "../calendar";
import { Button, Empty, PageHeading } from "../components/ui";

const kindLabels: Record<CalendarKind, string> = { planDate: "计划", dueDate: "截止", followUpDate: "跟进" };
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function CalendarTask({ entry, date, today, onOpen }: {
  entry: CalendarEntry; date: string; today: string; onOpen: (task: Task) => void;
}) {
  const ended = ["done", "cancelled"].includes(entry.task.status);
  const overdue = !ended && date < today && entry.kinds.includes("dueDate");
  return (
    <button
      type="button"
      className={`calendar-task ${ended ? "ended" : ""} ${overdue ? "overdue" : ""}`}
      aria-label={`打开任务：${entry.task.title}`}
      onClick={() => onOpen(entry.task)}
      title={entry.task.title}
    >
      <span className="calendar-task-title">{entry.task.title}</span>
      <span className="calendar-task-meta">
        {entry.kinds.map(kind => <span key={kind} className={`calendar-kind ${kind}`}>{kindLabels[kind]}</span>)}
        {overdue && <span className="calendar-overdue">已逾期</span>}
        <span className="calendar-task-status">{statusLabels[entry.task.status]}</span>
      </span>
    </button>
  );
}

export function TaskCalendar({ tasks, today, onOpen, onNavigateTasks }: {
  tasks: Task[]; today: string; onOpen: (task: Task) => void; onNavigateTasks: () => void;
}) {
  const [date, setDate] = useState(today);
  const [view, setView] = useState<CalendarView>("month");
  const [kinds, setKinds] = useState<CalendarKind[]>([...calendarKinds]);
  const [showEnded, setShowEnded] = useState(false);
  const selectedRef = useRef<HTMLElement>(null);
  const days = useMemo(() => calendarDays(date, view), [date, view]);
  const index = useMemo(() => indexCalendarTasks(tasks, kinds, showEnded), [tasks, kinds, showEnded]);
  const selected = index.get(date) || [];
  const period = view === "month" ? `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月` : `${days[0]} — ${days.at(-1)}`;
  const selectedWeekday = weekdays[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
  const visibleTaskCount = new Set(days.filter(day => view === "week" || day.slice(0, 7) === date.slice(0, 7)).flatMap(day => (index.get(day) || []).map(entry => entry.task.id))).size;
  const toggleKind = (kind: CalendarKind) => setKinds(current => calendarKinds.filter(item => item === kind ? !current.includes(item) : current.includes(item)));
  const selectAll = (day: string) => {
    setDate(day);
    selectedRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  return (
    <div className="task-calendar">
      <PageHeading
        eyebrow="TASK CALENDAR"
        title="任务日历"
        description="把计划、截止与跟进放进日历，让接下来的安排更清楚。"
      >
        <Button onClick={onNavigateTasks}><ListTodo size={15} />任务中心</Button>
      </PageHeading>
      <section className="panel calendar-panel" aria-label="日历控制">
        <div className="calendar-toolbar">
          <div className="calendar-period-controls">
            <Button aria-label={view === "month" ? "上一个月" : "上一周"} onClick={() => setDate(moveCalendarDate(date, view, -1))}><ChevronLeft size={16} /></Button>
            <Button onClick={() => setDate(today)}>今天</Button>
            <Button aria-label={view === "month" ? "下一个月" : "下一周"} onClick={() => setDate(moveCalendarDate(date, view, 1))}><ChevronRight size={16} /></Button>
          </div>
          <h2 className="calendar-period" aria-live="polite">{period}</h2>
          <div className="calendar-view-controls">
            <input
              className="input calendar-date-input" type="date" aria-label="定位日期" value={date}
              onChange={event => { if (dateOnly.safeParse(event.target.value).success) setDate(event.target.value); }}
            />
            <div className="calendar-view-switch" role="group" aria-label="日历视图">
              <Button primary={view === "month"} aria-label="月视图" aria-pressed={view === "month"} onClick={() => setView("month")}>月</Button>
              <Button primary={view === "week"} aria-label="周视图" aria-pressed={view === "week"} onClick={() => setView("week")}>周</Button>
            </div>
          </div>
        </div>
        <div className="calendar-filters">
          <div className="calendar-kind-filters" role="group" aria-label="日期类型">
            {calendarKinds.map(kind => (
              <label key={kind} className="calendar-filter">
                <input type="checkbox" checked={kinds.includes(kind)} onChange={() => toggleKind(kind)} />
                <span className={`calendar-legend ${kind}`} />{kindLabels[kind]}日期
              </label>
            ))}
          </div>
          <label className="calendar-filter"><input type="checkbox" checked={showEnded} onChange={event => setShowEnded(event.target.checked)} />显示已完成／已取消</label>
          <span className="muted">本{view === "month" ? "月" : "周"} {visibleTaskCount} 项任务</span>
        </div>
        {!kinds.length && <p className="calendar-filter-hint" role="status">请选择至少一种日期类型</p>}
        <section className={`calendar-grid ${view}`} aria-label={view === "month" ? "月日历" : "周日历"}>
          {view === "month" && weekdays.map(day => <div className="calendar-weekday" key={day}>{day}</div>)}
          {days.map((day, dayIndex) => {
            const entries = index.get(day) || [];
            return (
              <article
                className={`calendar-day ${day === today ? "today" : ""} ${day === date ? "selected" : ""} ${view === "month" && day.slice(0, 7) !== date.slice(0, 7) ? "outside" : ""}`}
                key={day} data-date={day}
              >
                <button
                  type="button" className="calendar-day-select" aria-label={`查看 ${day}`}
                  aria-pressed={day === date} aria-current={day === today ? "date" : undefined}
                  onClick={() => setDate(day)}
                >
                  {view === "week" && <span className="calendar-day-weekday">{weekdays[dayIndex]}</span>}
                  <span className="calendar-day-number">{view === "week" ? `${Number(day.slice(5, 7))}/${Number(day.slice(-2))}` : Number(day.slice(-2))}</span>
                  {day === today && <span className="calendar-today-label">今天</span>}
                  {!!entries.length && <span className="calendar-day-count">{entries.length}项</span>}
                </button>
                <div className="calendar-day-tasks">
                  {(view === "month" ? entries.slice(0, 3) : entries).map(entry => <CalendarTask key={entry.task.id} entry={entry} date={day} today={today} onOpen={onOpen} />)}
                  {view === "month" && entries.length > 3 && <button type="button" className="calendar-more" aria-label={`查看 ${day} 的全部 ${entries.length} 项任务`} onClick={() => selectAll(day)}>另有 {entries.length - 3} 项 · 查看全部</button>}
                  {view === "week" && !entries.length && <p className="calendar-day-empty">暂无任务</p>}
                </div>
              </article>
            );
          })}
        </section>
      </section>
      {view === "month" && (
        <section className="panel calendar-selected" aria-label="当日任务" ref={selectedRef}>
          <div className="section-heading"><h2><CalendarDays size={16} /> {date} · {selectedWeekday}</h2><span className="count">{selected.length} 项任务</span></div>
          {selected.length ? <div className="calendar-selected-tasks">{selected.map(entry => <CalendarTask key={entry.task.id} entry={entry} date={date} today={today} onOpen={onOpen} />)}</div> : <Empty title="这一天暂无符合筛选的任务">调整日期或筛选条件，查看其他安排。</Empty>}
        </section>
      )}
      <p className="page-footnote">日历与任务中心共用任务。未设置日期的任务可在任务中心安排；归档任务不在日历中显示。</p>
    </div>
  );
}
