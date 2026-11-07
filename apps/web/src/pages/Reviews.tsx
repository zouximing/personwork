import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Download, CheckCircle2, Trash2 } from "lucide-react";
import type { Task } from "../../../../packages/contracts/src/index";
import type {
  ReviewView,
  ReviewSections,
  ReviewSelections,
} from "../../../../packages/contracts/src/management";
import { nextWeekRange } from "../../../../packages/contracts/src/management";
import { api, download, errorText, request } from "../api";
import {
  Busy,
  Button,
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  type Guard,
  type Notify,
} from "../components/ui";
import { useManagement } from "./Management";

const labels: Record<keyof ReviewSections, string> = {
  accomplishments: "成果",
  progress: "进展",
  deviations: "偏差",
  risks: "风险",
  nextPlan: "下期计划",
  support: "需支持事项",
};
export function Reviews({
  tasks,
  today,
  week,
  guard,
  notify,
  aiControl,
}: {
  tasks: Task[];
  today: string;
  week: string;
  guard: Guard;
  notify: Notify;
  aiControl?: (
    review: ReviewView,
    onUpdated: (review: ReviewView) => void,
  ) => React.ReactNode;
}) {
  const [items, setItems] = useState<ReviewView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const management = useManagement();
  const reload = useCallback(async () => {
    try {
      setItems(await api.list<ReviewView>("/reviews"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const saved = (review: ReviewView) => {
    setItems((v) =>
      v.some((r) => r.id === review.id)
        ? v.map((r) => (r.id === review.id ? review : r))
        : [review, ...v],
    );
    setSelected(review.id);
  };
  const current = items.find((r) => r.id === selected);
  return (
    <>
      <PageHeading
        eyebrow="PROGRESS, WITH EVIDENCE"
        title="让进展，留下清晰的回声。"
        description="自动选择本周或本月事项，每项一行记录状态；进行中、未完成可补充简短原因。"
      >
        <Button
          primary
          onClick={() =>
            guard.protect(() => {
              guard.dirty(false);
              setCreate(true);
            })
          }
        >
          <Plus size={15} />
          新建回顾
        </Button>
      </PageHeading>
      <ErrorNotice error={error} />
      {loading ? (
        <Busy />
      ) : (
        <div className="prompt-layout">
          <aside className="panel prompt-list">
            {items.length ? (
              items.map((r) => (
                <button
                  key={r.id}
                  className={`prompt-item ${selected === r.id ? "selected" : ""}`}
                  onClick={() =>
                    guard.protect(() => {
                      guard.dirty(false);
                      setSelected(r.id);
                    })
                  }
                >
                  <span>
                    <strong>{r.title}</strong>
                    <small>
                      {r.start} — {r.end} ·{" "}
                      {r.status === "published" ? "已有交付版本" : "草稿"}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <Empty title="还没有回顾">从这个周期的真实推进开始。</Empty>
            )}
          </aside>
          {current ? (
            <ReviewEditor
              key={current.id}
              review={current}
              guard={guard}
              notify={notify}
              onSaved={saved}
              onDeleted={(id) => {
                setItems((values) => values.filter((item) => item.id !== id));
                setSelected(null);
                guard.dirty(false);
              }}
              aiControl={aiControl}
            />
          ) : (
            <div className="panel prompt-editor">
              <Empty
                title="选择事实，再写下判断"
                action={
                  <Button onClick={() => setCreate(true)}>
                    创建第一份回顾
                  </Button>
                }
              >
                系统按所选事实整理人工草稿，不会把未验证进展写成已交付成果。
              </Empty>
            </div>
          )}
        </div>
      )}
      {create && (
        <CreateReview
          tasks={tasks}
          today={today}
          week={week}
          management={management.data}
          managementLoading={management.loading}
          managementError={management.error}
          guard={guard}
          onClose={() => setCreate(false)}
          onSaved={saved}
          notify={notify}
        />
      )}
    </>
  );
}
function ReviewEditor({
  review,
  guard,
  notify,
  onSaved,
  onDeleted,
  aiControl,
}: {
  review: ReviewView;
  guard: Guard;
  notify: Notify;
  onSaved: (review: ReviewView) => void;
  onDeleted: (id: string) => void;
  aiControl?: (
    review: ReviewView,
    onUpdated: (review: ReviewView) => void,
  ) => React.ReactNode;
}) {
  const [title, setTitle] = useState(review.title);
  const [sections, setSections] = useState(review.sections);
  const [reportBody, setReportBody] = useState(review.reportBody || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReviewView | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const exportBlocked = Boolean(
    (review as ReviewView & { exportBlocked?: boolean }).exportBlocked,
  );
  const exportWarning =
    (review as ReviewView & { exportWarning?: string }).exportWarning ||
    "所选材料已标记为敏感，已阻止复制、导出和保存交付版本。";
  const dirty =
    title !== review.title ||
    reportBody !== (review.reportBody || "") ||
    JSON.stringify(sections) !== JSON.stringify(review.sections);
  useEffect(() => guard.dirty(dirty), [dirty, guard]);
  const save = async () => {
    setBusy("save");
    setError("");
    try {
      const value = await request<ReviewView>(`/reviews/${review.id}`, {
        method: "PATCH",
        body: JSON.stringify({ revision: review.revision, title, ...(review.format === "brief" ? { reportBody } : { sections }) }),
      });
      onSaved(value);
      guard.dirty(false);
      notify("回顾已保存");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    setBusy("publish");
    setError("");
    try {
      const value = await request<ReviewView>(`/reviews/${review.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ revision: review.revision }),
      });
      onSaved(value);
      notify(`已保留交付版本 ${value.versions.length}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const remove = async () => {
    if (!deleteTarget || busy) return;
    setBusy("delete");
    setDeleteError("");
    try {
      await request(`/reviews/${deleteTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: deleteTarget.revision, confirm: true }),
      });
      onDeleted(deleteTarget.id);
      notify("回顾已删除");
    } catch (e) {
      setDeleteError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const markdown = version === null ? review.markdown : review.versions.find(v => v.version === version)?.markdown || review.markdown;
  const exportMarkdown = async () => {
    const current = await request<ReviewView>(`/reviews/${review.id}`);
    if (current.exportBlocked) {
      onSaved(current);
      throw new Error(current.exportWarning);
    }
    if (version !== null) {
      const published = current.versions.find(v => v.version === version);
      if (!published) throw new Error("该交付版本已不存在，请重新读取回顾");
      return published.markdown;
    }
    return current.markdown;
  };
  return (
    <section className="panel prompt-editor">
      <div className="section-heading">
        <h2>回顾正文</h2>
        <span className={`badge ${dirty ? "amber" : ""}`}>
          {dirty
            ? "尚未保存"
            : review.status === "published"
              ? "交付版本已保留"
              : "已保存草稿"}
        </span>
      </div>
      <ErrorNotice error={error} />
      {exportBlocked && (
        <div className="notice error" role="alert">
          {exportWarning}
        </div>
      )}
      {review.differences?.some((d) => d.state !== "unchanged") && (
        <div className="notice">
          所选事实已发生变化。本草稿保留创建时快照，请核对差异；已交付版本保持不变。
        </div>
      )}
      <Field label="回顾标题">
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <p className="hint">
        {review.start} — {review.end} · {review.facts.length} 条事实快照 ·
        排除敏感材料 {review.excludedSensitiveCount} 条
      </p>
      {review.format === "brief" ? (
        <>
          <Field label="回顾报告">
            <textarea
              className="input"
              rows={12}
              maxLength={200000}
              value={reportBody}
              onChange={(e) => setReportBody(e.target.value)}
              placeholder="1、任务标题--完成&#10;2、任务标题--进行中，简短说明&#10;3、任务标题--未完成，简短原因"
            />
          </Field>
          <p className="hint">每项一行，按1、2、连续编号：1、任务标题--状态。完成只写“完成”；进行中、未完成可在后面补一句原因。状态取自创建回顾时的本地记录。</p>
        </>
      ) : <div className="review-sections">
        {Object.entries(labels).map(([key, label]) => (
          <Field label={label} key={key}>
            <textarea
              className="input"
              value={sections[key as keyof ReviewSections]}
              onChange={(e) =>
                setSections((v) => ({ ...v, [key]: e.target.value }))
              }
            />
          </Field>
        ))}
      </div>}
      <div className="editor-actions">
        <Button primary disabled={!!busy || !title.trim()} onClick={save}>
          <Save size={14} />
          {busy === "save" ? "正在保存…" : "保存回顾"}
        </Button>
        <Button
          disabled={
            dirty || !!busy || review.status === "published" || exportBlocked
          }
          onClick={publish}
        >
          <CheckCircle2 size={14} />
          保存交付版本
        </Button>
        <CopyButton
          body={exportBlocked ? "" : review.markdown}
          prepare={exportMarkdown}
          label="复制已保存回顾"
          notify={notify}
        />
        <Button
          disabled={exportBlocked || !!busy}
          onClick={async () => {
            setBusy("export"); setError("");
            try { download(new Blob([await exportMarkdown()], { type: "text/markdown;charset=utf-8" }), `${review.title}.md`); }
            catch (e) { setError(errorText(e)); }
            finally { setBusy(""); }
          }}
        >
          <Download size={14} />
          导出 Markdown
        </Button>
        <Button
          disabled={!!busy}
          onClick={() => {
            setDeleteError("");
            setDeleteTarget(review);
          }}
        >
          <Trash2 size={14} />
          删除回顾
        </Button>
      </div>
      <p className="hint">
        复制和导出使用已保存内容。交付版本仅保存在本工作台，不自动发布到外部系统。
      </p>
      {review.versions.length > 0 && (
        <>
          <p className="notice">已保留交付版本 {review.versions.length}</p>
          <Field label="查看已保留版本">
            <select
              value={version || ""}
              onChange={(e) =>
                setVersion(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">当前已保存草稿</option>
              {review.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  版本 {v.version} ·{" "}
                  {new Date(v.publishedAt).toLocaleString("zh-CN")}
                </option>
              ))}
            </select>
          </Field>
          {version && <pre className="markdown-preview">{markdown}</pre>}
        </>
      )}
      {aiControl?.(review, onSaved)}
      {deleteTarget && (
        <Modal
          title="删除回顾"
          onClose={() => { if (!busy) setDeleteTarget(null); }}
        >
          <p>确定删除“{deleteTarget.title}”？</p>
          <p className="notice error">
            将删除该回顾、事实快照、模型草稿及全部交付版本（{deleteTarget.versions.length} 个），无法直接撤销。关联任务和管理事项会保留。
          </p>
          {dirty && <p className="notice">当前未保存的修改也将丢弃。</p>}
          <ErrorNotice error={deleteError} />
          <div className="editor-actions">
            <Button disabled={!!busy} onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button disabled={!!busy} onClick={() => void remove()}>
              <Trash2 size={14} />
              {busy === "delete" ? "正在删除…" : "确认删除"}
            </Button>
          </div>
        </Modal>
      )}
      <details className="fact-details">
        <summary>查看所选事实与来源</summary>
        {review.facts.map((f) => (
          <div className="fact-row" key={`${f.kind}-${f.id}`}>
            <strong>{f.title}</strong>
            <p>
              {f.source} · {f.verification}
            </p>
            <small>
              {f.actual || "暂无进展正文"} ·{" "}
              {f.completedInRange ? "本期完成事实" : "进展事实"}
            </small>
          </div>
        ))}
      </details>
    </section>
  );
}
function CreateReview({
  tasks,
  today,
  week,
  management,
  managementLoading,
  managementError,
  guard,
  onClose,
  onSaved,
  notify,
}: {
  tasks: Task[];
  today: string;
  week: string;
  management: ReturnType<typeof useManagement>["data"];
  managementLoading: boolean;
  managementError: string;
  guard: Guard;
  onClose: () => void;
  onSaved: (review: ReviewView) => void;
  notify: Notify;
}) {
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  const [kind, setKind] = useState("week");
  const [start, setStart] = useState(week.slice(0, 10) || today);
  const [end, setEnd] = useState(week.slice(-10) || today);
  const title = customTitle ?? (kind === "month" ? `${start.slice(0, 7)} 月回顾` : `${start} 周回顾`);
  const [selections, setSelections] = useState<ReviewSelections>({
    taskIds: [],
    periodIds: [],
    riskIds: [],
    milestoneIds: [],
  });
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(true);
  const [selectionError, setSelectionError] = useState("");
  const [includeNextWeekPlan, setIncludeNextWeekPlan] = useState(true);
  const [nextWeekTaskIds, setNextWeekTaskIds] = useState<string[]>([]);
  const [selectingPlan, setSelectingPlan] = useState(true);
  const [planError, setPlanError] = useState("");
  const planRange = end ? nextWeekRange(end) : null;
  const [error, setError] = useState("");
  useEffect(() => guard.dirty(true), [guard]);
  useEffect(() => {
    const controller = new AbortController();
    setSelecting(true);
    setSelectionError("");
    setSelections({ taskIds: [], periodIds: [], riskIds: [], milestoneIds: [] });
    if (!start || !end || start > end) {
      setSelecting(false);
      setSelectionError("请选择有效的开始与结束日期");
      return () => controller.abort();
    }
    const query = new URLSearchParams({ kind, start, end });
    void request<ReviewSelections>(`/reviews/selections?${query}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setSelections(value); })
      .catch((e: unknown) => { if (!controller.signal.aborted) setSelectionError(`自动选取失败：${errorText(e)}，请调整周期重试。`); })
      .finally(() => { if (!controller.signal.aborted) setSelecting(false); });
    return () => controller.abort();
  }, [kind, start, end]);
  useEffect(() => {
    const controller = new AbortController();
    setNextWeekTaskIds([]);
    setPlanError("");
    setSelectingPlan(includeNextWeekPlan);
    if (!includeNextWeekPlan || !end) {
      setSelectingPlan(false);
      return () => controller.abort();
    }
    const query = new URLSearchParams({ kind: "week", purpose: "plan", ...nextWeekRange(end) });
    void request<ReviewSelections>(`/reviews/selections?${query}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setNextWeekTaskIds(value.taskIds); })
      .catch((e: unknown) => { if (!controller.signal.aborted) setPlanError(`下周计划选取失败：${errorText(e)}，请调整结束日期重试，或取消下周计划。`); })
      .finally(() => { if (!controller.signal.aborted) setSelectingPlan(false); });
    return () => controller.abort();
  }, [includeNextWeekPlan, end]);
  const changeKind = (value: string) => {
    setKind(value);
    if (value === "month") {
      setStart(`${today.slice(0, 7)}-01`);
      setEnd(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10));
    } else {
      setStart(week.slice(0, 10) || today);
      setEnd(week.slice(-10) || today);
    }
  };
  const select = (key: keyof ReviewSelections, id: string, checked: boolean) =>
    setSelections((v) => ({
      ...v,
      [key]: checked ? [...v[key], id] : v[key].filter((value) => value !== id),
    }));
  const save = async () => {
    if (selecting || selectionError || busy || managementLoading || managementError || missingSelections || planBlocked) return;
    setBusy(true);
    setError("");
    try {
      const value = await request<ReviewView>("/reviews", {
        method: "POST",
        body: JSON.stringify({ title, kind, start, end, selections, includeNextWeekPlan, nextWeekTaskIds: includeNextWeekPlan ? nextWeekTaskIds : [] }),
      });
      onSaved(value);
      guard.dirty(false);
      onClose();
      notify("回顾报告已创建，可补充进行中或未完成的原因");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const groups: {
    key: keyof ReviewSelections;
    label: string;
    items: { id: string; title: string }[];
  }[] = [
    {
      key: "taskIds",
      label: "个人与管理行动",
      items: tasks.filter(
        (t) => !t.sensitive && !["people", "recruitment"].includes(t.type),
      ),
    },
    { key: "periodIds", label: "产线月周重点", items: management.periods },
    {
      key: "riskIds",
      label: "风险与问题",
      items: management.risks.filter((r) => !r.sensitive),
    },
    { key: "milestoneIds", label: "专题里程碑", items: management.milestones },
  ];
  const missingSelections = !selecting && !managementLoading && !managementError && groups.some(group => {
    const availableIds = new Set(group.items.map(item => item.id));
    return selections[group.key].some(id => !availableIds.has(id));
  });
  const planTasks = tasks.filter(task => !task.archived && !task.sensitive && !["people", "recruitment"].includes(task.type) && !["done", "cancelled"].includes(task.status));
  const missingPlanSelections = !selectingPlan && nextWeekTaskIds.some(id => !planTasks.some(task => task.id === id));
  const planBlocked = includeNextWeekPlan && (selectingPlan || !!planError || missingPlanSelections);
  return (
    <Modal
      title="选择周期与事实材料"
      wide
      onClose={() => guard.protect(onClose)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorNotice error={error} />
        <ErrorNotice error={selectionError} />
        <ErrorNotice error={managementError ? `材料列表读取失败：${managementError}，请关闭窗口并刷新页面后重试。` : missingSelections ? "部分选中事项尚未显示，请关闭窗口并刷新页面后重试。" : ""} />
        <Field label="回顾标题">
          <input
            className="input"
            required
            value={title}
            onChange={(e) => setCustomTitle(e.target.value)}
          />
        </Field>
        <div className="form-grid">
          <Field label="周期类型">
            <select value={kind} onChange={(e) => changeKind(e.target.value)}>
              <option value="week">周回顾</option>
              <option value="month">月回顾</option>
            </select>
          </Field>
          <Field label="开始日期">
            <input
              className="input"
              type="date"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="结束日期">
            <input
              className="input"
              type="date"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
        </div>
        <p className="notice">
          {selecting || managementLoading ? "正在读取并选择本期事项…" : "已按周期自动勾选，可手动增减；调整周期会重新选择。"}
          任务仅在计划、开始、截止、跟进或实际完成日期落在本期时默认勾选；新增、同步、编辑或关联本身不触发勾选。管理事项按所属周期、日期或本期活动选取；取消事项默认不选，敏感材料排除。
        </p>
        {kind === "week" && <p className="notice">周报另自动附加“产线进展”：各线本周重点、受阻／有风险项和风险新增／闭环。下方个人简报选材不取消该节；创建后可编辑正文。</p>}
        {groups.map((group) => (
          <div key={group.key} className="field" role="group" aria-label={group.label}>
            <span>{group.label}</span>
            <div className="selection-list">
              {group.items.length ? (
                group.items.map((item) => (
                  <label className="check-line" key={item.id}>
                    <input
                      type="checkbox"
                      disabled={selecting || !!selectionError || managementLoading || !!managementError || missingSelections}
                      checked={selections[group.key].includes(item.id)}
                      onChange={(e) =>
                        select(group.key, item.id, e.target.checked)
                      }
                    />
                    {item.title}
                  </label>
                ))
              ) : (
                <span className="muted">暂无可选材料</span>
              )}
            </div>
          </div>
        ))}
        <label className="check-line">
          <input type="checkbox" checked={includeNextWeekPlan} onChange={e => setIncludeNextWeekPlan(e.target.checked)} />
          下周计划
        </label>
        {includeNextWeekPlan && (
          <div className="field" role="group" aria-label="下周计划事项">
            <p className="notice">
              {planRange ? `${planRange.start} — ${planRange.end}。` : "请先选择结束日期。"}
              {selectingPlan ? "正在选择下周事项…" : "默认勾选计划日期在下周的未完成事项，可手动增减；调整结束日期会重新选择。"}
              报告中的下周计划单独从1开始编号。
            </p>
            <ErrorNotice error={planError || (missingPlanSelections ? "部分下周计划事项尚未显示，请刷新页面重试，或取消下周计划。" : "")} />
            <div className="selection-list">
              {planTasks.length ? planTasks.map(task => (
                <label className="check-line" key={task.id}>
                  <input type="checkbox" aria-label={`下周计划：${task.title}`} disabled={selectingPlan || !!planError || missingPlanSelections}
                    checked={nextWeekTaskIds.includes(task.id)}
                    onChange={e => setNextWeekTaskIds(ids => e.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />
                  {task.title}
                </label>
              )) : <span className="muted">暂无可选事项</span>}
            </div>
          </div>
        )}
        <div className="editor-actions">
          <Button primary type="submit" disabled={busy || selecting || !!selectionError || managementLoading || !!managementError || missingSelections || planBlocked || !title.trim()}>
            {busy ? "正在整理事实…" : "创建事实草稿"}
          </Button>
          <Button onClick={() => guard.protect(onClose)}>取消</Button>
        </div>
      </form>
    </Modal>
  );
}
