import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sun,
  ListTodo,
  CalendarDays,
  Layers3,
  FileText,
  BookOpen,
  Play,
  Settings as SettingsIcon,
  ListChecks,
  Search,
  ChevronRight,
  ShieldCheck,
  Menu,
  X,
  Check,
} from "lucide-react";
import type {
  Prompt,
  SourceView,
  Task,
} from "../../../packages/contracts/src/index";
import { api, errorText, request, session, type Bootstrap } from "./api";
import type { SourceObject } from "../../../packages/contracts/src/sources";
import {
  Busy,
  Button,
  ErrorNotice,
  Field,
  Modal,
  type Guard,
} from "./components/ui";
import { QuickCapture, TaskEditor } from "./components/TaskEditor";
import { Today } from "./pages/Today";
import { CapturePage, ReminderBell } from "./components/DashboardTools";
import { TaskCalendar } from "./pages/Calendar";
import { TaskCenter } from "./pages/Sources";
import { Reviews } from "./pages/Reviews";
import { Models } from "./pages/Models";
import { Executions } from "./pages/Executions";
import { AiSummary } from "./components/AiAssist";
import { Prompts } from "./pages/Prompts";
import { Settings } from "./pages/Settings";
import {
  Management,
} from "./pages/Management";

const navigation = [
  { id: "today", label: "今日工作", icon: Sun },
  { id: "tasks", label: "任务中心", icon: ListTodo },
  { id: "capture", label: "快速捕获", icon: ListChecks },
  { id: "calendar", label: "任务日历", icon: CalendarDays },
  { id: "manage", label: "管理看板", icon: Layers3 },
  { id: "review", label: "工作回顾", icon: FileText },
  { id: "prompts", label: "提示词库", icon: BookOpen },
  { id: "executions", label: "执行记录", icon: Play },
  { id: "settings", label: "系统设置", icon: SettingsIcon },
];
function initialView() {
  if (location.pathname === "/capture") return "capture";
  const view = new URLSearchParams(location.search).get("view");
  return navigation.some((item) => item.id === view) ? view! : "today";
}
export function App() {
  const [view, setView] = useState(initialView);
  const [route, setRoute] = useState(() => ({ search: location.search, visit: 0 }));
  const [data, setData] = useState<Bootstrap | null>(null);
  const [sourceRecords, setSourceRecords] = useState<SourceObject[] | null>(
    null,
  );
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [capture, setCapture] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(() => new URLSearchParams(location.search).get("task"));
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirtyState(value);
  }, []);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");
  const [aiInstruction, setAiInstruction] = useState("");
  const notify = useCallback((message: string) => setToast(message), []);
  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const auth = await session();
      setAuthenticated(auth.authenticated);
      if (auth.authenticated) {
        const [bootstrap, records] = await Promise.all([
          api.bootstrap(),
          api.list<SourceObject>("/source-records").catch(() => null),
        ]);
        setData(bootstrap);
        setSourceRecords(records);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!authenticated) return;
    const refresh = () => {
      if (!document.hidden && !dirtyRef.current) {
        void load();
      }
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [authenticated, load]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const protect = useCallback((action: () => void) => {
    if (dirtyRef.current) setPending(() => action);
    else action();
  }, []);
  const guard = useMemo<Guard>(() => ({ dirty: setDirty, protect }), [protect]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const navigate = (next: string) =>
    guard.protect(() => {
      setDirty(false);
      setCapture(false);
      setTaskId(null);
      const target = new URL(next.startsWith("?") ? next : `?view=${next}`, location.origin);
      const nextView = target.searchParams.get("view") || "today";
      setView(nextView);
      if (target.searchParams.has("task")) setTaskId(target.searchParams.get("task"));
      setMobileOpen(false);
      const url = new URL(location.href);
      url.pathname = nextView === "capture" ? "/capture" : "/";
      url.search = target.search;
      history.replaceState(null, "", url);
      setRoute(current => ({ search: url.search, visit: current.visit + 1 }));
    });
  const saveTask = (task: Task) =>
    setData((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.some((t) => t.id === task.id)
              ? current.tasks.map((t) => (t.id === task.id ? task : t))
              : [...current.tasks, task],
          }
        : current,
    );
  const savePrompt = (prompt: Prompt) =>
    setData((current) =>
      current
        ? {
            ...current,
            prompts: current.prompts.some((p) => p.id === prompt.id)
              ? current.prompts.map((p) => (p.id === prompt.id ? prompt : p))
              : [...current.prompts, prompt],
          }
        : current,
    );
  const saveSource = (source: SourceView) =>
    setData((current) =>
      current
        ? {
            ...current,
            sources: current.sources.map((s) =>
              s.provider === source.provider ? source : s,
            ),
          }
        : current,
    );
  const complete = async (task: Task) => {
    try {
      const saved = await api.patchTask(task.id, {
        revision: task.revision,
        status: task.status === "done" ? "todo" : "done",
      });
      saveTask(saved);
      notify(
        task.status === "done"
          ? "任务已重开，先前完成事实保留"
          : "个人行动已完成，验证与来源交付保持独立",
      );
    } catch (e) {
      setError(errorText(e));
    }
  };
  const openTask = (task: Task) =>
    guard.protect(() => {
      setDirty(false);
      setTaskId(task.id);
    });
  const openCapture = () =>
    guard.protect(() => {
      setDirty(false);
      setCapture(true);
    });
  useEffect(() => {
    if (!authenticated) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.code === "KeyN" && !event.repeat) {
        event.preventDefault();
        protect(() => { setDirty(false); setTaskId(null); setCapture(true); });
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [authenticated, protect, setDirty]);
  const login = async () => {
    setLoading(true);
    setError("");
    try {
      await request("/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  const task = data?.tasks.find((t) => t.id === taskId);
  return (
    <>
      {authenticated === false ? (
        <main className="login-screen">
          <div className="panel login-card">
            <div className="brand-mark">
              <ListChecks />
            </div>
            <h1>回到你的工作空间。</h1>
            <p className="muted">输入工作台访问口令以继续。</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
            >
              <ErrorNotice error={error} />
              <Field label="工作台访问口令">
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" primary disabled={loading || !password}>
                {loading ? "正在验证…" : "进入工作台"}
              </Button>
            </form>
          </div>
        </main>
      ) : (
        <div className="shell">
          <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
            <div className="brand">
              <div className="brand-mark">
                <ListChecks size={23} />
              </div>
              <div>
                <strong>序</strong>
                <small>
                  PERSONAL
                  <br />
                  WORKSPACE
                </small>
              </div>
              <button
                className="mobile-close icon-button"
                onClick={() => setMobileOpen(false)}
                aria-label="关闭导航"
              >
                <X size={19} />
              </button>
            </div>
            <p className="nav-label">我的工作空间</p>
            <nav aria-label="主要导航">
              {navigation.map(({ id, label, icon: Icon }) => (
                <div key={id}>
                  {id === "prompts" && (
                    <p className="nav-label tools-label">工具与资料</p>
                  )}
                  <button
                    aria-label={label}
                    aria-current={view === id ? "page" : undefined}
                    onClick={() => navigate(id)}
                    className={`nav-item ${view === id ? "active" : ""}`}
                  >
                    <Icon size={17} />
                    <span>{label}</span>
                    {id === "tasks" && data && (
                      <small>
                        {
                          data.tasks.filter(
                            (t) =>
                              !t.archived &&
                              !["done", "cancelled"].includes(t.status),
                          ).length
                        }
                      </small>
                    )}
                    {id === "prompts" && !!data?.prompts.length && (
                      <small>{data.prompts.length}</small>
                    )}
                  </button>
                </div>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="connection-note">
                <strong>
                  <ShieldCheck size={16} />
                  专注当下，有序推进
                </strong>
                <p>
                  个人安排与来源状态各自保留
                  <br />
                  结果有记录，进展有依据
                </p>
              </div>
              <div className="profile">
                <span>我</span>
                <div>
                  <strong>我的工作空间</strong>
                  <small>单用户 · 私有工作台</small>
                </div>
              </div>
            </div>
          </aside>
          {mobileOpen && (
            <button
              className="nav-scrim"
              aria-label="收起导航"
              onClick={() => setMobileOpen(false)}
            />
          )}
          <div className="main-shell">
            <div className="topbar">
              <div className="row">
                <button
                  className="mobile-menu icon-button"
                  aria-label="打开导航"
                  onClick={() => setMobileOpen(true)}
                >
                  <Menu size={20} />
                </button>
                <span className="breadcrumb">
                  我的工作空间 <ChevronRight size={12} />{" "}
                  <b>{navigation.find((n) => n.id === view)?.label}</b>
                </span>
              </div>
              <form
                className="global-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate("tasks");
                }}
              >
                <Search size={16} />
                <input
                  aria-label="全局搜索"
                  placeholder="搜索任务、编号…"
                  value={globalSearch}
                  onChange={(e) => setGlobalSearch(e.target.value)}
                />
                <kbd>Enter</kbd>
              </form>
              <ReminderBell enabled={authenticated === true} tasks={data?.tasks} onNavigate={navigate} />
              <span className="top-tag">本机工作台</span>
            </div>
            <main className="content">
              <ErrorNotice error={error} />
              {loading && !data ? (
                <Busy />
              ) : !data ? (
                <div className="panel startup">
                  <p>工作台暂未读取成功。</p>
                  <Button onClick={load}>重新连接后台</Button>
                </div>
              ) : (
                <>
                  {view === "today" && (
                    <Today tasks={data.tasks} onOpen={openTask} onSaved={saveTask} onReload={load} onCapture={openCapture} onNavigate={navigate} guard={guard} notify={notify} />
                  )}
                  {view === "capture" && <CapturePage tasks={data.tasks} onSaved={saveTask} onOpen={openTask} notify={notify} guard={guard} />}
                  {view === "tasks" && (
                    <TaskCenter
                      key={`${globalSearch}:${route.search}:${route.visit}`}
                      tasks={data.tasks}
                      sourceRecords={sourceRecords || []}
                      today={data.today}
                      onTaskSaved={saveTask}
                      onTaskDeleted={id => {
                        setData(current => current ? { ...current, tasks: current.tasks.filter(task => task.id !== id) } : current);
                        void load();
                      }}
                      onOpen={openTask}
                      onCapture={openCapture}
                      onComplete={complete}
                      initialQuery={globalSearch}
                      guard={guard}
                      notify={notify}
                      onSourcesChanged={() => void load()}
                    />
                  )}
                  {view === "calendar" && (
                    <TaskCalendar
                      tasks={data.tasks}
                      today={data.today}
                      onOpen={openTask}
                      onNavigateTasks={() => navigate("tasks")}
                    />
                  )}
                  {view === "prompts" && (
                    <Prompts
                      items={data.prompts}
                      onSaved={savePrompt}
                      guard={guard}
                      notify={notify}
                      onUse={(body) => {
                        setAiInstruction(body);
                        navigate("executions");
                      }}
                    />
                  )}
                  {view === "settings" && (
                    <Settings
                      sources={data.sources}
                      dataDir={data.dataDir}
                      onSaved={saveSource}
                      guard={guard}
                      notify={notify}
                      models={<Models guard={guard} notify={notify} />}
                      onSynced={() => void load()}
                    />
                  )}
                  {view === "manage" && (
                    <Management
                      key={`${route.search}:${route.visit}`}
                      tasks={data.tasks}
                      today={data.today}
                      guard={guard}
                      notify={notify}
                      onOpen={openTask}
                      onTaskSaved={saveTask}
                      onChanged={() => void load()}
                    />
                  )}
                  {view === "review" && (
                    <Reviews
                      tasks={data.tasks}
                      today={data.today}
                      week={data.week}
                      guard={guard}
                      notify={notify}
                      aiControl={(review, onUpdated) => (
                        <AiSummary
                          review={review}
                          onUpdated={onUpdated}
                          notify={notify}
                        />
                      )}
                    />
                  )}
                  {view === "executions" && (
                    <Executions
                      tasks={data.tasks}
                      instruction={aiInstruction}
                      guard={guard}
                      notify={notify}
                      onInstructionUsed={() => setAiInstruction("")}
                    />
                  )}
                </>
              )}
            </main>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {capture && data && (
        <QuickCapture
          onClose={() => {
            setDirty(false);
            setCapture(false);
          }}
          today={data.today}
          onSaved={saveTask}
          guard={guard}
          notify={notify}
        />
      )}
      {task && data && (
        <TaskEditor
          key={task.id}
          task={task}
          tasks={data.tasks}
          today={data.today}
          onSaved={saveTask}
          onClose={() => {
            setDirty(false);
            setTaskId(null);
          }}
          onOpen={openTask}
          guard={guard}
          notify={notify}
        />
      )}
      {pending && (
        <Modal title="内容尚未保存" onClose={() => setPending(null)}>
          <p>
            当前输入还没有成功保存。你可以继续编辑，或明确放弃本次修改后离开。
          </p>
          <div className="editor-actions">
            <Button primary onClick={() => setPending(null)}>
              继续编辑
            </Button>
            <Button
              onClick={() => {
                const action = pending;
                setDirty(false);
                setPending(null);
                action();
              }}
            >
              放弃修改并离开
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
