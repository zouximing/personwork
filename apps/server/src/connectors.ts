import { z } from 'zod';
import { localDate, type Provider } from '@workbench/contracts';
import { AppError } from './errors.js';
import type { SourceObjectType } from '../../../packages/contracts/src/sources.js';

// Public API contracts checked 2026-11-07. The deployed intranet versions still require acceptance.
// https://docs.gitlab.com/api/issues/ ; https://docs.gitlab.com/api/merge_requests/ ; https://docs.gitlab.com/api/rest/#pagination
// https://developer.pingcode.com/restapi/pingcode/getV2PjmWorkitems
// https://developer.pingcode.com/restapi/pingcode/usePersonalUserToken
// https://developer.pingcode.com/restapi/pingcode/postV2Comments
// https://developer.pingcode.com/restapi/pingcode/getV2CommentsByPrincipalTypeAndPrincipalId
const identifier = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
const ref = z.object({ id: identifier, name: z.string().optional() });
const pingItem = z.object({
  id: identifier, project: ref, title: z.string(), identifier: z.union([z.string(), z.number()]).optional(), whole_identifier: z.string().optional(),
  html_url: z.string().optional(), state: ref, priority: ref.nullable().optional(), assignee: ref.nullable().optional(),
  due: z.object({ date: z.number(), with_time: z.number().optional() }).nullable().optional(), updated_at: z.number().optional()
});
const gitItem = z.object({
  id: identifier, iid: z.number().int().positive(), project_id: identifier, title: z.string(), state: z.string(), web_url: z.string(),
  sha: z.string().min(1), reviewers: z.array(ref), assignees: z.array(ref).optional(), assignee: ref.nullable().optional(), author: ref.nullable().optional(), updated_at: z.string().optional()
});
const gitIssue = z.object({
  id: identifier, iid: z.number().int().positive(), project_id: identifier, title: z.string(), state: z.string(), web_url: z.string(),
  assignees: z.array(ref), author: ref.nullable().optional(), due_date: z.string().nullable().optional(), updated_at: z.string().optional()
});
const commentSchema = z.object({ id: identifier, content: z.string(), is_deleted: z.union([z.number(), z.boolean()]).optional() });
export type RemoteComment = z.infer<typeof commentSchema>;
export type RemoteObject = {
  objectType: SourceObjectType; assignedAsAssignee: boolean; assignedAsReviewer: boolean;
  projectId: string; projectName: string; externalId: string; number: string; title: string; url: string; state: string; stateId: string;
  due: string | null; priority: string; author: string; assigneeId: string; sha: string | null; assignedToMe: boolean; sourceUpdatedAt: string | null;
};
export class SourceHttpError extends AppError {
  constructor(status: number, message: string, readonly outcomeUnknown = false) { super(status, message); }
}
export type ConnectorSettings = { provider: Provider; baseUrl: string; projectScope: string; identity: string; historyDays: number };
export function normalizeBaseUrl(value: string): string { return value ? new URL(value).toString().replace(/\/+$/, '') : ''; }
export function projects(scope: string): string[] {
  const values = [...new Set(scope.split(/[,\n]/).map(value => value.trim()).filter(Boolean))];
  if (!values.length || values.length > 100) throw new AppError(400, '请填写 1 至 100 个明确项目 ID，以逗号或换行分隔');
  return values;
}
export class SourceConnector {
  constructor(readonly settings: ConnectorSettings, private readonly token: string, private readonly timeoutMs = 15000, private readonly beforeRequest?: () => void) {}
  private async request(path: string, query: Record<string, string> = {}, body?: Record<string, unknown>): Promise<{ data: unknown; headers: Headers }> {
    this.beforeRequest?.();
    if (this.settings.provider === 'gitlab' && body) throw new AppError(403, 'GitLab 仅允许读取');
    const prefix = this.settings.provider === 'gitlab' ? '/api/v4' : '';
    if (this.settings.provider === 'gitlab' && !/^\/(user|projects\/[^/]+\/(?:merge_requests|issues)(?:\/\d+)?)$/.test(path)) throw new AppError(403, 'GitLab 读取接口不在允许清单');
    if (this.settings.provider === 'pingcode' && !/^\/v2\/(myself|pjm\/workitems(?:\/[^/]+)?|comments)$/.test(path)) throw new AppError(403, 'PingCode 接口不在允许清单');
    const url = new URL(`${this.settings.baseUrl}${prefix}${path}`); Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.settings.provider === 'gitlab') headers['PRIVATE-TOKEN'] = this.token; else headers.authorization = `Bearer ${this.token}`;
      if (body) headers['content-type'] = 'application/json';
      const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) {
        const reason = response.status === 401 ? '认证失败，请检查凭据' : response.status === 403 ? '没有读取或提交权限' : response.status === 404 ? '接口或对象不存在，请核实实例版本与项目范围' : `来源返回 HTTP ${response.status}`;
        throw new SourceHttpError(response.status >= 500 ? 502 : response.status, reason, Boolean(body) && response.status >= 500);
      }
      const text = await response.text(); if (text.length > 5_000_000) throw new SourceHttpError(502, '来源单页响应过大，已停止处理', Boolean(body));
      let data: unknown; try { data = JSON.parse(text); } catch { throw new SourceHttpError(502, '来源响应不是有效 JSON，未计为成功', Boolean(body)); }
      return { data, headers: response.headers };
    } catch (error) {
      if (error instanceof SourceHttpError) throw error;
      throw new SourceHttpError(502, '来源网络、证书或超时错误；请检查运行端的授权网络路径', Boolean(body));
    }
  }
  async identity(): Promise<{ id: string; name: string }> {
    const { data } = await this.request(this.settings.provider === 'gitlab' ? '/user' : '/v2/myself');
    const result = z.object({ id: identifier, name: z.string().optional(), display_name: z.string().optional() }).safeParse(data);
    if (!result.success) throw new SourceHttpError(502, '身份响应字段不兼容，请核实实例版本');
    return { id: result.data.id, name: result.data.display_name ?? result.data.name ?? result.data.id };
  }
  private async pingPages(path: string, query: Record<string, string>): Promise<unknown[]> {
    const result: unknown[] = []; const seen = new Set<string>(); let expectedTotal: number | null = null;
    for (let page = 0; page < 1000; page++) {
      const { data } = await this.request(path, { ...query, page_index: String(page), page_size: '100' });
      const parsed = z.object({ page_index: z.number().int().nonnegative(), page_size: z.number().int().positive(), total: z.number().int().nonnegative(), values: z.array(z.unknown()) }).safeParse(data);
      if (!parsed.success || parsed.data.page_index !== page) throw new SourceHttpError(502, '分页响应不完整或接口版本不兼容，保留已有缓存');
      const current = parsed.data; expectedTotal ??= current.total;
      if (expectedTotal !== current.total) throw new SourceHttpError(502, '分页期间来源总数发生变化，请重新刷新');
      if (current.values.length > current.page_size || (!current.values.length && result.length < current.total)) throw new SourceHttpError(502, '来源返回不完整分页，保留已有缓存');
      for (const value of current.values) {
        const key = z.object({ id: identifier }).safeParse(value); if (!key.success || seen.has(key.data.id)) throw new SourceHttpError(502, '来源分页标识缺失或重复，未计为同步成功');
        seen.add(key.data.id); result.push(value);
      }
      if (result.length === current.total) return result;
      if (result.length > current.total) throw new SourceHttpError(502, '来源分页总数不一致');
    }
    throw new SourceHttpError(502, '分页超过安全上限，未计为完整同步');
  }
  private parsePing(data: unknown): RemoteObject {
    const result = pingItem.safeParse(data); if (!result.success) throw new SourceHttpError(502, 'PingCode 工作项字段不兼容，未覆盖缓存');
    const item = result.data; const timestamp = item.due?.date;
    return { objectType: 'work_item', assignedAsAssignee: item.assignee?.id === this.settings.identity, assignedAsReviewer: false,
      projectId: item.project.id, projectName: item.project.name ?? item.project.id, externalId: item.id, number: item.whole_identifier ?? String(item.identifier ?? item.id),
      title: item.title, url: item.html_url ?? '', state: item.state.name ?? item.state.id, stateId: item.state.id,
      due: timestamp !== undefined && Number.isFinite(new Date(timestamp * 1000).valueOf()) ? localDate(new Date(timestamp * 1000)) : null,
      priority: item.priority?.name ?? '', author: '', assigneeId: item.assignee?.id ?? '', sha: null,
      assignedToMe: item.assignee?.id === this.settings.identity, sourceUpdatedAt: item.updated_at ? new Date(item.updated_at * 1000).toISOString() : null };
  }
  private parseGit(data: unknown): RemoteObject {
    const result = gitItem.safeParse(data); if (!result.success) throw new SourceHttpError(502, 'GitLab MR 字段不兼容（需 reviewers 与 sha），未覆盖缓存');
    const item = result.data;
    const assignees = item.assignees ?? (item.assignee ? [item.assignee] : []);
    const assignedAsAssignee = assignees.some(assignee => assignee.id === this.settings.identity);
    const assignedAsReviewer = item.reviewers.some(reviewer => reviewer.id === this.settings.identity);
    return { objectType: 'merge_request', assignedAsAssignee, assignedAsReviewer,
      projectId: item.project_id, projectName: item.project_id, externalId: item.id, number: String(item.iid), title: item.title,
      url: item.web_url, state: item.state, stateId: item.state, due: null, priority: '', author: item.author?.name ?? '', assigneeId: assignedAsAssignee ? this.settings.identity : assignees[0]?.id ?? '', sha: item.sha,
      assignedToMe: assignedAsAssignee || assignedAsReviewer, sourceUpdatedAt: item.updated_at ?? null };
  }
  private parseGitIssue(data: unknown): RemoteObject {
    const result = gitIssue.safeParse(data); if (!result.success) throw new SourceHttpError(502, 'GitLab Issue 字段不兼容，未覆盖缓存');
    const item = result.data; const assignedAsAssignee = item.assignees.some(assignee => assignee.id === this.settings.identity);
    return { objectType: 'issue', assignedAsAssignee, assignedAsReviewer: false,
      projectId: item.project_id, projectName: item.project_id, externalId: item.id, number: String(item.iid), title: item.title,
      url: item.web_url, state: item.state, stateId: item.state, due: item.due_date ?? null, priority: '', author: item.author?.name ?? '',
      assigneeId: assignedAsAssignee ? this.settings.identity : item.assignees[0]?.id ?? '', sha: null, assignedToMe: assignedAsAssignee, sourceUpdatedAt: item.updated_at ?? null };
  }
  private async gitPages(project: string, kind: 'merge_request' | 'issue', query: Record<string, string>): Promise<RemoteObject[]> {
    const result: RemoteObject[] = []; const seen = new Set<string>(); let expectedTotal: number | null = null;
    for (let page = 1; page <= 1000; page++) {
      const { data, headers } = await this.request(`/projects/${encodeURIComponent(project)}/${kind === 'issue' ? 'issues' : 'merge_requests'}`, {
        ...query, scope: 'all', per_page: '100', page: String(page)
      });
      if (!Array.isArray(data)) throw new SourceHttpError(502, 'GitLab 分页响应不是列表');
      if (headers.has('x-total')) { const total = Number(headers.get('x-total')); if (!Number.isInteger(total) || total < 0 || expectedTotal !== null && expectedTotal !== total) throw new SourceHttpError(502, 'GitLab 分页总数不一致'); expectedTotal = total; }
      for (const value of data) {
        const remote = kind === 'issue' ? this.parseGitIssue(value) : this.parseGit(value);
        if (remote.projectId !== project) throw new SourceHttpError(502, 'GitLab 返回项目超出配置范围；请使用数字项目 ID');
        if (seen.has(remote.externalId)) throw new SourceHttpError(502, 'GitLab 重复分页，未计为完整同步');
        seen.add(remote.externalId); if (remote.assignedToMe) result.push(remote);
      }
      const next = headers.get('x-next-page');
      if (next === '' || next === null && data.length < 100) {
        if (expectedTotal !== null && seen.size !== expectedTotal) throw new SourceHttpError(502, 'GitLab 返回不完整分页'); return result;
      }
      if (next !== null && Number(next) !== page + 1) throw new SourceHttpError(502, 'GitLab 分页游标不连续或超过安全上限');
    }
    throw new SourceHttpError(502, 'GitLab 分页超过安全上限');
  }
  async readObjects(): Promise<RemoteObject[]> {
    const result: RemoteObject[] = [];
    for (const project of projects(this.settings.projectScope)) {
      if (this.settings.provider === 'pingcode') {
        const end = Math.floor(Date.now() / 1000); const start = end - this.settings.historyDays * 86400;
        const list = await this.pingPages('/v2/pjm/workitems', { project_id: project, assignee_id: this.settings.identity, updated_between: `${start},${end}`, include_archived: 'true', include_deleted: 'true' });
        for (const item of list) { const remote = this.parsePing(item); if (remote.projectId !== project) throw new SourceHttpError(502, '来源返回项目超出配置范围'); result.push(remote); }
      } else {
        const objects = new Map<string, RemoteObject>();
        for (const kind of ['merge_request', 'issue'] as const) {
          const roles = kind === 'issue' ? ['assignee_id'] : ['reviewer_id', 'assignee_id'];
          for (const role of roles) {
            // Open work must not disappear merely because it has been quiet longer than historyDays.
            const ranges: Record<string, string>[] = [{ state: 'opened' }, { state: 'all', updated_after: new Date(Date.now() - this.settings.historyDays * 86400000).toISOString() }];
            for (const range of ranges) {
              const list = await this.gitPages(project, kind, { [role]: this.settings.identity, ...range });
              for (const remote of list) objects.set(`${kind}/${remote.externalId}`, remote);
            }
          }
        }
        result.push(...objects.values());
      }
    }
    return result;
  }
  async readObject(projectId: string, externalId: string, number: string, objectType: SourceObjectType = this.settings.provider === 'gitlab' ? 'merge_request' : 'work_item'): Promise<RemoteObject> {
    const { data } = await this.request(this.settings.provider === 'gitlab' ? `/projects/${encodeURIComponent(projectId)}/${objectType === 'issue' ? 'issues' : 'merge_requests'}/${encodeURIComponent(number)}` : `/v2/pjm/workitems/${encodeURIComponent(externalId)}`);
    const remote = this.settings.provider === 'gitlab' ? objectType === 'issue' ? this.parseGitIssue(data) : this.parseGit(data) : this.parsePing(data);
    if (remote.projectId !== projectId || remote.externalId !== externalId) throw new SourceHttpError(502, '来源对象身份不一致，已停止操作');
    return remote;
  }
  async comments(externalId: string): Promise<RemoteComment[]> {
    if (this.settings.provider !== 'pingcode') throw new AppError(403, 'GitLab 不允许回写');
    const list = await this.pingPages('/v2/comments', { principal_type: 'workitem', principal_id: externalId });
    const result = z.array(commentSchema).safeParse(list); if (!result.success) throw new SourceHttpError(502, '评论读取响应不兼容，结果仍待核实'); return result.data.filter(item => !item.is_deleted);
  }
  async postComment(externalId: string, content: string): Promise<RemoteComment> {
    if (this.settings.provider !== 'pingcode') throw new AppError(403, 'GitLab 不允许回写');
    const { data } = await this.request('/v2/comments', {}, { principal_type: 'workitem', principal_id: externalId, content });
    const result = commentSchema.safeParse(data); if (!result.success) throw new SourceHttpError(502, '评论已发出但回执无法识别，请先核实', true); return result.data;
  }
}
