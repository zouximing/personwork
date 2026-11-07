import { useEffect, useRef, useState } from "react";
import { Sparkles, Square } from "lucide-react";
import type { Task } from "../../../../packages/contracts/src/index";
import type { ReviewView } from "../../../../packages/contracts/src/management";
import type {
  DecompositionSuggestion,
  ModelDataClass,
} from "../../../../packages/contracts/src/models";
import { api, errorText, request } from "../api";
import { useModels, ModelChoice } from "../pages/Models";
import { Button, CopyButton, ErrorNotice, Field, type Notify } from "./ui";

export function AiDecompose({
  task,
  onTaskSaved,
  onDirty,
  notify,
}: {
  task: Task;
  onTaskSaved: (task: Task) => void;
  onDirty: (dirty: boolean) => void;
  notify: Notify;
}) {
  const { items: models, error: modelError } = useModels();
  const [modelId, setModelId] = useState("");
  const [dataClass, setDataClass] = useState<ModelDataClass>("internal");
  const [instruction, setInstruction] = useState("");
  const [suggestions, setSuggestions] = useState<DecompositionSuggestion[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    onDirty(!!instruction || !!suggestions.length);
  }, [instruction, suggestions, onDirty]);
  useEffect(() => () => controller.current?.abort(), []);
  const generate = async () => {
    setBusy("generate");
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const result = await request<{ suggestions: DecompositionSuggestion[] }>(
        "/ai/decompose",
        {
          method: "POST",
          body: JSON.stringify({
            modelId,
            taskId: task.id,
            instruction,
            dataClass,
          }),
          signal: abort.signal,
        },
      );
      setSuggestions(result.suggestions);
      setSelected([]);
      notify("模型建议已返回，请编辑并选择要采用的条目");
    } catch (e) {
      setError(
        abort.signal.aborted
          ? "本次调用已取消，现有输入与建议保留"
          : errorText(e),
      );
    } finally {
      setBusy("");
    }
  };
  const adopt = async () => {
    setBusy("adopt");
    setError("");
    try {
      const result = await request<{ items: Task[] }>("/ai/adopt", {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          suggestions: suggestions.filter((_, i) => selected.includes(i)),
        }),
      });
      result.items.forEach(onTaskSaved);
      setSuggestions([]);
      setSelected([]);
      setInstruction("");
      notify("选中的建议已保存为关联子任务，来源系统未被自动改写");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <details className="fact-details">
      <summary>
        <Sparkles size={14} /> AI 辅助拆解（选择后才保存子任务）
      </summary>
      <ErrorNotice error={error || modelError} />
      <ModelChoice
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        dataClass={dataClass}
        onDataClassChange={setDataClass}
      />
      <Field label="拆解补充指令">
        <textarea
          className="input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </Field>
      <div className="editor-actions">
        <Button disabled={!!busy || !modelId} onClick={generate}>
          调用模型提出建议
        </Button>
        {busy === "generate" && (
          <Button onClick={() => controller.current?.abort()}>
            <Square size={13} />
            取消本次调用
          </Button>
        )}
      </div>
      {suggestions.map((s, index) => (
        <div className="result-box" key={index}>
          <label className="check-line">
            <input
              type="checkbox"
              checked={selected.includes(index)}
              onChange={(e) =>
                setSelected((v) =>
                  e.target.checked
                    ? [...v, index]
                    : v.filter((i) => i !== index),
                )
              }
            />
            采用这条建议
          </label>
          {(["title", "expectedResult", "nextAction"] as const).map(
            (key, i) => (
              <Field key={key} label={["建议标题", "预期结果", "下一步"][i]}>
                <input
                  className="input"
                  value={s[key]}
                  onChange={(e) =>
                    setSuggestions((v) =>
                      v.map((item, j) =>
                        j === index ? { ...item, [key]: e.target.value } : item,
                      ),
                    )
                  }
                />
              </Field>
            ),
          )}
        </div>
      ))}
      {suggestions.length > 0 && (
        <Button primary disabled={!!busy || !selected.length} onClick={adopt}>
          保存选中建议为子任务
        </Button>
      )}
    </details>
  );
}
export function AiSummary({
  review,
  onUpdated,
  notify,
}: {
  review: ReviewView;
  onUpdated: (review: ReviewView) => void;
  notify: Notify;
}) {
  const { items: models, error: modelError } = useModels();
  const [modelId, setModelId] = useState("");
  const [dataClass, setDataClass] = useState<ModelDataClass>("internal");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return (
    <details className="fact-details">
      <summary>
        <Sparkles size={14} /> 使用真实模型提出总结建议
      </summary>
      <ErrorNotice error={error || modelError} />
      <ModelChoice
        models={models}
        modelId={modelId}
        onModelChange={setModelId}
        dataClass={dataClass}
        onDataClassChange={setDataClass}
      />
      <div className="editor-actions">
        <Button
          disabled={!modelId || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            const abort = new AbortController();
            controller.current = abort;
            try {
              const result = await request<{ text: string }>("/ai/summarize", {
                method: "POST",
                body: JSON.stringify({
                  modelId,
                  reviewId: review.id,
                  dataClass,
                }),
                signal: abort.signal,
              });
              setText(result.text);
              const reviews = await api.list<ReviewView>("/reviews");
              const updated = reviews.find((r) => r.id === review.id);
              if (updated) onUpdated(updated);
              notify("模型建议已保留为独立草稿，请人工核对后采用");
            } catch (e) {
              setError(
                abort.signal.aborted
                  ? "调用已取消，已有人工草稿继续保留"
                  : errorText(e),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          调用模型整理建议
        </Button>
        {busy && (
          <Button onClick={() => controller.current?.abort()}>取消调用</Button>
        )}
      </div>
      {text && (
        <div className="result-box">
          <p className="hint">独立模型建议，没有覆盖人工章节或发布版本。</p>
          <pre>{text}</pre>
          <CopyButton body={text} label="复制模型建议" notify={notify} />
        </div>
      )}
    </details>
  );
}
