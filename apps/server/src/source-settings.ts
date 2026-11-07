import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateOnly, providerSchema, sourceFields, sourceUpdateSchema, type Provider, type SourceRecord, type SourceView, type Task } from '@workbench/contracts';
import { sourceObjectSchema, sourceObjectType, isMergeRequest, writebackSchema, writebackInputSchema, reviewStatuses, type SourceObject, type Writeback, type SourceSyncResult, type SourceTestResult } from '../../../packages/contracts/src/sources.js';
import { Workbench } from './workbench.js';
import { AppError } from './errors.js';
import { isPrivateMaterial } from './material-privacy.js';
import { SourceConnector, SourceHttpError, normalizeBaseUrl, projects, type RemoteObject } from './connectors.js';

export interface SourceSecretVault { set(ref: string, value: string): Promise<void>; get(ref: string): Promise<string | undefined>; remove(ref: string): Promise<void> }
type SyncMetadata = { lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string; syncStatus: 'never' | 'success' | 'partial' | 'failed' };
type Configuration = SourceRecord & SyncMetadata;
export type SourceSettingsView = Omit<SourceView, 'syncImplemented'> & SyncMetadata & { syncImplemented: boolean; instanceAcceptance: 'not_verified'; stateWriteCapability: 'not_verified' };
const reviewInput = z.object({ revision: z.string().uuid(), reviewStatus: z.enum(reviewStatuses), checkedSha: z.string().max(200).nullable(), conclusion: z.string().max(20000), followUpDate: dateOnly.nullable() }).strict();
const syncDefaults: SyncMetadata = { lastAttemptAt: null, lastSuccessAt: null, lastError: '', syncStatus: 'never' };
const now = () => new Date().toISOString();

