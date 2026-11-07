import { useEffect, useState } from "react";
import {
  Save,
  Plug,
  RefreshCw,
  Download,
  Upload,
  ShieldCheck,
  FolderOpen,
} from "lucide-react";
import type {
  SourceView,
  SourceUpdate,
} from "../../../../packages/contracts/src/index";
import { api, download, errorText, request } from "../api";
import { ReminderSettings } from "../components/ReminderSettings";
import {
  Button,
  ErrorNotice,
  Field,
  Modal,
  PageHeading,
  Section,
  type Guard,
  type Notify,
} from "../components/ui";

export function Settings({
  sources,
  dataDir,
  onSaved,
  guard,
  notify,
  models,
  onSynced,
}: {
  sources: SourceView[];
  dataDir: string;
  onSaved: (value: SourceView) => void;
  guard: Guard;
  notify: Notify;
  models?: React.ReactNode;
  onSynced?: () => void;
}) {
  const [tab, setTab] = useState("sources");
  const [provider, setProvider] = useState("pingcode");
  const source = sources.find((s) => s.provider === provider);
  return (
    <>
      <PageHeading
        eyebrow="MAKE IT YOUR OWN"
        title="连接工作，照顾好数据。"
        description="来源、模型和备份独立维护。保存配置后，以真实测试结果判断能力。"
      />
      <div className="tabs">
        {[
          ["sources", "来源与同步"],
          ["models", "模型配置"],
          ["reminders", "提醒设置"],
          ["data", "数据与备份"],
        ].map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() =>
              guard.protect(() => {
                guard.dirty(false);
                setTab(value);
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "reminders" && <ReminderSettings guard={guard} notify={notify} />}
      {tab === "sources" && (
        <>
          <div className="source-picker">
            {[
              ["pingcode", "PingCode"],
              ["gitlab", "GitLab"],
            ].map(([value, label]) => (
              <Button
                key={value}
                primary={provider === value}
                onClick={() =>
                  guard.protect(() => {
                    guard.dirty(false);
                    setProvider(value);
                  })
                }
              >
                {label}
              </Button>
            ))}
          </div>
          {source ? (
            <SourceForm
              key={`${source.provider}-${source.id}`}
              source={source}
              onSaved={onSaved}
              guard={guard}
              notify={notify}
              onSynced={onSynced}
            />
          ) : (
            <div className="notice">未读到来源配置。请刷新并检查后台服务。</div>
          )}
        </>
      )}
      {tab === "models" &&
        (models || (
          <div className="notice">
            模型配置正在加载。未通过真实调用前，不视为能力已验证。
          </div>
        ))}
      {tab === "data" && <Backup dataDir={dataDir} notify={notify} />}
    </>
  );
}
function toUpdate(source: SourceView): SourceUpdate {
  return {
    name: source.name,
    baseUrl: source.baseUrl,
    projectScope: source.projectScope,
    identity: source.identity,
    historyDays: source.historyDays,
    enabled: source.enabled,
    intervalMinutes: source.intervalMinutes,
    scheduleEnabled: source.scheduleEnabled,
    revision: source.revision,
    credentialAction: "keep",
  };
}
function SourceForm({
  source,
  onSaved,
  guard,
  notify,
  onSynced,
}: {
  source: SourceView;
  onSaved: (value: SourceView) => void;
  guard: Guard;
  notify: Notify;
  onSynced?: () => void;
}) {
  const [draft, setDraft] = useState<SourceUpdate>(() => toUpdate(source));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<unknown>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toUpdate(source));
  useEffect(() => guard.dirty(dirty), [dirty, guard]);
  const set = <K extends keyof SourceUpdate>(
    name: K,
    value: SourceUpdate[K],
  ) => {
    setDraft((v) => ({ ...v, [name]: value }));
    setTestResult(null);
  };
  const act = async (action: "save" | "test" | "sync") => {
    setBusy(action);
    setError("");
    try {
      if (action === "save") {
        const saved = await api.saveSource(source.provider, draft);
        onSaved(saved);
        setDraft(toUpdate(saved));
        guard.dirty(false);
        notify("来源设置已保存，连接与回写能力仍需验证");
      } else if (action === "test") {
        setTestResult(
          await request(`/sources/${source.provider}/test`, {
            method: "POST",
            body: JSON.stringify(draft),
          }),
        );
      } else {
        setTestResult(
          await request(`/sources/${source.provider}/sync`, {
            method: "POST",
            body: JSON.stringify({}),
          }),
        );
        notify("同步请求已结束，请核对返回结果");
        const sources = await api.list<SourceView>("/sources");
        const updated = sources.find(
          (item) => item.provider === source.provider,
        );
        if (updated) {
          onSaved(updated);
          setDraft(toUpdate(updated));
        }
        onSynced?.();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <Section
      title={`${source.provider === "pingcode" ? "PingCode" : "GitLab"} · 独立来源设置`}
      action={
        <span className={`badge ${dirty ? "amber" : ""}`}>
          {dirty ? "尚未保存" : "已保存"}
        </span>
      }
    >
      <div className="panel-body">
        <ErrorNotice error={error} />
        <div className="notice">
          <ShieldCheck size={17} />
          <span>
            凭据单独保护，界面不回显。
            {source.provider === "gitlab"
              ? "同步指派给我的 Issue、MR 和由我评审的 MR，去重后进入任务中心；GitLab 始终只读。"
              : "状态和选定评论回写须分别验证权限。"}{" "}
            停用来源保留既有任务与个人安排。
          </span>
        </div>
        <div className="form-grid">
          <Field label="显示名称">
            <input
              className="input"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>
          <Field label="内网服务地址">
            <input
              className="input"
              type="url"
              placeholder="https://your-instance"
              value={draft.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
            />
          </Field>
          <Field label="项目 / 拉取范围">
            <textarea
              className="input"
              value={draft.projectScope}
              placeholder="项目 ID，以逗号或换行分隔"
              onChange={(e) => set("projectScope", e.target.value)}
            />
          </Field>
          <Field label="本人来源身份">
            <input
              className="input"
              value={draft.identity}
              onChange={(e) => set("identity", e.target.value)}
            />
          </Field>
          <Field label={source.provider === "gitlab" ? "历史范围（天，未关闭事项不限）" : "历史范围（天）"}>
            <input
              className="input"
              type="number"
              min="1"
              max="3650"
              value={draft.historyDays}
              onChange={(e) => set("historyDays", Number(e.target.value))}
            />
          </Field>
          <Field label="同步间隔（分钟）">
            <input
              className="input"
              type="number"
              min="5"
              max="1440"
              value={draft.intervalMinutes}
              onChange={(e) => set("intervalMinutes", Number(e.target.value))}
            />
          </Field>
          <Field
            label={`凭据（${source.hasCredential ? "已保存" : "未设置"}）`}
          >
            <select
              value={draft.credentialAction}
              onChange={(e) =>
                setDraft((v) => ({
                  ...v,
                  credentialAction: e.target
                    .value as SourceUpdate["credentialAction"],
                  credential: undefined,
                }))
              }
            >
              <option value="keep">保留现有凭据</option>
              <option value="replace">输入新凭据</option>
              <option value="clear">清除现有凭据</option>
            </select>
          </Field>
          {draft.credentialAction === "replace" && (
            <Field label="新访问凭据">
              <input
                className="input"
                autoComplete="off"
                type="password"
                value={draft.credential || ""}
                onChange={(e) => set("credential", e.target.value)}
              />
            </Field>
          )}
        </div>
        <div className="row wrap">
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />
            启用来源
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.scheduleEnabled}
              onChange={(e) => set("scheduleEnabled", e.target.checked)}
            />
            启用后台定时同步
          </label>
        </div>
        <div className="editor-actions">
          <Button primary disabled={!!busy} onClick={() => act("save")}>
            <Save size={14} />
            {busy === "save" ? "正在保存…" : "保存来源设置"}
          </Button>
          <Button disabled={!!busy} onClick={() => act("test")}>
            <Plug size={14} />
            {busy === "test" ? "正在实际测试…" : "测试当前填写配置"}
          </Button>
          <Button
            disabled={!!busy || dirty || !source.enabled}
            onClick={() => act("sync")}
          >
            <RefreshCw size={14} />
            {busy === "sync" ? "正在同步…" : "同步已保存来源"}
          </Button>
        </div>
        <p className="hint">
          测试使用当前填写配置，不保存设置。修改地址或凭据后需重新测试；旧实例资料与历史继续保留。
        </p>
        {testResult !== null && (
          <div className="result-box">
            <h3>实际返回结果</h3>
            <pre>{JSON.stringify(testResult, null, 2)}</pre>
            <p className="hint">
              读取连接通过不表示写入权限、模型或任务执行通过。
            </p>
          </div>
        )}
        <div className="source-meta">
          <span>实例身份 {source.instanceId}</span>
          <span>连接状态 {source.connectionStatus}</span>
          <span>写入状态 {source.writeStatus}</span>
        </div>
      </div>
    </Section>
  );
}
function Backup({ dataDir, notify }: { dataDir: string; notify: Notify }) {
  const [password, setPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [snapshots, setSnapshots] = useState<
    { name: string; savedAt: string; bytes: number }[]
  >([]);
  const [snapshotError, setSnapshotError] = useState("");
  const [restoreSnapshot, setRestoreSnapshot] = useState<string | null>(null);
  useEffect(() => {
    api
      .list<{ name: string; savedAt: string; bytes: number }>(
        "/backups/snapshots",
      )
      .then(setSnapshots)
      .catch((error) => setSnapshotError(errorText(error)));
  }, []);
  const exportBackup = async () => {
    setBusy("export");
    setError("");
    try {
      const blob = await request<Blob>("/backups/export", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      download(blob, `个人工作台-${new Date().toISOString().slice(0, 10)}.pwb`);
      setPassword("");
      notify("加密备份已生成并交给浏览器下载");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const restore = async () => {
    if (!file) return;
    setBusy("restore");
    setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await request("/backups/restore", {
        method: "POST",
        body: JSON.stringify({
          password,
          content: btoa(binary),
          confirm: true,
        }),
      });
      setConfirm(false);
      setPassword("");
      notify("备份已恢复，正在重新读取工作台");
      window.location.reload();
    } catch (e) {
      setError(errorText(e));
      setConfirm(false);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="stack">
      <Section title="数据位置与保护">
        <div className="panel-body">
          <p className="row">
            <FolderOpen size={18} />
            <code className="data-path">{dataDir}</code>
          </p>
          <p className="hint">
            业务数据独立于代码。后台运行时每日检查创建本机保护快照，保留最近七日；异机备份仍需另行保存。
          </p>
        </div>
      </Section>
      <Section title="本机保护快照">
        <div className="panel-body">
          <ErrorNotice error={snapshotError} />
          <p className="hint">
            快照只供当前机器恢复。恢复后来源和模型停用且需重录凭据、重测启用；执行与已发出回写需重新核实。
          </p>
          {snapshots.length ? (
            snapshots.map((snapshot) => (
              <div className="snapshot-row" key={snapshot.name}>
                <span>
                  <strong>{snapshot.name}</strong>
                  <small>
                    {new Date(snapshot.savedAt).toLocaleString("zh-CN")} ·{" "}
                    {snapshot.bytes} bytes
                  </small>
                </span>
                <Button
                  disabled={!!busy}
                  onClick={() => setRestoreSnapshot(snapshot.name)}
                >
                  恢复此快照
                </Button>
              </div>
            ))
          ) : (
            <p className="hint">暂无可恢复的本机保护快照。</p>
          )}
        </div>
      </Section>
      <Section title="可移植加密备份">
        <div className="panel-body">
          <ErrorNotice error={error} />
          <div className="notice">
            包含任务、提示词、设置和历史，不包含访问凭据与主密钥。恢复后需重新输入凭据。请单独妥善保存备份口令。
          </div>
          <Field label="备份 / 恢复口令（至少 12 个字符）">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div className="editor-actions">
            <Button
              primary
              disabled={!!busy || password.length < 12}
              onClick={exportBackup}
            >
              <Download size={15} />
              {busy === "export" ? "正在加密…" : "下载加密备份"}
            </Button>
          </div>
          <hr />
          <Field label="选择要恢复的 .pwb 备份">
            <input
              className="input"
              type="file"
              accept=".pwb"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </Field>
          <Button
            disabled={!!busy || password.length < 12 || !file}
            onClick={() => setConfirm(true)}
          >
            <Upload size={15} />
            恢复备份…
          </Button>
        </div>
      </Section>
      {confirm && (
        <Modal title="确认恢复备份" onClose={() => !busy && setConfirm(false)}>
          <p>
            将用「{file?.name}
            」中的数据恢复当前工作台。后端会先验证备份，恢复前保留现有数据保护副本；凭据需要重新录入。
          </p>
          <div className="editor-actions">
            <Button onClick={() => setConfirm(false)} disabled={!!busy}>
              取消
            </Button>
            <Button primary onClick={restore} disabled={!!busy}>
              {busy === "restore" ? "正在验证与恢复…" : "确认恢复并重新载入"}
            </Button>
          </div>
        </Modal>
      )}
      {restoreSnapshot && (
        <Modal
          title="确认恢复本机快照"
          onClose={() => !busy && setRestoreSnapshot(null)}
        >
          <p>
            确认用「{restoreSnapshot}
            」恢复工作台。恢复前后台会保留当前数据保护副本；来源、模型和执行状态需要重新核实。
          </p>
          <ErrorNotice error={error} />
          <div className="editor-actions">
            <Button disabled={!!busy} onClick={() => setRestoreSnapshot(null)}>
              取消
            </Button>
            <Button
              primary
              disabled={!!busy}
              onClick={async () => {
                setBusy("snapshot");
                setError("");
                try {
                  await request(
                    `/backups/snapshots/${encodeURIComponent(restoreSnapshot)}/restore`,
                    { method: "POST", body: JSON.stringify({ confirm: true }) },
                  );
                  notify("本机快照已恢复，正在重新读取");
                  location.reload();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === "snapshot" ? "正在恢复…" : "确认恢复本机快照"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
