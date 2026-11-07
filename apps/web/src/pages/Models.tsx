import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Plug } from "lucide-react";
import {
  modelFields,
  type ModelInput,
  type ModelView,
  type ModelDataClass,
} from "../../../../packages/contracts/src/models";
import { api, errorText, request } from "../api";
import {
  Busy,
  Button,
  Empty,
  ErrorNotice,
  Field,
  Modal,
  type Guard,
  type Notify,
} from "../components/ui";

export function useModels() {
  const [items, setItems] = useState<ModelView[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setItems(await api.list<ModelView>("/models"));
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
  return { items, error, loading, reload };
}
const kindLabels = {
  local: "本地部署",
  deepseek: "DeepSeek 官方",
  newapi: "New API 网关",
};
const capabilityLabels = {
  untested: "未验证",
  passed: "已实测通过",
  failed: "实测失败",
};
export function Models({ guard, notify }: { guard: Guard; notify: Notify }) {
  const { items, error, loading, reload } = useModels();
  const [editing, setEditing] = useState<ModelView | null | undefined>();
  const [busy, setBusy] = useState<string | null>(null);
  const [testError, setTestError] = useState("");
  const test = async (item: ModelView, testTools: boolean) => {
    setBusy(item.id);
    setTestError("");
    try {
      await request(`/models/${item.id}/test`, {
        method: "POST",
        body: JSON.stringify({ testTools }),
      });
      await reload();
      notify("实际模型测试已结束，请查看文本与工具能力结果");
    } catch (e) {
      setTestError(errorText(e));
      await reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>各自配置，各自验证</h2>
          <p className="hint">本地部署、DeepSeek 和 New API 不自动互相切换。</p>
        </div>
        <Button primary onClick={() => setEditing(null)}>
          <Plus size={14} />
          新增模型配置
        </Button>
      </div>
      <ErrorNotice error={error || testError} />
      {loading ? (
        <Busy />
      ) : (
        <div className="card-list">
          {items.length ? (
            items.map((item) => (
              <div key={item.id} className="panel record-card">
                <div className="section-heading">
                  <h3>{item.name}</h3>
                  <span className="badge">
                    {kindLabels[item.kind]}
                    {item.isDefault ? " · 默认" : ""}
                    {!item.enabled ? " · 停用" : ""}
                  </span>
                </div>
                <p className="card-description">
                  {item.model} ·{" "}
                  {item.protocol === "ollama" ? "Ollama 原生" : "OpenAI 兼容"}
                  <br />
                  {item.baseUrl}
                </p>
                <div className="row wrap">
                  <span
                    className={`badge ${item.capabilities.text === "passed" ? "green" : "amber"}`}
                  >
                    文本：{capabilityLabels[item.capabilities.text]}
                  </span>
                  <span
                    className={`badge ${item.capabilities.tools === "passed" ? "green" : "amber"}`}
                  >
                    工具：{capabilityLabels[item.capabilities.tools]}
                  </span>
                  <span className="badge">
                    {item.hasCredential ? "已保存凭据" : "未设置凭据"}
                  </span>
                </div>
                <p className="hint">
                  上游：{item.upstream || "未说明"} ·{" "}
                  {item.upstreamLocation === "internal"
                    ? "内部"
                    : item.upstreamLocation === "external"
                      ? "外部"
                      : "未知"}{" "}
                  · 内部资料：{item.allowInternal ? "显式许可" : "不许可"}
                  <br />
                  {item.capabilities.message}
                </p>
                <div className="inline-actions">
                  <Button onClick={() => guard.protect(() => setEditing(item))}>
                    编辑配置
                  </Button>
                  <Button
                    disabled={!!busy || !item.enabled}
                    onClick={() => test(item, false)}
                  >
                    <Plug size={13} />
                    {busy === item.id ? "正在调用…" : "实际文本测试"}
                  </Button>
                  <Button
                    disabled={!!busy || !item.enabled}
                    onClick={() => test(item, true)}
                  >
                    实际工具闭环测试
                  </Button>
                </div>
                <footer>
                  配置版本 {item.configurationRevision} · 最近测试{" "}
                  {item.capabilities.testedAt
                    ? new Date(item.capabilities.testedAt).toLocaleString(
                        "zh-CN",
                      )
                    : "尚未测试"}
                </footer>
              </div>
            ))
          ) : (
            <Empty title="选择一个真实模型服务">
              先保存配置，再使用脱敏固定材料分别验证文本与工具能力。
            </Empty>
          )}
        </div>
      )}
      {editing !== undefined && (
        <ModelEditor
          key={editing?.id || "new"}
          model={editing}
          guard={guard}
          notify={notify}
          onClose={() => setEditing(undefined)}
          onSaved={() => void reload()}
        />
      )}
    </>
  );
}
function ModelEditor({
  model,
  guard,
  notify,
  onClose,
  onSaved,
}: {
  model: ModelView | null;
  guard: Guard;
  notify: Notify;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial: ModelInput = model
    ? ({
        ...Object.fromEntries(
          Object.keys(modelFields.shape).map((key) => [
            key,
            model[key as keyof ModelView],
          ]),
        ),
        id: model.id,
        revision: model.revision,
        credentialAction: "keep",
      } as ModelInput)
    : {
        name: "",
        kind: "local",
        baseUrl: "",
        protocol: "openai",
        model: "",
        upstream: "",
        upstreamLocation: "unknown",
        allowInternal: false,
        timeoutSeconds: 30,
        maxCalls: 8,
        maxTokens: 2048,
        isDefault: false,
        enabled: true,
        credentialAction: "keep",
      };
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => guard.dirty(dirty), [dirty, guard]);
  const set = <K extends keyof ModelInput>(key: K, value: ModelInput[K]) =>
    setDraft((v) => ({ ...v, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await request("/models", { method: "POST", body: JSON.stringify(draft) });
      guard.dirty(false);
      onSaved();
      onClose();
      notify("模型配置已保存，文本与工具能力需重新实测");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={model ? "编辑模型配置" : "新增模型配置"}
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
        <div className="notice">保存配置不会标记文本或工具能力通过</div>
        <div className="form-grid">
          <Field label="配置名称">
            <input
              className="input"
              required
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="服务类型">
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft((v) => ({
                  ...v,
                  kind: e.target.value as ModelInput["kind"],
                  upstreamLocation:
                    e.target.value === "deepseek"
                      ? "external"
                      : v.upstreamLocation,
                  baseUrl:
                    e.target.value === "deepseek"
                      ? "https://api.deepseek.com"
                      : v.baseUrl,
                }))
              }
            >
              {Object.entries(kindLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="API 地址">
            <input
              className="input"
              required
              type="url"
              placeholder="https://... 或 http://127.0.0.1:..."
              value={draft.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
            />
          </Field>
          <Field label="协议">
            <select
              value={draft.protocol}
              onChange={(e) =>
                set("protocol", e.target.value as ModelInput["protocol"])
              }
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="ollama">Ollama 原生</option>
            </select>
          </Field>
          <Field label="模型标识">
            <input
              className="input"
              required
              value={draft.model}
              onChange={(e) => set("model", e.target.value)}
            />
          </Field>
          <Field label="实际上游说明">
            <input
              className="input"
              value={draft.upstream}
              placeholder="特别是网关后的实际提供方"
              onChange={(e) => set("upstream", e.target.value)}
            />
          </Field>
          <Field label="上游位置">
            <select
              value={draft.upstreamLocation}
              onChange={(e) =>
                set(
                  "upstreamLocation",
                  e.target.value as ModelInput["upstreamLocation"],
                )
              }
            >
              <option value="unknown">未知</option>
              <option value="internal">内部</option>
              <option value="external">外部</option>
            </select>
          </Field>
          <Field
            label={`访问凭据（${model?.hasCredential ? "已保存" : "未设置"}）`}
          >
            <select
              value={draft.credentialAction}
              onChange={(e) =>
                setDraft((v) => ({
                  ...v,
                  credentialAction: e.target
                    .value as ModelInput["credentialAction"],
                  credential: undefined,
                }))
              }
            >
              <option value="keep">保留</option>
              <option value="replace">输入新凭据</option>
              <option value="clear">清除</option>
            </select>
          </Field>
          {draft.credentialAction === "replace" && (
            <Field label="新模型凭据">
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={draft.credential || ""}
                onChange={(e) => set("credential", e.target.value)}
              />
            </Field>
          )}
          <Field label="超时（秒）">
            <input
              className="input"
              type="number"
              min="1"
              max="300"
              value={draft.timeoutSeconds}
              onChange={(e) => set("timeoutSeconds", Number(e.target.value))}
            />
          </Field>
          <Field label="最大调用次数">
            <input
              className="input"
              type="number"
              min="1"
              max="100"
              value={draft.maxCalls}
              onChange={(e) => set("maxCalls", Number(e.target.value))}
            />
          </Field>
          <Field label="Token 预算">
            <input
              className="input"
              type="number"
              min="1"
              max="100000"
              value={draft.maxTokens}
              onChange={(e) => set("maxTokens", Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="row wrap">
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.allowInternal}
              onChange={(e) => set("allowInternal", e.target.checked)}
            />
            明确许可内部资料（仅内部上游可用）
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            启用
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) => set("isDefault", e.target.checked)}
            />
            设为默认
          </label>
        </div>
        <div className="editor-actions">
          <Button type="submit" primary disabled={busy}>
            <Save size={14} />
            {busy ? "正在保存…" : "保存模型配置"}
          </Button>
          <Button onClick={() => guard.protect(onClose)}>取消</Button>
        </div>
      </form>
    </Modal>
  );
}
export function ModelChoice({
  models,
  modelId,
  onModelChange,
  dataClass,
  onDataClassChange,
  tools = false,
}: {
  models: ModelView[];
  modelId: string;
  onModelChange: (id: string) => void;
  dataClass: ModelDataClass;
  onDataClassChange: (value: ModelDataClass) => void;
  tools?: boolean;
}) {
  return (
    <>
      <div className="form-grid">
        <Field label="使用的模型配置">
          <select
            value={modelId}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="">请主动选择模型</option>
            {models
              .filter(
                (m) =>
                  m.enabled &&
                  (tools
                    ? m.capabilities.tools === "passed"
                    : m.capabilities.text === "passed"),
              )
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.model} ·{" "}
                  {m.upstreamLocation === "internal"
                    ? "内部"
                    : m.upstreamLocation === "external"
                      ? "外部"
                      : "未知上游"}
                </option>
              ))}
          </select>
        </Field>
        <Field label="本次材料分类">
          <select
            value={dataClass}
            onChange={(e) =>
              onDataClassChange(e.target.value as ModelDataClass)
            }
          >
            <option value="internal">内部材料</option>
            <option value="deidentified">已脱敏材料</option>
            <option value="public">公开材料</option>
          </select>
        </Field>
      </div>
      <p className="hint">
        仅列出已实测{tools ? "工具" : "文本"}
        能力通过的配置。内部材料不发送到外部或未知上游，执行过程中不会自动切换服务。
      </p>
    </>
  );
}
