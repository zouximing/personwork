import { useEffect, useState } from "react";
import { Plus, Search, Save, FileText } from "lucide-react";
import type { Prompt } from "../../../../packages/contracts/src/index";
import { api, errorText } from "../api";
import {
  Button,
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  PageHeading,
  type Guard,
  type Notify,
} from "../components/ui";

export function Prompts({
  items,
  onSaved,
  guard,
  notify,
  onUse,
}: {
  items: Prompt[];
  onSaved: (item: Prompt) => void;
  guard: Guard;
  notify: Notify;
  onUse: (body: string) => void;
}) {
  const [selected, setSelected] = useState<Prompt | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", tag: "" });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty =
    editing &&
    (draft.title !== (selected?.title || "") ||
      draft.body !== (selected?.body || "") ||
      draft.tag !== (selected?.tag || ""));
  useEffect(() => guard.dirty(dirty), [dirty, guard]);
  const open = (item: Prompt | null) =>
    guard.protect(() => {
      setSelected(item);
      setDraft({
        title: item?.title || "",
        body: item?.body || "",
        tag: item?.tag || "",
      });
      setEditing(true);
      setError("");
      guard.dirty(false);
    });
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await api.savePrompt({
        ...draft,
        ...(selected ? { id: selected.id, revision: selected.revision } : {}),
      });
      setSelected(saved);
      setDraft({ title: saved.title, body: saved.body, tag: saved.tag });
      onSaved(saved);
      guard.dirty(false);
      notify("提示词已保存");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const filtered = items.filter((p) =>
    `${p.title} ${p.body} ${p.tag}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  return (
    <>
      <PageHeading
        eyebrow="YOUR WORDS, READY TO USE"
        title="把好用的提示，留下来。"
        description="整理常用指令，保留格式，随时复制已保存的正文。"
      >
        <Button primary onClick={() => open(null)}>
          <Plus size={15} />
          新建提示词
        </Button>
      </PageHeading>
      <div className="prompt-layout">
        <aside className="panel prompt-list">
          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索提示词"
              placeholder="搜索标题、正文或标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {filtered.length ? (
            filtered.map((item) => (
              <button
                aria-label={item.title}
                className={`prompt-item ${selected?.id === item.id ? "selected" : ""}`}
                key={item.id}
                onClick={() => open(item)}
              >
                <FileText size={17} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {item.tag || "未分类"} ·{" "}
                    {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <Empty title={query ? "没有找到匹配的提示词" : "还没有保存提示词"}>
              常用指令保存在这里，下次打开继续使用。
            </Empty>
          )}
        </aside>
        <section className="panel prompt-editor">
          {editing ? (
            <>
              <div className="section-heading">
                <h2>{selected ? "编辑提示词" : "新建提示词"}</h2>
                <span className={`badge ${dirty ? "amber" : ""}`}>
                  {dirty ? "尚未保存" : selected ? "已保存" : "新草稿"}
                </span>
              </div>
              <ErrorNotice error={error} />
              <Field label="提示词标题">
                <input
                  className="input"
                  value={draft.title}
                  maxLength={300}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </Field>
              <Field label="标签">
                <input
                  className="input"
                  value={draft.tag}
                  maxLength={100}
                  placeholder="例如：代码审查、周回顾"
                  onChange={(e) => setDraft({ ...draft, tag: e.target.value })}
                />
              </Field>
              <Field label="提示词正文">
                <textarea
                  className="input prompt-body"
                  value={draft.body}
                  placeholder="在这里写下你的指令，保留缩进、空行与 {{占位符}}。"
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </Field>
              <div className="editor-actions">
                <Button
                  primary
                  onClick={save}
                  disabled={busy || !draft.title.trim() || !draft.body.trim()}
                >
                  <Save size={14} />
                  {busy ? "正在保存…" : "保存提示词"}
                </Button>
                <CopyButton
                  label="复制已保存正文"
                  body={selected?.body || ""}
                  notify={notify}
                />
                <Button
                  disabled={!selected}
                  onClick={() =>
                    selected && guard.protect(() => onUse(selected.body))
                  }
                >
                  填入 AI 指令
                </Button>
              </div>
              <p className="hint">
                复制使用最近一次成功保存的正文。
                {selected
                  ? `最近保存：${new Date(selected.updatedAt).toLocaleString("zh-CN")}`
                  : "请先保存后复制。"}
              </p>
            </>
          ) : (
            <Empty
              title="让重复的表达，成为可复用的工具"
              action={
                <Button onClick={() => open(null)}>写下第一条提示词</Button>
              }
            >
              选择一条提示词继续编辑，或创建新的模板。
            </Empty>
          )}
        </section>
      </div>
    </>
  );
}