export class SourceService {
  private readonly syncing = new Map<Provider, Promise<SourceSyncResult>>();
  private readonly submitting = new Map<string, Promise<Writeback>>();
  private readonly verifying = new Map<string, Promise<Writeback>>();
  private scheduler: ReturnType<typeof setInterval> | undefined;
  private readonly nextSchedule = new Map<Provider, number>();
  private closing = false;
  private closePromise: Promise<void> | undefined;
  constructor(readonly workbench: Workbench, private readonly vault: SourceSecretVault, private readonly options: { requestTimeoutMs?: number } = {}) {
    for (const provider of providerSchema.options) this.configuration(provider);
    // A process restart cannot establish the outcome of an already-issued write. Never replay it.
    for (const item of this.listWritebacks()) if (item.status === 'submitting') this.saveWriteback(item, { status: 'uncertain', statusNote: '程序在提交期间重启；请读取来源核实，禁止自动重发' });
  }
  private configuration(provider: Provider): Configuration {
    const record = this.workbench.storage.list<Configuration>('source').find(item => item.provider === provider);
    if (record) return { ...syncDefaults, ...record };
    const at = now(); const initial: Configuration = {
      id: randomUUID(), revision: randomUUID(), createdAt: at, updatedAt: at, provider, instanceId: randomUUID(), credentialRef: null,
      name: provider === 'gitlab' ? 'GitLab' : 'PingCode', baseUrl: '', projectScope: '', identity: '', historyDays: 90,
      enabled: false, intervalMinutes: 15, scheduleEnabled: false, connectionStatus: 'not_tested', writeStatus: 'not_verified', ...syncDefaults
    };
    this.workbench.storage.put('source', initial); return initial;
  }
  private view(record: Configuration): SourceSettingsView {
    const { credentialRef, ...fields } = record;
    return { ...fields, hasCredential: Boolean(credentialRef), syncImplemented: true, instanceAcceptance: 'not_verified', stateWriteCapability: 'not_verified' };
  }
  listSources(): SourceSettingsView[] { return providerSchema.options.map(provider => this.view(this.configuration(provider))); }
  async updateSource(provider: Provider, input: unknown): Promise<SourceSettingsView> {
    const fields = sourceUpdateSchema.parse(input); const previous = this.configuration(provider);
    if (previous.revision !== fields.revision) throw new AppError(409, '来源设置已被更新，请保留输入并重新读取');
    const baseUrl = normalizeBaseUrl(fields.baseUrl); const changedAddress = baseUrl !== normalizeBaseUrl(previous.baseUrl);
    if (fields.enabled && (!baseUrl || !fields.identity.trim())) throw new AppError(400, '启用来源需填写 API 根地址、本人 ID 和项目范围');
    if (fields.enabled) {
      const scope = projects(fields.projectScope);
      if (provider === 'gitlab' && (!/^\d+$/.test(fields.identity) || scope.some(project => !/^\d+$/.test(project)))) throw new AppError(400, 'GitLab 本人 ID 和项目范围应填写数字 ID');
    }
    if (fields.credentialAction !== 'replace' && fields.credential) throw new AppError(400, '请明确选择更换凭据后再填写新凭据');
    if (fields.credentialAction === 'replace' && !fields.credential?.trim()) throw new AppError(400, '更换凭据需填写新凭据');
    const settingsFields = sourceFields.parse(Object.fromEntries(Object.keys(sourceFields.shape).map(key => [key, fields[key as keyof typeof fields]])));
    const credentialRef = fields.credentialAction === 'replace' ? randomUUID() : fields.credentialAction === 'clear' || changedAddress ? null : previous.credentialRef;
    if (credentialRef && fields.credentialAction === 'replace') await this.vault.set(credentialRef, fields.credential!);
    const record: Configuration = {
      ...previous, ...settingsFields, baseUrl, revision: randomUUID(), updatedAt: now(), credentialRef,
      instanceId: changedAddress ? randomUUID() : previous.instanceId, connectionStatus: 'not_tested', writeStatus: 'not_verified',
      ...(changedAddress ? syncDefaults : {})
    };
    try {
      this.workbench.storage.database.transaction(() => {
        this.workbench.storage.put('source', record, fields.revision);
        this.workbench.storage.event(record.id, 'source.settings.updated', { provider, instanceId: record.instanceId, changedAddress, enabled: record.enabled, credentialAction: fields.credentialAction });
      })();
    } catch (error) { if (credentialRef && credentialRef !== previous.credentialRef) await this.vault.remove(credentialRef); throw error; }
    if (previous.credentialRef && previous.credentialRef !== credentialRef) await this.vault.remove(previous.credentialRef);
    this.nextSchedule.set(provider, Date.now() + record.intervalMinutes * 60000);
    return this.view(record);
  }
  private async connector(record: Configuration, requireEnabled = true): Promise<SourceConnector> {
    this.ensureOpen();
    if (requireEnabled && !record.enabled) throw new AppError(409, '来源已停用，不发起请求');
    if (!record.baseUrl || !record.identity.trim()) throw new AppError(400, '请先填写 API 根地址、本人 ID 和项目范围');
    projects(record.projectScope);
    if (!record.credentialRef) throw new AppError(400, '未设置凭据；地址变更后需明确填写新凭据');
    const token = await this.vault.get(record.credentialRef); if (!token) throw new AppError(400, '凭据不可用，请重新设置');
    return new SourceConnector(record, token, this.options.requestTimeoutMs, () => {
      this.ensureOpen();
      if (requireEnabled) this.ensureCurrent(record);
      else {
        const current = this.configuration(record.provider);
        if (current.baseUrl !== record.baseUrl || current.instanceId !== record.instanceId || current.credentialRef !== record.credentialRef) throw new AppError(409, '核实期间来源地址或凭据发生变化，请重新读取');
      }
    });
  }
  async testSource(provider: Provider, input: unknown): Promise<SourceTestResult> {
    const fields = sourceUpdateSchema.parse(input); const previous = this.configuration(provider); const baseUrl = normalizeBaseUrl(fields.baseUrl);
    const testedConfiguration = { provider, baseUrl, projectScope: fields.projectScope, identity: fields.identity, historyDays: fields.historyDays };
    try {
      if (!baseUrl || !fields.identity.trim()) throw new AppError(400, '测试需填写 API 根地址和本人 ID');
      projects(fields.projectScope);
      let token: string | undefined;
      if (fields.credentialAction === 'replace') token = fields.credential;
      else if (fields.credentialAction === 'keep' && baseUrl === normalizeBaseUrl(previous.baseUrl) && previous.credentialRef) token = await this.vault.get(previous.credentialRef);
      if (!token?.trim()) throw new AppError(400, '测试配置没有可用凭据；新地址不能沿用旧凭据');
      const connector = new SourceConnector(testedConfiguration, token, this.options.requestTimeoutMs);
      const identity = await connector.identity(); if (identity.id !== fields.identity) throw new AppError(400, '认证身份与配置的本人 ID 不一致');
      await connector.readObjects();
      return { status: 'read_ok', identity: identity.id, message: '编辑中的配置已通过身份和项目读取；实例兼容性及回写权限仍需单独验收', writeStatus: 'not_verified', testedConfiguration };
    } catch (error) { return { status: 'failed', identity: null, message: safeError(error), writeStatus: 'not_verified', testedConfiguration }; }
  }
  listRecords(): SourceObject[] { return this.workbench.storage.list<SourceObject>('source-record').map(item => sourceObjectSchema.parse(item)).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)); }
  getRecord(id: string): SourceObject { const record = this.workbench.storage.get<SourceObject>('source-record', id); if (!record) throw new AppError(404, '来源记录不存在'); return sourceObjectSchema.parse(record); }
  bind(id: string, input: unknown): SourceObject {
    const fields = z.object({ revision: z.string().uuid(), taskId: z.string().uuid() }).strict().parse(input);
    const previous = this.getRecord(id);
    if (previous.revision !== fields.revision) throw new AppError(409, '来源记录已被更新，请重新读取');
    const target = this.workbench.storage.get<Task>('task', fields.taskId); if (!target) throw new AppError(404, '待绑定任务不存在');
    if (this.listRecords().some(item => item.id !== id && item.localTaskId === target.id)) throw new AppError(409, '该任务已绑定其他来源；请通过来源关联保留独立身份');
    if (previous.localTaskId === target.id) return previous;
    return this.workbench.storage.database.transaction(() => {
      const privateSource = isPrivateMaterial(this.workbench.storage, 'source-record', id);
      const imported = previous.localTaskId ? this.workbench.storage.get<Task>('task', previous.localTaskId) : undefined;
      const untouched = imported && imported.id === previous.autoCreatedTaskId && imported.revision === previous.autoCreatedTaskRevision && !this.taskHasPersonalReferences(imported.id);
      const oldTask = untouched ? this.workbench.patchTask(imported.id, { revision: imported.revision, archived: true, archiveReason: '来源经本人确认绑定已有任务，保留此未修改导入空壳的历史，避免重复统计' }) : imported;
      if (oldTask) this.workbench.storage.put('task', { ...oldTask, internalContext: true, ...(isPrivateMaterial(this.workbench.storage, 'task', oldTask.id) ? { privacyRestricted: true } : {}), revision: randomUUID(), updatedAt: now() }, oldTask.revision);
      const record: SourceObject = { ...previous, ...(privateSource ? { privacyRestricted: true } : {}), localTaskId: target.id, revision: randomUUID(), updatedAt: now(), attentionReason: imported && !untouched ? '原导入任务已有个人修改，已保留为独立行动；请检查是否需要归档' : previous.attentionReason };
      this.workbench.storage.put('source-record', record, fields.revision);
      this.workbench.storage.put('task', { ...target, internalContext: true, ...(privateSource ? { privacyRestricted: true } : {}), sourceState: previous.sourceState, revision: randomUUID(), updatedAt: now() }, target.revision);
      this.workbench.storage.event(id, 'source.object.bound', { taskId: target.id, previousTaskId: previous.localTaskId, previousTaskArchived: Boolean(untouched) }); return record;
    })();
  }
  private taskHasPersonalReferences(taskId: string): boolean {
    if (this.workbench.listTasks().some(item => item.parentId === taskId)) return true;
    for (const kind of ['period', 'risk', 'milestone', 'execution'] as const) if (this.workbench.storage.list<{ taskIds?: string[] }>(kind).some(item => item.taskIds?.includes(taskId))) return true;
    if (this.workbench.storage.list<{ occurrences?: { taskId: string }[] }>('recurrence').some(item => item.occurrences?.some(value => value.taskId === taskId))) return true;
    return this.workbench.storage.list<{ selections?: { taskIds?: string[] }; facts?: { kind: string; id: string }[] }>('review').some(item => item.selections?.taskIds?.includes(taskId) || item.facts?.some(fact => fact.kind === 'task' && fact.id === taskId));
  }
  link(id: string, input: unknown): SourceObject {
    const fields = z.object({ revision: z.string().uuid(), sourceRecordIds: z.array(z.string().uuid()).max(100) }).strict().parse(input);
    const previous = this.getRecord(id); if (previous.revision !== fields.revision) throw new AppError(409, '来源记录已被更新，请重新读取');
    const nextIds = [...new Set(fields.sourceRecordIds)]; const related = nextIds.map(key => this.getRecord(key));
    if (related.some(item => item.provider === previous.provider)) throw new AppError(400, '只允许关联独立的 PingCode 工作项与 GitLab 来源事项');
    return this.workbench.storage.database.transaction(() => {
      const record: SourceObject = { ...previous, linkedSourceIds: nextIds, revision: randomUUID(), updatedAt: now() };
      for (const key of new Set([...(previous.linkedSourceIds ?? []), ...nextIds])) {
        const other = this.getRecord(key); const linked = new Set(other.linkedSourceIds ?? []); if (nextIds.includes(key)) linked.add(id); else linked.delete(id);
        this.workbench.storage.put('source-record', { ...other, linkedSourceIds: [...linked], revision: randomUUID(), updatedAt: now() }, other.revision);
      }
      this.workbench.storage.put('source-record', record, fields.revision); this.workbench.storage.event(id, 'source.object.linked', { sourceRecordIds: nextIds }); return record;
    })();
  }
  review(id: string, input: unknown): SourceObject {
    const fields = reviewInput.parse(input); const previous = this.getRecord(id);
    if (!isMergeRequest(previous)) throw new AppError(400, '只有 GitLab MR 可登记本人评审');
    if (fields.reviewStatus === 'reviewed' && !fields.checkedSha) throw new AppError(400, '已评审需登记实际检查的提交版本');
    const record = sourceObjectSchema.parse({ ...previous, ...fields, revision: randomUUID(), updatedAt: now(), needsReview: Boolean(fields.checkedSha && fields.checkedSha !== previous.currentSha) });
    this.workbench.storage.database.transaction(() => {
      this.workbench.storage.put('source-record', record, fields.revision);
      this.workbench.storage.event(record.id, 'source.review.updated', { checkedSha: record.checkedSha, reviewStatus: record.reviewStatus });
    })(); return record;
  }
  sync(provider: Provider): Promise<SourceSyncResult> {
    if (this.closing) return Promise.resolve({ status: 'skipped', count: 0, message: '来源服务正在关闭', lastSuccessAt: null });
    const running = this.syncing.get(provider); if (running) return running;
    const operation = this.performSync(provider).finally(() => this.syncing.delete(provider)); this.syncing.set(provider, operation); return operation;
  }
  private async performSync(provider: Provider): Promise<SourceSyncResult> {
    const config = this.configuration(provider);
    if (!config.enabled) return { status: 'skipped', count: 0, message: '来源已停用', lastSuccessAt: config.lastSuccessAt };
    const attemptedAt = now(); let list: RemoteObject[] = []; let partialError = '';
    try {
      const connector = await this.connector(config); const identity = await connector.identity();
      if (identity.id !== config.identity) throw new AppError(400, '认证身份与配置的本人 ID 不一致，已停止同步');
      list = await connector.readObjects();
      const keys = new Set(list.map(item => `${item.objectType}/${item.projectId}/${item.externalId}`));
      // The reviewer/assignee filter can hide removals. Re-read cached objects explicitly; a missing object never becomes done.
      const cached = this.listRecords().filter(item => item.provider === provider && item.instanceId === config.instanceId && projects(config.projectScope).includes(item.projectId));
      for (const item of cached) if (!keys.has(`${sourceObjectType(item)}/${item.projectId}/${item.externalId}`)) {
        try { list.push(await connector.readObject(item.projectId, item.externalId, item.number, sourceObjectType(item))); }
        catch (error) { partialError = safeError(error); }
      }
      this.ensureCurrent(config);
      this.workbench.storage.database.transaction(() => {
        for (const remote of list) this.mergeObject(config, remote, attemptedAt);
        const record: Configuration = { ...config, ...{ lastAttemptAt: attemptedAt, lastSuccessAt: partialError ? config.lastSuccessAt : now(), lastError: partialError, syncStatus: partialError ? 'partial' : 'success' } };
        this.workbench.storage.put('source', record, config.revision);
        this.workbench.storage.event(config.id, 'source.sync', { provider, status: record.syncStatus, count: list.length });
      })();
      return { status: partialError ? 'partial' : 'success', count: list.length, message: partialError || '已读取并保存来源快照；个人安排保持独立', lastSuccessAt: partialError ? config.lastSuccessAt : this.configuration(provider).lastSuccessAt };
    } catch (error) {
      const current = this.configuration(provider); const message = safeError(error);
      if (current.revision === config.revision) this.workbench.storage.put('source', { ...current, lastAttemptAt: attemptedAt, lastError: message, syncStatus: 'failed' }, current.revision);
      return { status: 'failed', count: 0, message, lastSuccessAt: config.lastSuccessAt };
    }
  }
  private mergeObject(config: Configuration, remote: RemoteObject, at: string): void {
    const previous = this.listRecords().find(item => item.provider === config.provider && item.instanceId === config.instanceId && sourceObjectType(item) === remote.objectType && (config.provider === 'pingcode' || item.projectId === remote.projectId) && item.externalId === remote.externalId);
    const task = previous?.localTaskId ? this.workbench.storage.get<Task>('task', previous.localTaskId) : undefined;
    const mr = remote.objectType === 'merge_request';
    let localTask = task ?? this.workbench.createTask({ title: remote.title, project: remote.projectName, type: 'task', nextAction: mr ? remote.assignedAsReviewer ? '在 GitLab 检查本轮提交' : '在 GitLab 跟进指派给我的 MR' : '' });
    const untouched = !previous || Boolean(previous.autoCreatedTaskId === localTask.id && previous.autoCreatedTaskRevision === localTask.revision);
    if (localTask.sourceState !== remote.state) {
      const refreshedTask = { ...localTask, sourceState: remote.state, revision: randomUUID(), updatedAt: at };
      this.workbench.storage.put('task', refreshedTask, localTask.revision); localTask = refreshedTask;
    }
    const assignmentChanged = Boolean(previous && (previous.assignedToMe && !remote.assignedToMe || previous.assignedAsAssignee && !remote.assignedAsAssignee || (previous.assignedAsReviewer ?? (isMergeRequest(previous) && previous.assignedToMe)) && !remote.assignedAsReviewer));
    const attentionReason = assignmentChanged ? remote.assignedToMe ? '来源指派或评审安排已变化，仍有本人职责，请检查个人行动' : '来源已不再分配给本人，请检查遗留个人行动' : ['merged', 'closed'].includes(remote.state) ? mr ? 'MR 已结束，请检查遗留个人行动；不自动认定本人已评审' : '来源事项已关闭，请独立核对个人行动与交付' : previous && previous.sourceState !== remote.state ? '来源状态已变化，请独立核对个人行动与交付' : '';
    const record: SourceObject = {
      id: previous?.id ?? randomUUID(), revision: randomUUID(), createdAt: previous?.createdAt ?? at, updatedAt: at,
      ...(previous?.privacyRestricted ? { privacyRestricted: true } : {}),
      provider: config.provider, instanceId: config.instanceId, projectId: remote.projectId, projectName: remote.projectName, externalId: remote.externalId,
      objectType: remote.objectType, assignedAsAssignee: remote.assignedAsAssignee, assignedAsReviewer: remote.assignedAsReviewer,
      number: remote.number, title: remote.title, url: remote.url, sourceState: remote.state, sourceStateId: remote.stateId, sourceDueDate: remote.due,
      sourcePriority: remote.priority, author: remote.author, assigneeId: remote.assigneeId, currentSha: remote.sha,
      checkedSha: previous?.checkedSha ?? null, reviewStatus: previous?.reviewStatus ?? 'not_started', conclusion: previous?.conclusion ?? '', followUpDate: previous?.followUpDate ?? null,
      needsReview: Boolean(mr && previous?.checkedSha && previous.checkedSha !== remote.sha), reviewAssignmentChanged: assignmentChanged || previous?.reviewAssignmentChanged || false,
      assignedToMe: remote.assignedToMe, attentionReason, localTaskId: localTask.id, lastSeenAt: at, sourceUpdatedAt: remote.sourceUpdatedAt,
      linkedSourceIds: previous?.linkedSourceIds ?? [], autoCreatedTaskId: previous?.autoCreatedTaskId ?? (!previous ? localTask.id : null),
      autoCreatedTaskRevision: untouched ? localTask.revision : null
    };
    this.workbench.storage.put('source-record', record, previous?.revision);
    if (!previous || previous.sourceState !== remote.state || previous.currentSha !== remote.sha || assignmentChanged) this.workbench.storage.event(record.id, previous ? 'source.object.changed' : 'source.object.imported', { sourceState: remote.state, currentSha: remote.sha, localTaskId: localTask.id });
  }
  private ensureCurrent(config: Configuration): void {
    this.ensureOpen();
    const current = this.configuration(config.provider);
    if (!current.enabled || current.instanceId !== config.instanceId || current.revision !== config.revision || current.baseUrl !== config.baseUrl) throw new AppError(409, '来源设置已变更或停用，旧请求结果未投向新配置');
  }
  listWritebacks(): Writeback[] { return this.workbench.storage.list<Writeback>('writeback').map(item => writebackSchema.parse(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  private writeback(id: string): Writeback { const record = this.workbench.storage.get<Writeback>('writeback', id); if (!record) throw new AppError(404, '回写预览不存在'); return writebackSchema.parse(record); }
  createWriteback(input: unknown): Writeback {
    const fields = writebackInputSchema.parse(input); const record = this.getRecord(fields.sourceRecordId);
    if (record.provider !== 'pingcode') throw new AppError(403, 'GitLab 保持只读，不允许回写');
    const existing = this.listWritebacks().find(item => item.requestId === fields.requestId);
    if (existing) {
      if (existing.sourceRecordId !== fields.sourceRecordId || existing.field !== fields.field || existing.value !== fields.value || existing.expectedValue !== (fields.expectedValue ?? null)) throw new AppError(409, '该提交标识已用于不同内容，请保留原预览');
      return existing;
    }
    const config = this.configuration('pingcode');
    if (!config.enabled || config.instanceId !== record.instanceId || !projects(config.projectScope).includes(record.projectId)) throw new AppError(409, '目标不属于当前启用的来源实例与项目范围');
    if (fields.field === 'state' && (!fields.expectedValue || fields.value.length > 300)) throw new AppError(400, '状态回写需明确来源原状态 ID 和目标状态 ID');
    const at = now(); const preview: Writeback = {
      ...fields, expectedValue: fields.expectedValue ?? null, id: randomUUID(), revision: randomUUID(), createdAt: at, updatedAt: at,
      provider: 'pingcode', instanceId: config.instanceId, baseUrl: config.baseUrl, configurationRevision: config.revision,
      projectId: record.projectId, externalId: record.externalId, targetTitle: record.title, targetNumber: record.number, targetUrl: record.url,
      outboundValue: fields.field === 'comment' ? `${fields.value}\n\n[个人工作台提交:${fields.requestId}]` : fields.value,
      status: 'preview', statusNote: fields.field === 'state' ? '状态并发保护未在实际实例验证；当前版本会阻止提交高风险字段覆盖' : '请确认目标与完整评论正文；提交后将读取来源核实', receiptId: null, submittedAt: null, verifiedAt: null
    };
    this.workbench.storage.put('writeback', preview); this.workbench.storage.event(preview.id, 'writeback.preview.created', { sourceRecordId: record.id, field: preview.field }); return preview;
  }
  private saveWriteback(previous: Writeback, patch: Partial<Writeback>): Writeback {
    const record = { ...previous, ...patch, revision: randomUUID(), updatedAt: now() };
    this.workbench.storage.database.transaction(() => {
      this.workbench.storage.put('writeback', record, previous.revision); this.workbench.storage.event(record.id, 'writeback.status', { status: record.status, receiptId: record.receiptId });
    })(); return record;
  }
  private writeConfiguration(item: Writeback, verify = false): Configuration {
    const config = this.configuration('pingcode');
    if (config.instanceId !== item.instanceId || config.baseUrl !== item.baseUrl) throw new AppError(409, '目标实例已变更；旧回写不得转投新地址，需在原实例人工核实');
    if (!verify && (!config.enabled || config.revision !== item.configurationRevision || !projects(config.projectScope).includes(item.projectId))) throw new AppError(409, '来源已停用、配置变化或目标超出当前范围；请重新预览');
    return config;
  }
  submitWriteback(id: string): Promise<Writeback> {
    if (this.closing) return Promise.reject(new AppError(503, '来源服务正在关闭，不再发起提交'));
    const running = this.submitting.get(id); if (running) return running;
    const operation = this.performSubmit(id).finally(() => this.submitting.delete(id)); this.submitting.set(id, operation); return operation;
  }
  private async performSubmit(id: string): Promise<Writeback> {
    let item = this.writeback(id); if (item.status !== 'preview') return item;
    let sent = false;
    try {
      const config = this.writeConfiguration(item); const connector = await this.connector(config);
      const identity = await connector.identity(); if (identity.id !== config.identity) throw new AppError(409, '认证身份与配置本人 ID 不一致，未发出回写');
      const remote = await connector.readObject(item.projectId, item.externalId, this.getRecord(item.sourceRecordId).number);
      this.ensureCurrent(config);
      if (item.field === 'state') {
        if (remote.stateId !== item.expectedValue) return this.saveWriteback(item, { status: 'conflict', statusNote: '来源状态已变化，未发出更新；请重新读取并预览' });
        return this.saveWriteback(item, { status: 'blocked', statusNote: '公开 API 未确认条件写入或原子并发保护；先读后写存在竞争窗口，状态更新尚未通过实例验收，已阻止覆盖' });
      }
      const existing = (await connector.comments(item.externalId)).find(comment => comment.content === item.outboundValue);
      if (existing) return this.saveWriteback(item, { status: 'confirmed', receiptId: existing.id, verifiedAt: now(), statusNote: '已在来源读取到该提交标识的完整评论，未重复发送' });
      this.ensureCurrent(config); this.writeConfiguration(item);
      item = this.saveWriteback(item, { status: 'submitting', submittedAt: now(), statusNote: '提交已发起，等待来源结果；重启不会自动重发' }); sent = true;
      const receipt = await connector.postComment(item.externalId, item.outboundValue);
      item = this.saveWriteback(item, { status: 'uncertain', receiptId: receipt.id, statusNote: '已取得提交回执，正在读取来源核实' });
      return await this.performVerify(item, connector);
    } catch (error) {
      return this.saveWriteback(item, { status: sent && (!(error instanceof SourceHttpError) || error.outcomeUnknown) ? 'uncertain' : sent ? 'failed' : 'blocked', statusNote: safeError(error) + (sent ? '；请先核实来源，禁止盲目重发' : '') });
    }
  }
  verifyWriteback(id: string): Promise<Writeback> {
    if (this.closing) return Promise.reject(new AppError(503, '来源服务正在关闭，不再发起核实'));
    const running = this.verifying.get(id); if (running) return running;
    const operation = this.verifyStoredWriteback(id).finally(() => this.verifying.delete(id)); this.verifying.set(id, operation); return operation;
  }
  private async verifyStoredWriteback(id: string): Promise<Writeback> {
    const running = this.submitting.get(id); if (running) await running;
    const item = this.writeback(id); if (item.status === 'confirmed' || !item.submittedAt) return item;
    try { const config = this.writeConfiguration(item, true); return await this.performVerify(item, await this.connector(config, false)); }
    catch (error) { return this.saveWriteback(item, { status: item.submittedAt ? 'uncertain' : item.status, statusNote: safeError(error) }); }
  }
  private async performVerify(item: Writeback, connector: SourceConnector): Promise<Writeback> {
    if (item.field === 'state') return item;
    const comments = await connector.comments(item.externalId); const matches = comments.filter(comment => comment.content === item.outboundValue && (!item.receiptId || comment.id === item.receiptId));
    if (matches.length !== 1) return this.saveWriteback(item, { status: 'uncertain', statusNote: '尚未唯一读取到本次完整评论；结果待核实，不自动重试' });
    return this.saveWriteback(item, { status: 'confirmed', receiptId: matches[0].id, verifiedAt: now(), statusNote: '已从来源重新读取并核实完整评论与提交标识' });
  }
  startScheduler(): void {
    if (this.closing || this.scheduler) return;
    for (const config of this.listSources()) this.nextSchedule.set(config.provider, Date.now() + config.intervalMinutes * 60000);
    this.scheduler = setInterval(() => {
      for (const config of this.listSources()) if (config.enabled && config.scheduleEnabled && Date.now() >= (this.nextSchedule.get(config.provider) ?? 0)) {
        this.nextSchedule.set(config.provider, Date.now() + config.intervalMinutes * 60000);
        void this.sync(config.provider).catch(() => { console.error('来源定时同步失败，请检查本机存储和来源配置'); });
      }
    }, 1000); this.scheduler.unref();
  }
  stopScheduler(): void { if (this.scheduler) clearInterval(this.scheduler); this.scheduler = undefined; }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.stopScheduler();
    this.closePromise = Promise.allSettled([...this.syncing.values(), ...this.submitting.values(), ...this.verifying.values()]).then(() => undefined);
    return this.closePromise;
  }
  private ensureOpen(): void { if (this.closing) throw new AppError(503, '来源服务正在关闭，已停止后续请求'); }
  isBusy(): boolean { return this.syncing.size > 0 || this.submitting.size > 0 || this.verifying.size > 0; }
}
function safeError(error: unknown): string { return error instanceof AppError ? error.message : '来源处理失败，已有记录已保留；请核实实例版本与授权配置'; }
export function registerSourceRoutes(app: FastifyInstance, workbench: Workbench, vault: SourceSecretVault): SourceService {
  const service = new SourceService(workbench, vault);
  app.get('/api/sources', async () => ({ items: service.listSources() }));
  app.put<{ Params: { provider: string } }>('/api/sources/:provider', async request => service.updateSource(providerSchema.parse(request.params.provider), request.body));
  app.post<{ Params: { provider: string } }>('/api/sources/:provider/test', async request => service.testSource(providerSchema.parse(request.params.provider), request.body));
  app.post<{ Params: { provider: string } }>('/api/sources/:provider/sync', async request => service.sync(providerSchema.parse(request.params.provider)));
  app.get('/api/source-records', async () => ({ items: service.listRecords() }));
  app.patch<{ Params: { id: string } }>('/api/source-records/:id/review', async request => service.review(request.params.id, request.body));
  app.post<{ Params: { id: string } }>('/api/source-records/:id/bind', async request => service.bind(request.params.id, request.body));
  app.put<{ Params: { id: string } }>('/api/source-records/:id/links', async request => service.link(request.params.id, request.body));
  app.get('/api/writebacks', async () => ({ items: service.listWritebacks() }));
  app.post('/api/writebacks', async request => service.createWriteback(request.body));
  app.post<{ Params: { id: string } }>('/api/writebacks/:id/submit', async request => service.submitWriteback(request.params.id));
  app.post<{ Params: { id: string } }>('/api/writebacks/:id/verify', async request => service.verifyWriteback(request.params.id));
  service.startScheduler(); app.addHook('onClose', async () => service.close()); return service;
}
