import { useCallback, useEffect, useState } from "react";
import { Plus, ArrowRight, AlertTriangle, CalendarDays } from "lucide-react";
import {
  shiftDate,
  type Task,
} from "../../../../packages/contracts/src/index";
import type {
  Line,
  PeriodView,
  Risk,
  Recurrence,
  Milestone,
} from "../../../../packages/contracts/src/management";
import { api, errorText, request } from "../api";
import { cycleRange, lineOverview, progressLabels, progressState, riskLevelLabels, riskWarning, type MonthSummary } from "../../../../packages/contracts/src/production";
import { ProductionBoard, type PeriodDefaults } from "../components/ProductionBoard";
import {
  Busy,
  Button,
  Empty,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Section,
  type Guard,
  type Notify,
} from "../components/ui";
import {
  RecordForm,
  type FormDefinition,
  type FormField,
} from "../components/RecordForm";

export type ManagementData = {
  lines: Line[];
  periods: PeriodView[];
  risks: Risk[];
  recurrences: Recurrence[];
  milestones: Milestone[];
  publicPeriodIds: string[];
  publicRiskIds: string[];
  summaries: MonthSummary[];
  productionDate: string;
};
const blankData: ManagementData = {
  lines: [],
  periods: [],
  risks: [],
  recurrences: [],
  milestones: [],
  publicPeriodIds: [],
  publicRiskIds: [],
  summaries: [],
  productionDate: "",
};
const stateLabels: Record<string, string> = {
  planned: "待推进",
  doing: "进行中",
  waiting: "等待反馈",
  blocked: "阻塞",
  done: "已完成",
  cancelled: "已取消",
  open: "开放",
  watching: "跟踪中",
  closed: "已闭环",
};
export function useManagement() {
  const [data, setData] = useState<ManagementData>(blankData);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setError("");
    try {
      const [lines, periods, risks, recurrences, milestones, production] =
        await Promise.all([
          api.list<Line>("/lines"),
          api.list<PeriodView>("/periods"),
          api.list<Risk>("/risks"),
          api.list<Recurrence>("/recurrences"),
          api.list<Milestone>("/milestones"),
          request<{ publicPeriodIds: string[]; publicRiskIds: string[]; summaries: MonthSummary[]; date: string }>("/production"),
        ]);
      setData({ lines, periods, risks, recurrences, milestones, ...production, productionDate: production.date });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 60000);
    return () => clearInterval(timer);
  }, [reload]);
  return { data, error, loading, reload };
}
const field = (
  key: string,
  label: string,
  kind: FormField["kind"] = "text",
  extra: Partial<FormField> = {},
): FormField => ({ key, label, kind, ...extra });
function pickValues(item: object, fields: FormField[]) {
  return Object.fromEntries(
    fields.map((f) => [
      f.key,
      (item as Record<string, unknown>)[f.key] ??
        (f.kind === "multi"
          ? []
          : f.kind === "boolean"
            ? false
            : f.nullable
              ? null
              : ""),
    ]),
  );
}
export function Management({
  tasks,
  today,
  guard,
  notify,
  onOpen,
  onTaskSaved,
  onChanged,
}: {
  tasks: Task[];
  today: string;
  guard: Guard;
  notify: Notify;
  onOpen: (task: Task) => void;
  onTaskSaved: (task: Task) => void;
  onChanged?: () => void;
}) {
  const { data, error, loading, reload } = useManagement();
  const [tab, setTab] = useState("lines");
  const [riskLineFilter, setRiskLineFilter] = useState("all");
  const [riskLevelFilter, setRiskLevelFilter] = useState("all");
  const [form, setForm] = useState<FormDefinition | null>(null);
  const [carry, setCarry] = useState<PeriodView | null>(null);
  const [materialize, setMaterialize] = useState<Recurrence | null>(null);
  const refresh = () => {
    void reload();
    onChanged?.();
  };
  const taskOptions = tasks
    .filter((t) => !t.sensitive)
    .map((t) => ({ value: t.id, label: t.title }));
  const lineOptions = data.lines
    .filter((l) => !l.archived)
    .map((l) => ({ value: l.id, label: l.name }));
  const showForm = (definition: FormDefinition) =>
    guard.protect(() => {
      guard.dirty(false);
      setForm(definition);
    });
  const editLine = (item?: Line) => {
    const fields = [
      field("name", "产线名称", "text", { required: true }),
      field("owner", "负责人"),
      field("description", "说明", "area"),
      field("reminderWeekday", "周进展提醒日（1周一～7周日）", "number", { required: true }),
      field("archived", "归档产线", "boolean"),
    ];
    showForm({
      title: item ? "编辑产线" : "新建产线",
      path: "/lines",
      fields,
      values: item
        ? pickValues(item, fields)
        : { name: "", owner: "", description: "", archived: false, reminderWeekday: 5 },
      id: item?.id,
      revision: item?.revision,
    });
  };
  const editPeriod = (item?: PeriodView, defaults: PeriodDefaults = {}) => {
    const periodKind = item?.kind ?? defaults.kind ?? "week";
    const [start, end] = cycleRange(periodKind, defaults.date ?? data.productionDate ?? today);
    const lineId = item?.lineId ?? defaults.lineId ?? lineOptions[0]?.value ?? "";
    const fields = [
      field("title", "描述", "text", { required: true }),
      field("lineId", "所属产线", "select", { required: true, options: lineOptions }),
      field("start", "周期开始", "date", { required: true }),
      field("end", "周期结束", "date", { required: true }),
      field("owner", "负责人"),
      field("expectedResult", periodKind === "month" ? "目标／交付物" : "本周目标", "area"),
      ...(periodKind === "month" ? [
        field("status", "月重点状态", "select", { options: ["planned", "doing", "blocked", "done", "cancelled", ...(item?.status === "waiting" ? ["waiting"] : [])].map(value => ({ value, label: ({ planned: "未开始", doing: "进行中", blocked: "受阻", done: "已完成", cancelled: "取消", waiting: "等待反馈（历史）" } as Record<string, string>)[value] })) }),
        field("completion", "完成度（%）", "number", { hint: "0～100整数；标记已完成时自动为100%。" }),
        field("notes", "备注", "area"),
      ] : [
        field("progressStatus", "进展状态", "select", { options: Object.entries(progressLabels).map(([value, label]) => ({ value, label })) }),
        field("monthlyId", "关联月重点", "select", { nullable: true, options: [{ value: "", label: "独立周事项" }, ...data.periods.filter(p => p.kind === "month" && p.lineId === lineId && p.start <= (item?.end ?? end) && p.end >= (item?.start ?? start)).map(p => ({ value: p.id, label: p.title }))] }),
      ]),
      field("actual", "进展说明", "area"),
      field("plannedDate", "计划节点", "date", { nullable: true }),
      field("feedbackAt", "反馈日期", "date", { nullable: true }),
      field("feedbackSource", "反馈来源 / 依据"),
      field("taskIds", "关联同一份任务", "multi", { options: taskOptions }),
      field("nextAction", "下一步 / 协调行动", "area"),
      field("followUpDate", "下次跟进日期", "date", { nullable: true }),
      field("changeReason", "调整原因（修改节点时必填）", "area"),
    ];
    const initial = { title: "", lineId, kind: periodKind, start, end, owner: data.lines.find(l => l.id === lineId)?.owner ?? "", plannedDate: null, expectedResult: "", actual: "", feedbackAt: null, feedbackSource: "", status: "planned", progressStatus: periodKind === "week" ? "normal" : null, completion: 0, notes: "", monthlyId: null, taskIds: [], nextAction: "", followUpDate: null, changeReason: "" };
    showForm({ title: item ? "编辑周期重点与反馈" : `新建${periodKind === "week" ? "周" : "月"}重点`, path: "/periods", fields,
      values: item ? { ...pickValues(item, fields), ...(periodKind === "week" ? { progressStatus: progressState(item) } : {}) } : { ...pickValues(initial, fields), kind: periodKind }, id: item?.id, revision: item?.revision });
  };
  const editRisk = (item?: Risk) => {
    const fields = [
      field("title", "风险 / 问题标题", "text", { required: true }),
      field("kind", "类型", "select", {
        options: [
          { value: "risk", label: "风险" },
          { value: "issue", label: "已发生的问题" },
        ],
      }),
      field("owner", "责任人"),
      field("level", "风险等级", "select", { options: Object.entries(riskLevelLabels).map(([value, label]) => ({ value, label })) }),
      field("targetCloseDate", "目标闭环日期", "date", { nullable: true }),
      field("escalated", "是否升级", "boolean"),
      field("status", "风险状态", "select", {
        options: ["open", "watching", "closed"].map((value) => ({
          value,
          label: stateLabels[value],
        })),
      }),
      field("impact", "影响", "area"),
      field("response", "缓解措施", "area"),
      field("nextCheckDate", "复查日期", "date", { nullable: true }),
      field("lineIds", "关联产线", "multi", { options: lineOptions }),
      field("periodIds", "关联周期重点", "multi", {
        options: data.periods.map((p) => ({ value: p.id, label: p.title })),
      }),
      field("taskIds", "关联行动任务", "multi", { options: taskOptions }),
      field("result", "关闭结果（关闭必填）", "area"),
      field("evidence", "关闭依据与残余影响（关闭必填）", "area"),
    ];
    showForm({
      title: item ? "更新风险与问题" : "记录风险与问题",
      path: "/risks",
      fields,
      values: item
        ? pickValues(item, fields)
        : {
            title: "",
            kind: "risk",
            owner: "",
            level: "medium",
            targetCloseDate: null,
            escalated: false,
            status: "open",
            impact: "",
            response: "",
            nextCheckDate: null,
            lineIds: [],
            periodIds: [],
            taskIds: [],
            result: "",
            evidence: "",
          },
      id: item?.id,
      revision: item?.revision,
    });
  };
  const editRecurrence = (item?: Recurrence) => {
    const fields = [
      field("title", "周期事项标题", "text", { required: true }),
      field("kind", "生成周期", "select", {
        options: [
          { value: "week", label: "每周" },
          { value: "month", label: "每月" },
        ],
      }),
      field("expectedResult", "交付要求", "area"),
      field("collectionSource", "材料来源"),
      field("waitingFor", "等待谁"),
      field("waitingWhat", "等待材料", "area"),
      field("followUpDate", "跟进日期", "date", { nullable: true }),
      field("enabled", "启用", "boolean"),
    ];
    showForm({
      title: item ? "编辑周期事项" : "新建周期事项",
      path: "/recurrences",
      fields,
      values: item
        ? pickValues(item, fields)
        : {
            title: "",
            kind: "week",
            expectedResult: "",
            collectionSource: "",
            waitingFor: "",
            waitingWhat: "",
            followUpDate: null,
            enabled: true,
          },
      id: item?.id,
      revision: item?.revision,
    });
  };
  const editMilestone = (item?: Milestone) => {
    const fields = [
      field("title", "里程碑标题", "text", { required: true }),
      field("project", "项目 / 专题"),
      field("expectedResult", "预期结果", "area"),
      field("nextAction", "下一步", "area"),
      field("taskIds", "关联行动任务", "multi", { options: taskOptions }),
      field("riskIds", "关联风险", "multi", {
        options: data.risks.map((r) => ({ value: r.id, label: r.title })),
      }),
      field("status", "阶段状态", "select", {
        options: ["planned", "doing", "done", "cancelled"].map((value) => ({
          value,
          label: stateLabels[value],
        })),
      }),
      field("plannedDate", "计划日期", "date", { nullable: true }),
      field("deliveryResult", "部署 / 交付成果", "area"),
      field("adoptionResult", "实际试用与业务效果", "area"),
      field("validation", "效果验证", "select", {
        options: [
          { value: "unverified", label: "未验证" },
          { value: "pending", label: "待验证" },
          { value: "passed", label: "通过" },
          { value: "failed", label: "失败" },
        ],
      }),
      field("validationNote", "验证依据", "area"),
    ];
    showForm({
      title: item ? "编辑专题里程碑" : "新建专题里程碑",
      path: "/milestones",
      fields,
      values: item
        ? pickValues(item, fields)
        : {
            title: "",
            project: "",
            expectedResult: "",
            nextAction: "",
            taskIds: [],
            riskIds: [],
            status: "planned",
            plannedDate: null,
            deliveryResult: "",
            adoptionResult: "",
            validation: "unverified",
            validationNote: "",
          },
      id: item?.id,
      revision: item?.revision,
    });
  };
  return (
    <>
      <PageHeading
        eyebrow="MANAGEMENT, WITH CONTEXT"
        title="看见重点，照应进展。"
        description="月目标与周阶段分别记录，协调行动、负责人反馈和实际交付各有依据。"
      >
        <Button primary onClick={() => editLine()}>
          <Plus size={15} />
          新建产线
        </Button>
      </PageHeading>
      <div className="tabs">
        {[
          ["lines", "产线月周重点"],
          ["risks", "风险与问题"],
          ["recurrences", "周期事项"],
          ["milestones", "项目 / AI 基建"],
        ].map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() => guard.protect(() => setTab(value))}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorNotice error={error} />
      {loading ? (
        <Busy />
      ) : (
        <>
          {tab === "lines" && <ProductionBoard
            lines={data.lines} periods={data.periods.filter(p => data.publicPeriodIds.includes(p.id))}
            risks={data.risks.filter(r => data.publicRiskIds.includes(r.id))} tasks={tasks}
            today={data.productionDate || today} onEditLine={editLine} onEditPeriod={editPeriod}
            onCarry={setCarry} onOpenTask={onOpen} onChanged={refresh}
          />}
          {tab === "risks" && (
            <>
              <div className="section-heading">
                <p className="muted">
                  完成处置行动不会自动关闭风险；关闭需记录结果和依据。
                </p>
                <Button primary onClick={() => editRisk()}>
                  <AlertTriangle size={14} />
                  记录风险
                </Button>
              </div>
              <div className="filter-row">
                <select aria-label="风险产线" value={riskLineFilter} onChange={e => setRiskLineFilter(e.target.value)}><option value="all">全部产线</option>{data.lines.map(line => <option value={line.id} key={line.id}>{line.name}</option>)}</select>
                <select aria-label="风险等级" value={riskLevelFilter} onChange={e => setRiskLevelFilter(e.target.value)}><option value="all">全部等级</option>{Object.entries(riskLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              </div>
              <div className="card-list">
                {data.risks.filter(r => (riskLineFilter === "all" || r.lineIds.includes(riskLineFilter)) && (riskLevelFilter === "all" || (r.level ?? "medium") === riskLevelFilter)).length ? (
                  data.risks.filter(r => (riskLineFilter === "all" || r.lineIds.includes(riskLineFilter)) && (riskLevelFilter === "all" || (r.level ?? "medium") === riskLevelFilter)).map((r) => (
                    <div key={r.id} data-testid={`risk-${r.id}`} className={`panel record-card ${riskWarning(r, data.productionDate || today) ? "risk-warning" : ""}`}>
                      <div className="section-heading">
                        <h3>{r.title}</h3>
                        <span
                          className={`badge ${r.status === "closed" ? "green" : "amber"}`}
                        >
                          {r.kind === "issue" ? "问题" : "风险"} ·{" "}
                          {stateLabels[r.status]}
                        </span>
                      </div>
                      <div className="task-meta"><span className={`badge ${r.level === "high" ? "red" : r.level === "low" ? "green" : "amber"}`}>{riskLevelLabels[r.level ?? "medium"]}等级</span>{r.escalated && <span className="badge red">已升级</span>}{r.status !== "closed" && r.targetCloseDate && r.targetCloseDate < (data.productionDate || today) && <span className="badge red">超期未闭环</span>}</div>
                      <p className="card-description">
                        {r.impact || "尚未记录影响"}
                      </p>
                      <p className="hint">
                        责任人：{r.owner || "待填写"} · 复查：
                        {r.nextCheckDate || "待安排"}
                      </p>
                      <p className="hint">目标闭环：{r.targetCloseDate || "待安排"} · 所属产线：{r.lineIds.map(id => data.lines.find(l => l.id === id)?.name || "未知产线").join("、") || "未关联"}</p>
                      <p className="hint">缓解措施：{r.response || "待补充"}</p>
                      <div className="inline-actions">
                        <Button onClick={() => editRisk(r)}>
                          更新处置 / 关闭
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty title="当前筛选暂无风险记录">
                    在偏差发生前记录影响、应对和检查日期。
                  </Empty>
                )}
              </div>
            </>
          )}
          {tab === "recurrences" && (
            <>
              <div className="section-heading">
                <div>
                  <h2>每期独立，同期只生成一次</h2>
                  <p className="hint">生成的任务统一在任务中心查看和跟进。</p>
                </div>
                <Button primary onClick={() => editRecurrence()}>
                  <Plus size={14} />
                  新建周期事项
                </Button>
              </div>
              <div className="card-list">
                {data.recurrences.length ? (
                  data.recurrences.map((r) => (
                    <div key={r.id} className="panel record-card">
                      <h3>
                        {r.title}{" "}
                        <span className="badge">
                          {r.kind === "week" ? "周" : "月"}周期 ·{" "}
                          {r.enabled ? "已启用" : "已停用"}
                        </span>
                      </h3>
                      <p className="card-description">{r.expectedResult}</p>
                      <p className="hint">
                        材料来源：{r.collectionSource || "未填写"} · 已生成{" "}
                        {r.occurrences.length} 期
                      </p>
                      <div className="inline-actions">
                        <Button onClick={() => editRecurrence(r)}>
                          编辑规则
                        </Button>
                        <Button
                          disabled={!r.enabled}
                          onClick={() => setMaterialize(r)}
                        >
                          <CalendarDays size={13} />
                          生成本期任务…
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty title="还没有周期事项">
                    为周总结、月总结建立可复用的材料收集任务。
                  </Empty>
                )}
              </div>
            </>
          )}
          {tab === "milestones" && (
            <>
              <div className="section-heading">
                <p className="muted">部署完成、实际试用和业务效果分别记录。</p>
                <Button primary onClick={() => editMilestone()}>
                  <Plus size={14} />
                  新建里程碑
                </Button>
              </div>
              <div className="card-list">
                {data.milestones.length ? (
                  data.milestones.map((m) => (
                    <div key={m.id} className="panel record-card">
                      <div className="section-heading">
                        <h3>{m.title}</h3>
                        <span className="badge">{stateLabels[m.status]}</span>
                      </div>
                      <p className="card-description">{m.expectedResult}</p>
                      <p className="hint">
                        {m.project} · 下一步：{m.nextAction || "待补充"}
                      </p>
                      <Button onClick={() => editMilestone(m)}>
                        记录交付与试用结果
                      </Button>
                    </div>
                  ))
                ) : (
                  <Empty title="用里程碑，记录长期价值">
                    关联既有任务，逐步验证交付和真实效果。
                  </Empty>
                )}
              </div>
            </>
          )}
        </>
      )}
      {form && (
        <RecordForm
          key={`${form.path}-${form.id || "new"}`}
          definition={form}
          onClose={() => setForm(null)}
          onSaved={refresh}
          guard={guard}
          notify={notify}
        />
      )}
      {carry && (
        <PeriodAction
          title="结转未完成重点"
          today={shiftDate(carry.end, 1)}
          kind={carry.kind}
          guard={guard}
          onClose={() => setCarry(null)}
          onSubmit={async (start, end, reason) => {
            await request(`/periods/${carry.id}/carry`, {
              method: "POST",
              body: JSON.stringify({
                revision: carry.revision,
                start,
                end,
                reason,
              }),
            });
            refresh();
            notify("重点已结转，原周期未完成事实保留");
          }}
        />
      )}
      {materialize && (
        <PeriodAction
          title="生成本期独立任务"
          today={today}
          kind={materialize.kind}
          guard={guard}
          onClose={() => setMaterialize(null)}
          onSubmit={async (start, end) => {
            const result = await request<{ task: Task; created: boolean }>(
              "/recurrences/materialize",
              {
                method: "POST",
                body: JSON.stringify({
                  recurrenceId: materialize.id,
                  start,
                  end,
                }),
              },
            );
            onTaskSaved(result.task);
            refresh();
            notify(
              result.created
                ? "本期任务已生成，可在任务中心查看"
                : "本期任务已存在，已保留同一条记录",
            );
          }}
        />
      )}
    </>
  );
}
function PeriodAction({
  title,
  today,
  kind,
  guard,
  onClose,
  onSubmit,
}: {
  title: string;
  today: string;
  kind: "week" | "month";
  guard: Guard;
  onClose: () => void;
  onSubmit: (start: string, end: string, reason: string) => Promise<void>;
}) {
  const [initialStart, initialEnd] = cycleRange(kind, today);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(
    () => guard.dirty(!!reason || start !== initialStart || end !== initialEnd),
    [reason, start, end, initialStart, initialEnd, guard],
  );
  return (
    <Modal title={title} onClose={() => guard.protect(onClose)}>
      <ErrorNotice error={error} />
      <div className="form-grid">
        <Field label="新周期开始">
          <input
            className="input"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="新周期结束">
          <input
            className="input"
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Field>
      </div>
      {title.includes("结转") && (
        <Field label="结转原因">
          <textarea
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      <div className="editor-actions">
        <Button
          primary
          disabled={
            busy || !start || !end || (title.includes("结转") && !reason.trim())
          }
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSubmit(start, end, reason);
              guard.dirty(false);
              onClose();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "正在提交…" : "确认提交"}
        </Button>
      </div>
    </Modal>
  );
}
export function ManagementSummary({ data, week, onNavigate }: { data: ManagementData; week: string; onNavigate: () => void }) {
  const today = data.productionDate || week.slice(0, 10);
  const periods = data.periods.filter(p => data.publicPeriodIds.includes(p.id));
  const risks = data.risks.filter(r => data.publicRiskIds.includes(r.id));
  return <Section title="产线本周" action={<button className="text-link" onClick={onNavigate}>管理概览 <ArrowRight size={12} /></button>}>
    {data.lines.some(l => !l.archived) ? <div className="management-summary">{data.lines.filter(l => !l.archived).map(line => {
      const overview = lineOverview(line, periods, risks, today);
      return <div key={line.id}><h3>{line.name}</h3>
        {overview.weeklyItems.length ? overview.weeklyItems.filter(p => p.status !== "cancelled").map(p => <div key={p.id}><p className="hint">{p.title}</p><span className={`badge ${progressState(p) === "blocked" ? "red" : progressState(p) === "at_risk" ? "amber" : "green"}`}>{progressLabels[progressState(p)]}</span><p className="hint">{p.actual || "尚未反馈"}</p></div>) : <p className="hint">暂无本周重点</p>}
        {overview.reminders.includes("weekly-update") && <p className="production-alert">请更新本周重点进展</p>}
        {overview.reminders.some(r => r.startsWith("initialize")) && <p className="hint">新周期待初始化，可新建或结转。</p>}
        {risks.filter(r => r.lineIds.includes(line.id) && riskWarning(r, today)).map(r => <p className="production-alert risk-warning" key={r.id} data-testid={`home-risk-${r.id}`}>{r.title} · {riskLevelLabels[r.level ?? "medium"]}等级{r.targetCloseDate && r.targetCloseDate < today ? " · 超期未闭环" : ""}</p>)}
      </div>;
    })}</div> : <div className="compact-empty">创建产线与本周重点后，在这里查看真实进展与偏差。</div>}
    <footer className="panel-footer">周范围 {cycleRange("week", today).join(" — ")} · Asia/Shanghai</footer>
  </Section>;
}
