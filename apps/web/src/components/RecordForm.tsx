import { useEffect, useState } from "react";
import { request, errorText } from "../api";
import {
  Button,
  ErrorNotice,
  Field,
  Modal,
  type Guard,
  type Notify,
} from "./ui";

export type FormField = {
  key: string;
  label: string;
  kind?: "text" | "area" | "date" | "select" | "boolean" | "multi" | "number";
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  nullable?: boolean;
};
export type FormDefinition = {
  title: string;
  path: string;
  fields: FormField[];
  values: Record<string, unknown>;
  id?: string;
  revision?: string;
};
export function RecordForm({
  definition,
  onClose,
  onSaved,
  guard,
  notify,
}: {
  definition: FormDefinition;
  onClose: () => void;
  onSaved: () => void;
  guard: Guard;
  notify: Notify;
}) {
  const [draft, setDraft] = useState(definition.values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(definition.values);
  useEffect(() => guard.dirty(dirty), [dirty, guard]);
  const set = (key: string, value: unknown) =>
    setDraft((v) => ({ ...v, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await request(
        `${definition.path}${definition.id ? `/${definition.id}` : ""}`,
        {
          method: definition.id ? "PATCH" : "POST",
          body: JSON.stringify({
            ...draft,
            ...(definition.revision ? { revision: definition.revision } : {}),
          }),
        },
      );
      guard.dirty(false);
      notify("记录已保存");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={definition.title} wide onClose={() => guard.protect(onClose)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorNotice error={error} />
        <div className="form-grid">
          {definition.fields.map((field) => (
            <Field
              key={field.key}
              label={field.label}
              className={
                field.kind === "area" || field.kind === "multi"
                  ? "full-width"
                  : ""
              }
            >
              {field.kind === "area" ? (
                <textarea
                  className="input"
                  aria-label={field.label}
                  required={field.required}
                  value={String(draft[field.key] ?? "")}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              ) : field.kind === "select" ? (
                <select
                  aria-label={field.label}
                  value={String(draft[field.key] ?? "")}
                  required={field.required}
                  onChange={(e) =>
                    set(
                      field.key,
                      field.nullable && !e.target.value ? null : e.target.value,
                    )
                  }
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.kind === "boolean" ? (
                <input
                  type="checkbox"
                  aria-label={field.label}
                  checked={!!draft[field.key]}
                  onChange={(e) => set(field.key, e.target.checked)}
                />
              ) : field.kind === "multi" ? (
                <span className="selection-list">
                  {field.options?.length ? (
                    field.options.map((option) => (
                      <label className="check-line" key={option.value}>
                        <input
                          type="checkbox"
                          checked={(
                            (draft[field.key] as string[]) || []
                          ).includes(option.value)}
                          onChange={(e) =>
                            set(
                              field.key,
                              e.target.checked
                                ? [
                                    ...((draft[field.key] as string[]) || []),
                                    option.value,
                                  ]
                                : ((draft[field.key] as string[]) || []).filter(
                                    (id) => id !== option.value,
                                  ),
                            )
                          }
                        />
                        {option.label}
                      </label>
                    ))
                  ) : (
                    <small className="muted">暂无可关联记录</small>
                  )}
                </span>
              ) : (
                <input
                  className="input"
                  aria-label={field.label}
                  type={
                    field.kind === "date"
                      ? "date"
                      : field.kind === "number"
                        ? "number"
                        : "text"
                  }
                  required={field.required}
                  value={String(draft[field.key] ?? "")}
                  onChange={(e) =>
                    set(
                      field.key,
                      field.kind === "number"
                        ? Number(e.target.value)
                        : field.nullable && !e.target.value
                          ? null
                          : e.target.value,
                    )
                  }
                />
              )}
              {field.hint && <small className="hint">{field.hint}</small>}
            </Field>
          ))}
        </div>
        <div className="editor-actions">
          <Button primary type="submit" disabled={busy}>
            {busy ? "正在保存…" : "保存记录"}
          </Button>
          <Button disabled={busy} onClick={() => guard.protect(onClose)}>
            取消
          </Button>
          <span className="hint">{dirty ? "尚未保存" : "修改后保存生效"}</span>
        </div>
      </form>
    </Modal>
  );
}
