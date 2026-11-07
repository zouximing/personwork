import type {
  Prompt,
  PromptInput,
  SourceUpdate,
  SourceView,
  Task,
  TaskInput,
  TaskPatch,
  TaskDelete,
  RecordEvent,
} from "../../../packages/contracts/src/index";

export type Bootstrap = {
  tasks: Task[];
  prompts: Prompt[];
  sources: SourceView[];
  today: string;
  week: string;
  timezone: string;
  dataDir: string;
  stage: string;
};
let csrfToken = "";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET")
    headers.set("X-Workbench-CSRF", csrfToken);
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      body.error || `请求失败（${response.status}）`,
      response.status,
    );
  }
  if (response.headers.get("content-type")?.includes("application/json"))
    return response.json() as Promise<T>;
  return response.blob() as Promise<T>;
}
export async function session() {
  const value = await request<{ csrfToken: string; authenticated: boolean }>(
    "/session",
  );
  csrfToken = value.csrfToken;
  return value;
}
export const api = {
  bootstrap: () => request<Bootstrap>("/bootstrap"),
  createTask: (value: TaskInput) =>
    request<Task>("/tasks", { method: "POST", body: JSON.stringify(value) }),
  deleteTask: (id: string, value: TaskDelete) =>
    request<{ deleted: true }>(`/tasks/${id}`, { method: "DELETE", body: JSON.stringify(value) }),
  patchTask: (id: string, value: TaskPatch) =>
    request<Task>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(value),
    }),
  savePrompt: (value: PromptInput) =>
    request<Prompt>("/prompts", {
      method: "POST",
      body: JSON.stringify(value),
    }),
  saveSource: (provider: string, value: SourceUpdate) =>
    request<SourceView>(`/sources/${provider}`, {
      method: "PUT",
      body: JSON.stringify(value),
    }),
  history: (id: string) => request<{ items: RecordEvent[] }>(`/history/${id}`),
  list: <T>(path: string) =>
    request<{ items: T[] }>(path).then((value) => value.items),
};
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
