import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Play,
  Pause,
  Square,
  ShieldCheck,
  FileCheck,
  RefreshCw,
} from "lucide-react";
import type { Task } from "../../../../packages/contracts/src/index";
import type {
  Execution,
  ExecutionInput,
} from "../../../../packages/contracts/src/executions";
import type { ModelDataClass } from "../../../../packages/contracts/src/models";
import type {
  SourceObject,
  Writeback,
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
import { useModels, ModelChoice } from "./Models";
import { useManagement } from "./Management";

const labels: Record<Execution["status"], string> = {
  awaiting_authorization: "待单次授权",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成并核验",
  failed: "失败",
  partial: "部分完成",
  cancelled: "已取消",
  pending_verification: "结果待核实",
};
const toolLabels: Record<string, string> = {
  read_records: "读取所选事实",
  save_markdown: "保存 Markdown 文件",
  submit_writeback: "提交选定 PingCode 回写",
  verify_writeback: "核实选定回写结果",
};
export function Executions({
  tasks,
  instruction,
  guard,
  notify,
  onInstructionUsed,
}: {
  tasks: Task[];
  instruction: string;
  guard: Guard;
  notify: Notify;
  onInstructionUsed: () => void;
}) {
  const [items, setItems] = useState<Execution[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(!!instruction);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      setItems(await api.list<Execution>("/executions"));
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (items.some((item) => item.status === "running")) {
      const timer = setInterval(() => void reload(), 1500);
      return () => clearInterval(timer);
    }
  }, [items, reload]);
  const current = items.find((e) => e.id === selected);
  const saved = (execution: Execution) => {
    setItems((v) =>
      v.some((e) => e.id === execution.id)
        ? v.map((e) => (e.id === execution.id ? execution : e))
        : [execution, ...v],
    );
    setSelected(execution.id);
  };
  const act = async (action: "authorize" | "pause" | "stop") => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      const updated = await request<Execution>(
        `/executions/${current.id}/${action === "authorize" ? "authorize" : "stop"}`,
        {
          method: "POST",
          body: JSON.stringify(
            action === "authorize"
              ? { revision: current.revision }
              : { pause: action === "pause" },
          ),
        },
      );
      saved(updated);
      notify(
        action === "authorize"
          ? "本次范围已授权，后台已开始执行"
          : action === "pause"
            ? "已请求暂停后续步骤，请核对已发出操作"
            : "已请求停止后续步骤，请核对实际影响",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading
        eyebrow="ACTIONS YOU CAN VERIFY"
        title="看清计划，再授权行动。"
        description="真实工具、明确范围、单次授权。文字回复不算完成，产物与来源回执需要核验。"
      >
        <Button primary onClick={() => guard.protect(() => setCreate(true))}>
          <Plus size={15} />
          新建执行计划
        </Button>
      </PageHeading>
      <ErrorNotice error={error} />
      {loading ? (
        <Busy />
      ) : (
        <div className="prompt-layout">
          <aside className="panel prompt-list">
            {items.length ? (
              items.map((item) => (
                <button
                  key={item.id}
                  className={`prompt-item ${selected === item.id ? "selected" : ""}`}
                  onClick={() => guard.protect(() => setSelected(item.id))}
                >
                  <Play size={15} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {labels[item.status]} ·{" "}
                      {new Date(item.updatedAt).toLocaleString("zh-CN")}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <Empty title="还没有执行计划">
                从一个范围明确、结果可核验的任务开始。
              </Empty>
            )}
          </aside>
          {current ? (
            <section className="panel prompt-editor">
              <div className="section-heading">
                <h2>{current.title}</h2>
                <span
                  className={`badge ${current.status === "completed" ? "green" : "amber"}`}
                >
                  {labels[current.status]}
                </span>
              </div>
              <p className="notice">
                {current.statusNote || "请核对计划中的材料、工具、目录和预算。"}
              </p>
              <div className="execution-plan">
                <h3>
                  <ShieldCheck size={15} /> 本次授权范围
                </h3>
                <p>{current.instruction}</p>
                <ul>
                  {current.plan.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ul>
                <dl>
                  <dt>模型配置版本</dt>
                  <dd>{current.modelConfigurationRevision}</dd>
                  <dt>固定产物目录</dt>
                  <dd>{current.outputDir}</dd>
                  <dt>预算</dt>
                  <dd>
                    最多 {current.maxSteps} 步 · 已调用 {current.calls} 次 ·{" "}
                    {current.tokenUsageKnown
                      ? `${current.tokens} tokens`
                      : "上游未完整返回用量"}
                  </dd>
                  <dt>工具</dt>
                  <dd>
                    {current.allowedTools
                      .map((tool) => toolLabels[tool])
                      .join(" / ")}
                  </dd>
                  <dt>材料</dt>
                  <dd>
                    {current.taskIds.length} 项任务、
                    {current.sourceRecordIds.length} 条来源、
                    {current.periodIds.length} 个周期重点、
                    {current.riskIds.length} 个风险
                  </dd>
                  <dt>回写范围</dt>
                  <dd>{current.writebackIds.length} 条已保存预览</dd>
                </dl>
              </div>
              <div className="editor-actions">
                {current.status === "awaiting_authorization" && (
                  <Button
                    primary
                    disabled={busy}
                    onClick={() => act("authorize")}
                  >
                    <ShieldCheck size={14} />
                    单次授权并开始执行
                  </Button>
                )}
                {current.status === "running" && (
                  <>
                    <Button disabled={busy} onClick={() => act("pause")}>
                      <Pause size={14} />
                      暂停后续步骤
                    </Button>
                    <Button disabled={busy} onClick={() => act("stop")}>
                      <Square size={14} />
                      停止后续步骤
                    </Button>
                  </>
                )}
                <Button disabled={busy} onClick={reload}>
                  <RefreshCw size={13} />
                  刷新执行状态
                </Button>
              </div>
              {[
                "paused",
                "partial",
                "cancelled",
                "pending_verification",
              ].includes(current.status) && (
                <p className="hint">
                  已发出的操作按实际结果核实。重新开始需要建立新计划并重新授权，不自动重复成功写入。
                </p>
              )}
              <div className="fact-details">
                <h3>工具步骤</h3>
                {current.steps.length ? (
                  current.steps.map((step) => (
                    <div className="fact-row" key={step.id}>
                      <strong>
                        {toolLabels[step.tool] || step.tool} · {step.status}
                      </strong>
                      <p>{new Date(step.at).toLocaleString("zh-CN")}</p>
                      <pre>{step.result}</pre>
                    </div>
                  ))
                ) : (
                  <p className="hint">尚未执行任何工具步骤。</p>
                )}
              </div>
              <div className="fact-details">
                <h3>
                  <FileCheck size={15} /> 产物与核验
                </h3>
                {current.artifacts.length ? (
                  current.artifacts.map((artifact, index) => (
                    <div className="fact-row" key={index}>
                      <code>{artifact.path}</code>
                      <p>
                        {artifact.bytes} bytes · SHA-256 {artifact.sha256}
                      </p>
                      <p>
                        核验于{" "}
                        {new Date(artifact.verifiedAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="hint">尚无已核验文件产物。</p>
                )}
                <p className="hint">
                  {current.verification || "尚未形成核验结论。"}
                </p>
                {current.finalText && (
                  <pre className="markdown-preview">{current.finalText}</pre>
                )}
              </div>
            </section>
          ) : (
            <div className="panel prompt-editor">
              <Empty
                title="执行有边界，结果有依据"
                action={
                  <Button onClick={() => setCreate(true)}>
                    制定一项执行计划
                  </Button>
                }
              >
                后台只执行已注册、已授权的工具。不会运行任意 Shell 或写入
                GitLab。
              </Empty>
            </div>
          )}
        </div>
      )}
      {create && (
        <CreateExecution
          tasks={tasks}
          instruction={instruction}
          guard={guard}
          notify={notify}
          onClose={() => setCreate(false)}
          onSaved={(value) => {
            saved(value);
            onInstructionUsed();
          }}
        />
      )}
    </>
  );
}
function CreateExecution({
  tasks,
  instruction,
  guard,
  notify,
  onClose,
  onSaved,
}: {
  tasks: Task[];
  instruction: string;
  guard: Guard;
  notify: Notify;
  onClose: () => void;
  onSaved: (execution: Execution) => void;
}) {
  const { items: models, error: modelError } = useModels();
  const management = useManagement();
  const [sources, setSources] = useState<SourceObject[]>([]);
  const [writebacks, setWritebacks] = useState<Writeback[]>([]);
  const [draft, setDraft] = useState<ExecutionInput>({
    title: "",
    modelId: "",
    instruction,
    taskIds: [],
    sourceRecordIds: [],
    periodIds: [],
    riskIds: [],
    allowedTools: ["read_records", "save_markdown"],
    writebackIds: [],
    maxSteps: 8,
    dataClass: "internal",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([
      api.list<SourceObject>("/source-records"),
      api.list<Writeback>("/writebacks"),
    ])
      .then(([s, w]) => {
        setSources(s);
        setWritebacks(w);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  const dirty = !!draft.title || !!draft.instruction || !!draft.modelId;
  useEffect(() => guard.dirty(dirty), [dirty, guard]);
  const set = <K extends keyof ExecutionInput>(
    key: K,
    value: ExecutionInput[K],
  ) => setDraft((v) => ({ ...v, [key]: value }));
  const toggle = (
    key:
      "taskIds" | "sourceRecordIds" | "periodIds" | "riskIds" | "writebackIds",
    id: string,
    checked: boolean,
  ) =>
    setDraft((v) => ({
      ...v,
      [key]: checked
        ? [...(v[key] || []), id]
        : (v[key] || []).filter((value) => value !== id),
    }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await request<Execution>("/executions", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      onSaved(value);
      guard.dirty(false);
      onClose();
      notify("待授权计划已保存，尚未执行工具");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const groups: {
    key:
      "taskIds" | "sourceRecordIds" | "periodIds" | "riskIds" | "writebackIds";
    label: string;
    items: { id: string; title: string }[];
  }[] = [
    {
      key: "taskIds",
      label: "允许读取的任务",
      items: tasks.filter(
        (t) => !t.sensitive && !["people", "recruitment"].includes(t.type),
      ),
    },
    { key: "sourceRecordIds", label: "允许读取的来源记录", items: sources },
    {
      key: "periodIds",
      label: "允许读取的周期重点",
      items: management.data.periods,
    },
    {
      key: "riskIds",
      label: "允许读取的风险",
      items: management.data.risks.filter((r) => !r.sensitive),
    },
    {
      key: "writebackIds",
      label: "允许执行的已保存回写预览",
      items: writebacks
        .filter((w) => ["preview", "uncertain"].includes(w.status))
        .map((w) => ({
          id: w.id,
          title: `${w.targetNumber} · ${w.targetTitle} · ${w.field} · ${w.value}`,
        })),
    },
  ];
  return (
    <Modal
      title="新建范围明确的执行计划"
      wide
      onClose={() => guard.protect(onClose)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorNotice error={error || modelError || management.error} />
        <Field label="执行计划标题">
          <input
            className="input"
            required
            maxLength={300}
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </Field>
        <ModelChoice
          models={models}
          modelId={draft.modelId}
          onModelChange={(value) => set("modelId", value)}
          dataClass={draft.dataClass || "internal"}
          onDataClassChange={(value: ModelDataClass) => set("dataClass", value)}
          tools
        />
        <Field label="执行指令">
          <textarea
            className="input"
            required
            maxLength={20000}
            value={draft.instruction}
            onChange={(e) => set("instruction", e.target.value)}
          />
        </Field>
        <Field label="最大执行步数">
          <input
            type="number"
            className="input"
            min="1"
            max="30"
            value={draft.maxSteps}
            onChange={(e) => set("maxSteps", Number(e.target.value))}
          />
        </Field>
        <Field label="允许使用的工具">
          <div className="selection-list">
            {Object.entries(toolLabels).map(([tool, label]) => (
              <label className="check-line" key={tool}>
                <input
                  type="checkbox"
                  checked={draft.allowedTools.includes(
                    tool as Execution["allowedTools"][number],
                  )}
                  onChange={(e) =>
                    setDraft((v) => ({
                      ...v,
                      allowedTools: e.target.checked
                        ? [
                            ...v.allowedTools,
                            tool as Execution["allowedTools"][number],
                          ]
                        : v.allowedTools.filter((t) => t !== tool),
                    }))
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </Field>
        {groups.map((group) => (
          <Field key={group.key} label={group.label}>
            <div className="selection-list">
              {group.items.length ? (
                group.items.map((item) => (
                  <label className="check-line" key={item.id}>
                    <input
                      type="checkbox"
                      checked={(draft[group.key] || []).includes(item.id)}
                      onChange={(e) =>
                        toggle(group.key, item.id, e.target.checked)
                      }
                    />
                    {item.title}
                  </label>
                ))
              ) : (
                <small className="muted">暂无可选记录</small>
              )}
            </div>
          </Field>
        ))}
        <p className="notice">
          创建后先核对具体计划、模型配置版本、固定产物目录和预算，再单次授权。未选择的目标与工具不在本次范围内。
        </p>
        <div className="editor-actions">
          <Button
            type="submit"
            primary
            disabled={
              busy ||
              !draft.title.trim() ||
              !draft.instruction.trim() ||
              !draft.modelId ||
              !draft.allowedTools.length
            }
          >
            {busy ? "正在保存计划…" : "创建待授权计划"}
          </Button>
          <Button onClick={() => guard.protect(onClose)}>取消</Button>
        </div>
      </form>
    </Modal>
  );
}
