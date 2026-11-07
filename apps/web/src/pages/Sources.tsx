import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  GitPullRequest,
  Search,
  Save,
  Link2,
  Send,
  RefreshCw,
} from "lucide-react";
import type { Task } from "../../../../packages/contracts/src/index";
import {
  reviewStatuses,
  isMergeRequest,
  sourceNumber,
  sourceAssignmentLabel,
  type SourceObject,
  type Writeback,
} from "../../../../packages/contracts/src/sources";
import { api, errorText, request } from "../api";
import {
  Busy,
  Button,
  Empty,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  type Guard,
  type Notify,
} from "../components/ui";
import { Tasks } from "./Tasks";

const reviewLabels: Record<string, string> = {
  not_started: "待审",
  reviewing: "评审中",
  waiting_author: "等待作者修改",
  reviewed: "本轮已评审",
  follow_up: "后续跟进",
};
const writeLabels: Record<string, string> = {
  preview: "待提交预览",
  submitting: "提交中",
  uncertain: "结果待核实",
  confirmed: "已核实成功",
  conflict: "冲突",
  blocked: "操作受阻",
  failed: "失败",
};
export function TaskCenter({
  tasks,
  onOpen,
  onCapture,
  onComplete,
  initialQuery,
  guard,
  notify,
  onSourcesChanged,
  sourceRecords,
  today, onTaskSaved, onTaskDeleted,
}: {
  tasks: Task[];
  onOpen: (task: Task) => void;
  onCapture: () => void;
  onComplete: (task: Task) => void;
  initialQuery: string;
  guard: Guard;
  notify: Notify;
  onSourcesChanged: () => void;
  sourceRecords: SourceObject[];
  today: string;
  onTaskSaved: (task: Task) => void;
  onTaskDeleted: (id: string) => void;
}) {
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get("tab") === "mr" ? "mr" : "local");
  return (
    <>
      <div className="tabs task-tabs">
        {[
          ["local", "行动清单"],
          ["mr", "MR 评审"],
          ["sources", "来源任务与关联"],
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
      {tab === "local" ? (
        <Tasks
          tasks={tasks}
          sourceRecords={sourceRecords}
          onOpen={onOpen}
          onCapture={onCapture}
          onComplete={onComplete}
          initialQuery={initialQuery}
          today={today}
          onSaved={onTaskSaved}
          onDeleted={onTaskDeleted}
          guard={guard}
          notify={notify}
        />
      ) : (
        <SourcesBoard
          mr={tab === "mr"}
          tasks={tasks}
          onOpen={onOpen}
          guard={guard}
          notify={notify}
          onChanged={onSourcesChanged}
        />
      )}
    </>
  );
}
function SourcesBoard({
  mr,
  tasks,
  onOpen,
  guard,
  notify,
  onChanged,
}: {
  mr: boolean;
  tasks: Task[];
  onOpen: (task: Task) => void;
  guard: Guard;
  notify: Notify;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<SourceObject[]>([]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("source"));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [review, setReview] = useState("all");
  const [project, setProject] = useState("all");
  const [author, setAuthor] = useState("all");
  const [provider, setProvider] = useState("all");
  const reload = useCallback(async () => {
    try {
      setItems(await api.list<SourceObject>("/source-records"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const visible = items.filter(
    (s) =>
      (!mr || isMergeRequest(s)) &&
      (provider === "all" || s.provider === provider) &&
      (project === "all" || s.projectId === project) &&
      (author === "all" || s.author === author) &&
      (review === "all" ||
        (review === "needs_review"
          ? s.needsReview
          : s.reviewStatus === review)) &&
      `${s.title} ${sourceNumber(s)} ${s.projectName}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const current = items.find((s) => s.id === selected);
  return (
    <>
      <PageHeading
        eyebrow={mr ? "REVIEW THE CURRENT VERSION" : "SOURCE FACTS"}
        title={mr ? "对照版本，留下评审依据。" : "来源事实，连到个人行动。"}
        description={
          mr
            ? "当前提交与已检查版本分别保存。合并状态不会自动结束本人评审。"
            : "编号、实例与原始状态独立保留；来源刷新不覆盖个人计划。"
        }
      />
      <ErrorNotice error={error} />
      <div className="filter-row">
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="搜索来源记录"
            placeholder="搜索标题、编号、项目"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {mr ? (
          <select
            aria-label="本人评审进展"
            value={review}
            onChange={(e) => setReview(e.target.value)}
          >
            <option value="all">全部评审进展</option>
            <option value="needs_review">新版本待复查</option>
            {reviewStatuses.map((value) => (
              <option key={value} value={value}>
                {reviewLabels[value]}
              </option>
            ))}
          </select>
        ) : (
          <select
            aria-label="来源类型"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="all">全部来源</option>
            <option value="pingcode">PingCode</option>
            <option value="gitlab">GitLab</option>
          </select>
        )}
        <select
          aria-label="来源项目"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="all">全部项目</option>
          {[
            ...new Map(
              items.map((s) => [s.projectId, s.projectName]),
            ).entries(),
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label || value}
            </option>
          ))}
        </select>
        {mr && (
          <select
            aria-label="MR 作者"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          >
            <option value="all">全部作者</option>
            {[...new Set(items.map((s) => s.author).filter(Boolean))].map(
              (value) => (
                <option key={value}>{value}</option>
              ),
            )}
          </select>
        )}
        <Button onClick={reload}>
          <RefreshCw size={13} />
          重新读取
        </Button>
      </div>
      {loading ? (
        <Busy />
      ) : (
        <div className="card-list">
          {visible.length ? (
            visible.map((s) => (
              <article className="panel record-card" key={s.id}>
                <div className="section-heading">
                  <h3>
                    <button
                      className="task-title"
                      onClick={() => setSelected(s.id)}
                    >
                      {isMergeRequest(s) && <GitPullRequest size={15} />}{" "}
                      {s.title}
                    </button>
                  </h3>
                  <span className="badge">
                    {s.sourceState || "来源未返回状态"}
                  </span>
                </div>
                <div className="task-meta">
                  <span>
                    {s.provider === "pingcode" ? "PingCode" : "GitLab"} ·{" "}
                    {sourceNumber(s)}
                  </span>
                  <span>{s.projectName || s.projectId}</span>
                  {s.provider === "gitlab" && (
                    <span>作者：{s.author || "未返回"}</span>
                  )}
                  {sourceAssignmentLabel(s) && (
                    <span className="badge green">{sourceAssignmentLabel(s)}</span>
                  )}
                  {s.needsReview && (
                    <span className="badge amber">当前版本待复查</span>
                  )}
                </div>
                {s.attentionReason && (
                  <p className="notice">{s.attentionReason}</p>
                )}
                {isMergeRequest(s) && (
                  <p className="hint">
                    评审：{reviewLabels[s.reviewStatus]} · 当前{" "}
                    {s.currentSha?.slice(0, 12) || "未知"} / 已检查{" "}
                    {s.checkedSha?.slice(0, 12) || "未记录"}
                  </p>
                )}
                <div className="inline-actions">
                  <Button onClick={() => setSelected(s.id)}>查看与记录</Button>
                  {s.url && (
                    <a
                      className="btn"
                      target="_blank"
                      rel="noreferrer"
                      href={s.url}
                    >
                      <ExternalLink size={13} />
                      打开来源
                    </a>
                  )}
                </div>
                <footer>
                  最后看到来源：{new Date(s.lastSeenAt).toLocaleString("zh-CN")}{" "}
                  · 来源截止：{s.sourceDueDate || "未返回"}
                </footer>
              </article>
            ))
          ) : (
            <Empty title={mr ? "还没有同步到 MR" : "还没有同步来源记录"}>
              先在设置中配置并实际同步来源，再查看真实编号与状态。
            </Empty>
          )}
        </div>
      )}
      {current && (
        <SourceDetail
          key={current.id}
          source={current}
          all={items}
          tasks={tasks}
          onOpen={onOpen}
          guard={guard}
          notify={notify}
          onClose={() => setSelected(null)}
          onSaved={(value) => {
            setItems((v) => v.map((s) => (s.id === value.id ? value : s)));
            onChanged();
          }}
        />
      )}
    </>
  );
}
function SourceDetail({
  source,
  all,
  tasks,
  onOpen,
  guard,
  notify,
  onClose,
  onSaved,
}: {
  source: SourceObject;
  all: SourceObject[];
  tasks: Task[];
  onOpen: (task: Task) => void;
  guard: Guard;
  notify: Notify;
  onClose: () => void;
  onSaved: (source: SourceObject) => void;
}) {
  const [review, setReview] = useState({
    reviewStatus: source.reviewStatus,
    checkedSha: source.checkedSha,
    conclusion: source.conclusion,
    followUpDate: source.followUpDate,
  });
  const [bindTask, setBindTask] = useState(source.localTaskId || "");
  const [links, setLinks] = useState(source.linkedSourceIds || []);
  const [comment, setComment] = useState("");
  const [field, setField] = useState<"comment" | "state">("comment");
  const [writeback, setWriteback] = useState<Writeback | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const dirty =
    JSON.stringify(review) !==
      JSON.stringify({
        reviewStatus: source.reviewStatus,
        checkedSha: source.checkedSha,
        conclusion: source.conclusion,
        followUpDate: source.followUpDate,
      }) ||
    bindTask !== (source.localTaskId || "") ||
    JSON.stringify(links) !== JSON.stringify(source.linkedSourceIds || []) ||
    !!comment;
  useEffect(() => guard.dirty(dirty), [dirty, guard]);
  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const task = tasks.find((t) => t.id === source.localTaskId);
  return (
    <Modal title={source.title} wide onClose={() => guard.protect(onClose)}>
      <ErrorNotice error={error} />
      <div className="source-facts">
        <p>
          {source.provider === "gitlab" ? "GitLab" : "PingCode"} ·{" "}
          {source.projectName} · {sourceNumber(source)}
        </p>
        <p className="hint">
          来源状态：{source.sourceState} · 截止：
          {source.sourceDueDate || "未返回"} · 实例：{source.instanceId}
        </p>
        {source.url && (
          <a href={source.url} target="_blank" rel="noreferrer">
            打开原始页面 <ExternalLink size={12} />
          </a>
        )}
      </div>
      {task && (
        <div className="notice">
          <span>个人行动：{task.title}</span>
          <Button
            onClick={() =>
              guard.protect(() => {
                onClose();
                onOpen(task);
              })
            }
          >
            打开个人安排
          </Button>
        </div>
      )}
      {isMergeRequest(source) && (
        <>
          <div className="notice">
            当前版本：<code>{source.currentSha || "未知"}</code>
            <br />
            已检查：<code>{source.checkedSha || "未记录"}</code>
            {source.needsReview && " · 新版本需复查，旧结论保留"}
          </div>
          <div className="form-grid">
            <Field label="本人评审进展">
              <select
                value={review.reviewStatus}
                onChange={(e) =>
                  setReview((v) => ({
                    ...v,
                    reviewStatus: e.target
                      .value as SourceObject["reviewStatus"],
                  }))
                }
              >
                {reviewStatuses.map((value) => (
                  <option key={value} value={value}>
                    {reviewLabels[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="复查日期">
              <input
                className="input"
                type="date"
                value={review.followUpDate || ""}
                onChange={(e) =>
                  setReview((v) => ({
                    ...v,
                    followUpDate: e.target.value || null,
                  }))
                }
              />
            </Field>
          </div>
          <Field label="已检查提交 SHA">
            <input
              className="input"
              value={review.checkedSha || ""}
              onChange={(e) =>
                setReview((v) => ({ ...v, checkedSha: e.target.value || null }))
              }
            />
          </Field>
          <Button
            disabled={!source.currentSha}
            onClick={() =>
              setReview((v) => ({ ...v, checkedSha: source.currentSha }))
            }
          >
            记为已检查当前版本
          </Button>
          <Field label="评审结论与未解决事项">
            <textarea
              className="input"
              value={review.conclusion}
              onChange={(e) =>
                setReview((v) => ({ ...v, conclusion: e.target.value }))
              }
            />
          </Field>
          <div className="editor-actions">
            <Button
              primary
              disabled={!!busy}
              onClick={() =>
                act("review", async () => {
                  const result = await request<SourceObject>(
                    `/source-records/${source.id}/review`,
                    {
                      method: "PATCH",
                      body: JSON.stringify({
                        revision: source.revision,
                        ...review,
                      }),
                    },
                  );
                  onSaved(result);
                  notify("本人评审记录已保存，GitLab 保持只读");
                })
              }
            >
              <Save size={14} />
              保存评审记录
            </Button>
          </div>
        </>
      )}
      <details className="fact-details">
        <summary>来源关联与本地绑定</summary>
        <Field label="绑定到任务中心已有任务">
          <select
            value={bindTask}
            onChange={(e) => setBindTask(e.target.value)}
          >
            <option value="">选择本地任务</option>
            {tasks
              .filter((t) => !t.sensitive)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </Field>
        <Button
          disabled={!!busy || !bindTask || bindTask === source.localTaskId}
          onClick={() =>
            act("bind", async () => {
              const result = await request<SourceObject>(
                `/source-records/${source.id}/bind`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    revision: source.revision,
                    taskId: bindTask,
                  }),
                },
              );
              onSaved(result);
              notify("来源与任务中心任务已绑定");
            })
          }
        >
          <Link2 size={13} />
          确认绑定（保留个人安排）
        </Button>
        <Field
          label={`关联 ${source.provider === "pingcode" ? "GitLab 事项" : "PingCode 任务"}`}
        >
          <div className="selection-list">
            {all
              .filter((s) => s.provider !== source.provider)
              .map((s) => (
                <label className="check-line" key={s.id}>
                  <input
                    type="checkbox"
                    checked={links.includes(s.id)}
                    onChange={(e) =>
                      setLinks((v) =>
                        e.target.checked
                          ? [...v, s.id]
                          : v.filter((id) => id !== s.id),
                      )
                    }
                  />
                  {s.projectName} · {sourceNumber(s)} · {s.title}
                </label>
              ))}
          </div>
        </Field>
        <Button
          disabled={!!busy}
          onClick={() =>
            act("links", async () => {
              onSaved(
                await request<SourceObject>(
                  `/source-records/${source.id}/links`,
                  {
                    method: "PUT",
                    body: JSON.stringify({
                      revision: source.revision,
                      sourceRecordIds: links,
                    }),
                  },
                ),
              );
              notify("来源间关联已保存");
            })
          }
        >
          保存来源关联
        </Button>
      </details>
      {source.provider === "pingcode" && (
        <details className="fact-details">
          <summary>准备受控回写</summary>
          <p className="notice">
            只发送下方明确选定的字段与内容，私人备注和个人计划不会自动发出。状态写入需要真实实例具备并发保护。
          </p>
          <Field label="回写字段">
            <select
              value={field}
              onChange={(e) => {
                setField(e.target.value as typeof field);
                setWriteback(null);
              }}
            >
              <option value="comment">选定进展评论</option>
              <option value="state">来源状态 ID</option>
            </select>
          </Field>
          <Field
            label={field === "comment" ? "要发送的评论正文" : "目标来源状态 ID"}
          >
            <textarea
              className="input"
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setWriteback(null);
              }}
            />
          </Field>
          <div className="editor-actions">
            <Button
              disabled={!!busy || !comment.trim()}
              onClick={() =>
                act("preview", async () => {
                  const result = await request<Writeback>("/writebacks", {
                    method: "POST",
                    body: JSON.stringify({
                      sourceRecordId: source.id,
                      field,
                      value: comment,
                      expectedValue:
                        field === "state" ? source.sourceStateId : undefined,
                      requestId: crypto.randomUUID(),
                    }),
                  });
                  setWriteback(result);
                  setComment("");
                  notify("回写预览已保存，请核对目标和实际内容");
                })
              }
            >
              保存并查看回写预览
            </Button>
          </div>
          {writeback && (
            <WritebackPreview
              value={writeback}
              onUpdated={setWriteback}
              notify={notify}
            />
          )}
        </details>
      )}
    </Modal>
  );
}
export function WritebackPreview({
  value,
  onUpdated,
  notify,
}: {
  value: Writeback;
  onUpdated: (value: Writeback) => void;
  notify: Notify;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (action: "submit" | "verify") => {
    setBusy(true);
    setError("");
    try {
      const updated = await request<Writeback>(
        `/writebacks/${value.id}/${action}`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onUpdated(updated);
      notify(`回写结果：${writeLabels[updated.status]}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="result-box">
      <ErrorNotice error={error} />
      <div className="section-heading">
        <h3>回写预览 · {value.targetNumber}</h3>
        <span
          className={`badge ${value.status === "confirmed" ? "green" : "amber"}`}
        >
          {writeLabels[value.status]}
        </span>
      </div>
      <p>{value.targetTitle}</p>
      <p className="hint">
        目标：{value.targetUrl}
        <br />
        原值：{value.expectedValue || "不适用"} · 字段：{value.field}
      </p>
      <pre>{value.outboundValue}</pre>
      <p className="hint">{value.statusNote}</p>
      <div className="editor-actions">
        <Button
          primary
          disabled={busy || value.status !== "preview"}
          onClick={() => act("submit")}
        >
          <Send size={13} />
          确认提交本次回写
        </Button>
        <Button
          disabled={
            busy ||
            !["uncertain", "submitting", "failed"].includes(value.status)
          }
          onClick={() => act("verify")}
        >
          <RefreshCw size={13} />
          核实来源结果
        </Button>
      </div>
      <p className="hint">结果待核实时先检查来源，不盲目重复提交。</p>
    </div>
  );
}
