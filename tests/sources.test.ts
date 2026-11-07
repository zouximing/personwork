import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management } from '../apps/server/src/management.js';
import { isPrivateMaterial } from '../apps/server/src/material-privacy.js';

// Synthetic data and a real loopback HTTP server; never contacts company systems.
describe('source settings and actual HTTP synchronization boundaries', () => {
  let dir: string;
  let workbench: Workbench;
  let server: Server;
  let address: string;
  let broken = false;
  let sha = 'aaaa';
  let comments: { id: string; content: string }[];
  let posts = 0;
  let loseResponse = false;
  let onRequest: ((path: string) => Promise<void>) | undefined;
  let truncated = false;
  let assigned = true;
  let mrAssignee = false;
  let includeIssues = false;
  let issueAssigned = true;
  let issueState = 'opened';
  let issueFailure = false;
  let authenticatedIdentity = '7';
  let pingProject = 'p1';
  const seen: { method: string; path: string; auth?: string }[] = [];
  const secrets = new Map<string, string>();
  const services: { stopScheduler(): void }[] = [];
  const vault = { async set(ref: string, value: string) { secrets.set(ref, value); }, async get(ref: string) { return secrets.get(ref); }, async remove(ref: string) { secrets.delete(ref); } };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pwb-source-')); workbench = new Workbench(dir);
    broken = false; sha = 'aaaa'; comments = []; posts = 0; loseResponse = false; onRequest = undefined; truncated = false; assigned = true; mrAssignee = false; includeIssues = false; issueAssigned = true; issueState = 'opened'; issueFailure = false; authenticatedIdentity = '7'; pingProject = 'p1'; seen.length = 0; secrets.clear();
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost'); seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization ?? req.headers['private-token'] as string | undefined });
      await onRequest?.(req.url!);
      res.setHeader('content-type', 'application/json');
      if (broken) { res.statusCode = 403; res.end('{"error":"forbidden"}'); return; }
      if (url.pathname === '/api/v4/user' || url.pathname === '/v2/myself') { res.end(JSON.stringify({ id: authenticatedIdentity, name: 'Synthetic reviewer' })); return; }
      if (url.pathname.match(/^\/api\/v4\/projects\/[^/]+\/merge_requests/)) {
        const project = url.pathname.split('/')[4];
        const mr = { id: Number(project) * 10 + 1, iid: 1, project_id: Number(project), title: 'Synthetic MR', state: 'merged', web_url: address + '/mr/1', sha, updated_at: new Date().toISOString(), author: { id: 7, name: 'Synthetic author' }, reviewers: assigned ? [{ id: 7 }] : [], assignees: mrAssignee ? [{ id: 8 }, { id: 7 }] : [] };
        if (url.pathname.endsWith('/1')) { res.end(JSON.stringify(mr)); return; }
        const page = Number(url.searchParams.get('page') ?? 1); res.setHeader('x-next-page', page === 1 ? '2' : ''); if (truncated) res.setHeader('x-total', '2');
        const matches = (url.searchParams.has('assignee_id') ? mrAssignee : assigned) && ['all', mr.state].includes(url.searchParams.get('state') ?? 'all');
        res.end(JSON.stringify(page === 1 && matches ? [mr] : [])); return;
      }
      if (url.pathname.match(/^\/api\/v4\/projects\/[^/]+\/issues/)) {
        if (issueFailure) { res.statusCode = 403; res.end('{}'); return; }
        const project = url.pathname.split('/')[4];
        // Issue and MR deliberately share both internal ID and iid: their identity includes object type.
        const issue = { id: Number(project) * 10 + 1, iid: 1, project_id: Number(project), title: 'Synthetic issue', state: issueState, web_url: address + '/issues/1', author: { id: 9, name: 'Synthetic author' }, assignees: issueAssigned ? [{ id: 8 }, { id: 7 }] : [], due_date: '2026-12-01', updated_at: '2020-01-01T00:00:00Z' };
        if (url.pathname.endsWith('/1')) { res.end(JSON.stringify(issue)); return; }
        const page = Number(url.searchParams.get('page') ?? 1);
        res.setHeader('x-next-page', page === 1 ? '2' : '');
        const matches = ['all', issue.state].includes(url.searchParams.get('state') ?? 'all') && (!url.searchParams.has('updated_after') || issue.updated_at >= url.searchParams.get('updated_after')!);
        res.end(JSON.stringify(includeIssues && issueAssigned && matches && page === 1 ? [issue] : [])); return;
      }
      if (url.pathname === '/v2/pjm/workitems' || url.pathname === '/v2/pjm/workitems/work-1') {
        const item = { id: 'work-1', identifier: 1, whole_identifier: 'TEST-1', project: { id: pingProject, name: 'Synthetic' }, title: 'Synthetic work', state: { id: 's1', name: '自定义处理中' }, html_url: address + '/work-1', due: { date: 1794096000, with_time: 0 }, assignee: { id: '7' } };
        if (url.pathname.endsWith('/work-1')) { res.end(JSON.stringify(item)); return; }
        const index = Number(url.searchParams.get('page_index')); res.end(JSON.stringify({ page_index: index, page_size: 1, total: 1, values: index === 0 ? [item] : [] })); return;
      }
      if (url.pathname === '/v2/comments') {
        if (req.method === 'POST') {
          let raw = ''; for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw); if (body.principal_type !== 'workitem' || body.principal_id !== 'work-1') { res.statusCode = 400; res.end('{}'); return; }
          posts++; const comment = { id: String(posts), content: body.content }; comments.push(comment);
          if (loseResponse) { req.socket.destroy(); return; }
          res.end(JSON.stringify(comment)); return;
        }
        res.end(JSON.stringify({ page_index: 0, page_size: 100, total: comments.length, values: comments })); return;
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const info = server.address(); address = `http://127.0.0.1:${typeof info === 'object' && info ? info.port : 0}`;
  });
  afterEach(async () => { services.splice(0).forEach(item => item.stopScheduler()); await new Promise<void>(resolve => server.close(() => resolve())); workbench.close(); rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  async function service() {
    const module = await import('../apps/server/src/source-settings.js').catch(() => null);
    expect(module, 'source synchronization service must exist').not.toBeNull();
    const result = new module!.SourceService(workbench, vault, { requestTimeoutMs: 500 }); services.push(result); return result;
  }
  function settings(previous: { revision: string }, provider = 'gitlab') {
    return { revision: previous.revision, name: provider, baseUrl: address, projectScope: provider === 'gitlab' ? '1,2' : 'p1', identity: '7', historyDays: 90, enabled: true, intervalMinutes: 5, scheduleEnabled: false, credentialAction: 'replace' as const, credential: 'synthetic-test-token' };
  }

  it('reimports a deleted local source task without losing retained privacy restrictions', async () => {
    const source = await service();
    await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    await source.sync('gitlab');
    const record = source.listRecords()[0];
    const task = workbench.listTasks().find(item => item.id === record.localTaskId)!;
    const privateTask = workbench.patchTask(task.id, { revision: task.revision, type: 'people' });
    workbench.deleteTask(task.id, { revision: privateTask.revision, confirm: true });
    expect(source.listRecords().find(item => item.id === record.id)).toMatchObject({ localTaskId: null, privacyRestricted: true });
    await source.sync('gitlab');
    const rebound = source.listRecords().find(item => item.id === record.id)!;
    expect(rebound.localTaskId).not.toBe(task.id);
    expect(isPrivateMaterial(workbench.storage, 'task', rebound.localTaskId!)).toBe(true);
    expect(isPrivateMaterial(workbench.storage, 'source-record', rebound.id)).toBe(true);
    const firstTarget = workbench.createTask({ title: '第一次绑定保留的合成任务' });
    const secondTarget = workbench.createTask({ title: '第二次绑定的合成任务' });
    const firstBinding = source.bind(rebound.id, { revision: rebound.revision, taskId: firstTarget.id });
    source.bind(rebound.id, { revision: firstBinding.revision, taskId: secondTarget.id });
    expect(isPrivateMaterial(workbench.storage, 'task', firstTarget.id)).toBe(true);
    expect(isPrivateMaterial(workbench.storage, 'task', rebound.localTaskId!)).toBe(true);
  });
  it('retains inherited privacy when directly rebinding a source away from a personnel task', async () => {
    const source = await service();
    await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    await source.sync('gitlab');
    const record = source.listRecords()[0];
    const task = workbench.listTasks().find(item => item.id === record.localTaskId)!;
    workbench.patchTask(task.id, { revision: task.revision, type: 'people' });
    expect(isPrivateMaterial(workbench.storage, 'source-record', record.id)).toBe(true);
    const target = workbench.createTask({ title: '普通合成绑定任务' });
    source.bind(record.id, { revision: record.revision, taskId: target.id });
    expect(isPrivateMaterial(workbench.storage, 'source-record', record.id)).toBe(true);
    expect(isPrivateMaterial(workbench.storage, 'task', target.id)).toBe(true);
  });
  it('keeps unsaved tests separate and never forwards a retained token to a changed address', async () => {
    const source = await service(); const original = source.listSources().find(item => item.provider === 'gitlab')!;
    const saved = await source.updateSource('gitlab', settings(original));
    const tested = await source.testSource('gitlab', { ...settings(saved), credentialAction: 'keep' });
    expect(tested.status).toBe('read_ok'); expect(tested.writeStatus).toBe('not_verified');
    expect(source.listSources().find(item => item.provider === 'gitlab')!.connectionStatus).toBe('not_tested');
    const changed = await source.updateSource('gitlab', { ...settings(saved), baseUrl: address + '/different-instance', credentialAction: 'keep', credential: undefined });
    expect(changed.instanceId).not.toBe(saved.instanceId); expect(changed.hasCredential).toBe(false);
    expect(JSON.stringify(source.listSources())).not.toContain('synthetic-test-token');
    expect(seen.every(item => item.method === 'GET')).toBe(true);
  });

  it('paginates MR reads by reviewer, isolates project identities, preserves checked SHA and local plans on failure', async () => {
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    const result = await source.sync('gitlab'); expect(result.status).toBe('success');
    expect(source.listRecords()).toHaveLength(2);
    const first = source.listRecords()[0]; expect(first.reviewStatus).toBe('not_started');
    source.review(first.id, { revision: first.revision, reviewStatus: 'waiting_author', checkedSha: 'aaaa', conclusion: 'Synthetic conclusion', followUpDate: '2026-11-10' });
    const task = workbench.listTasks().find(item => item.id === first.localTaskId)!; workbench.patchTask(task.id, { revision: task.revision, planDate: '2026-11-09', notes: 'Private synthetic plan' });
    sha = 'bbbb'; await source.sync('gitlab');
    const refreshed = source.listRecords().find(item => item.id === first.id)!;
    expect(refreshed).toMatchObject({ currentSha: 'bbbb', checkedSha: 'aaaa', reviewStatus: 'waiting_author', needsReview: true, conclusion: 'Synthetic conclusion' });
    expect(workbench.listTasks().find(item => item.id === task.id)).toMatchObject({ planDate: '2026-11-09', notes: 'Private synthetic plan' });
    broken = true; expect((await source.sync('gitlab')).status).toBe('failed'); expect(source.listRecords()).toHaveLength(2);
    expect(source.listSources().find(item => item.provider === 'gitlab')!.lastSuccessAt).toBeTruthy();
    expect(seen.some(item => item.path.includes('reviewer_id=7'))).toBe(true); expect(seen.some(item => item.path.includes('page=2'))).toBe(true);
  });

  it('imports assignee-only MRs into tasks even when I am not a reviewer', async () => {
    assigned = false; mrAssignee = true;
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    expect((await source.sync('gitlab')).status).toBe('success');
    expect(workbench.listTasks()).toHaveLength(2);
    expect(source.listRecords()[0]).toMatchObject({ objectType: 'merge_request', assignedAsAssignee: true, assignedAsReviewer: false, assignedToMe: true });
    expect(seen.every(item => item.method === 'GET')).toBe(true);
  });

  it('deduplicates assignee and reviewer MRs while keeping an issue with the same IDs as a separate task', async () => {
    mrAssignee = true; includeIssues = true;
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    expect((await source.sync('gitlab')).status).toBe('success');
    expect(source.listRecords()).toHaveLength(4); expect(workbench.listTasks()).toHaveLength(4);
    const mr = source.listRecords().find(item => item.title === 'Synthetic MR')!;
    const issue = source.listRecords().find(item => item.projectId === mr.projectId && item.title === 'Synthetic issue')!;
    expect(mr).toMatchObject({ objectType: 'merge_request', assignedAsAssignee: true, assignedAsReviewer: true });
    expect(issue).toMatchObject({ objectType: 'issue', currentSha: null, needsReview: false, assignedAsAssignee: true, assignedAsReviewer: false, sourceDueDate: '2026-12-01' });
    expect(issue.externalId).toBe(mr.externalId); expect(issue.number).toBe(mr.number); expect(issue.localTaskId).not.toBe(mr.localTaskId);
    await source.sync('gitlab');
    expect(workbench.listTasks()).toHaveLength(4);
    expect(source.listRecords().find(item => item.id === issue.id)!.localTaskId).toBe(issue.localTaskId);
    expect(seen.some(item => item.path.includes('/issues?') && item.path.includes('assignee_id=7') && !item.path.includes('updated_after='))).toBe(true);
  });

  it('refreshes issue closures and assignment removal without completing or replacing local plans', async () => {
    includeIssues = true;
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    await source.sync('gitlab');
    const issue = source.listRecords().find(item => item.title === 'Synthetic issue')!;
    expect(issue).toBeDefined();
    const task = workbench.listTasks().find(item => item.id === issue.localTaskId)!;
    workbench.patchTask(task.id, { revision: task.revision, planDate: '2026-11-09', notes: 'Synthetic personal plan', status: 'doing' });
    issueAssigned = false; issueState = 'closed';
    expect((await source.sync('gitlab')).status).toBe('success');
    expect(source.getRecord(issue.id)).toMatchObject({ sourceState: 'closed', assignedToMe: false, reviewAssignmentChanged: true, needsReview: false });
    expect(source.getRecord(issue.id).attentionReason).not.toContain('MR');
    expect(workbench.listTasks().find(item => item.id === task.id)).toMatchObject({ status: 'doing', notes: 'Synthetic personal plan', planDate: '2026-11-09', sourceState: 'closed' });
    const current = source.getRecord(issue.id);
    expect(() => source.review(issue.id, { revision: current.revision, reviewStatus: 'reviewed', checkedSha: 'aaaa', conclusion: '', followUpDate: null })).toThrow('只有 GitLab MR');
  });

  it('reports removal of one MR role while keeping the other role and the original task', async () => {
    mrAssignee = true;
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    await source.sync('gitlab');
    const mr = source.listRecords()[0]; mrAssignee = false;
    await source.sync('gitlab');
    expect(source.getRecord(mr.id)).toMatchObject({ assignedAsAssignee: false, assignedAsReviewer: true, assignedToMe: true, reviewAssignmentChanged: true, localTaskId: mr.localTaskId });
    expect(workbench.listTasks()).toHaveLength(2);
  });

  it('keeps existing source snapshots and tasks intact when issue reads fail', async () => {
    includeIssues = true;
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    await source.sync('gitlab'); const records = source.listRecords(); const tasks = workbench.listTasks();
    expect(records).toHaveLength(4);
    issueFailure = true; sha = 'bbbb';
    expect((await source.sync('gitlab')).status).toBe('failed');
    expect(source.listRecords()).toEqual(records); expect(workbench.listTasks()).toEqual(tasks);
  });

  it('upgrades legacy MR snapshots in place without resetting their review or personal action', async () => {
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    await source.sync('gitlab'); const mr = source.listRecords()[0];
    source.review(mr.id, { revision: mr.revision, reviewStatus: 'reviewed', checkedSha: 'aaaa', conclusion: 'Synthetic old review', followUpDate: null });
    const legacy = { ...source.getRecord(mr.id) } as Record<string, unknown>;
    delete legacy.objectType; delete legacy.assignedAsAssignee; delete legacy.assignedAsReviewer;
    workbench.storage.put('source-record', legacy as typeof mr, legacy.revision as string);
    sha = 'bbbb'; mrAssignee = true; includeIssues = true;
    await source.sync('gitlab');
    expect(source.getRecord(mr.id)).toMatchObject({ objectType: 'merge_request', localTaskId: mr.localTaskId, checkedSha: 'aaaa', conclusion: 'Synthetic old review', needsReview: true });
    expect(source.listRecords()).toHaveLength(4); expect(workbench.listTasks()).toHaveLength(4);
  });

  it('deduplicates PingCode imports and verifies a lost comment response before allowing any repeat write', async () => {
    const source = await service(); await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode'));
    await source.sync('pingcode'); await source.sync('pingcode'); expect(source.listRecords()).toHaveLength(1); expect(workbench.listTasks()).toHaveLength(1);
    const record = source.listRecords()[0]; expect(record.sourceState).toBe('自定义处理中');
    const input = { sourceRecordId: record.id, field: 'comment', value: 'Synthetic selected progress', requestId: '10000000-0000-4000-8000-000000000001' };
    const preview = source.createWriteback(input); expect(source.createWriteback(input).id).toBe(preview.id);
    loseResponse = true; const pending = await source.submitWriteback(preview.id); expect(pending.status).toBe('uncertain'); expect(posts).toBe(1);
    expect((await source.submitWriteback(preview.id)).status).toBe('uncertain'); expect(posts).toBe(1);
    expect((await source.verifyWriteback(preview.id)).status).toBe('confirmed'); expect(posts).toBe(1);
    expect(comments[0].content).toContain('Synthetic selected progress'); expect(comments[0].content).not.toContain('Private synthetic plan');
  });

  it('blocks old-target previews after instance changes and refuses unverified concurrent state overwrite', async () => {
    const source = await service(); const saved = await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode'));
    await source.sync('pingcode'); const record = source.listRecords()[0];
    const state = source.createWriteback({ sourceRecordId: record.id, field: 'state', value: 's2', expectedValue: 's1', requestId: '10000000-0000-4000-8000-000000000002' });
    expect((await source.submitWriteback(state.id)).status).toBe('blocked'); expect(posts).toBe(0);
    const comment = source.createWriteback({ sourceRecordId: record.id, field: 'comment', value: 'Synthetic', requestId: '10000000-0000-4000-8000-000000000003' });
    await source.updateSource('pingcode', { ...settings(saved, 'pingcode'), baseUrl: address + '/new', credentialAction: 'keep', credential: undefined });
    expect((await source.submitWriteback(comment.id)).status).toBe('blocked'); expect(posts).toBe(0); expect(source.listRecords()).toHaveLength(1);
  });

  it('reads documented PingCode due.date timestamps and applies the configured history window', async () => {
    const source = await service(); await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode'));
    await source.sync('pingcode'); expect(source.listRecords()[0]?.sourceDueDate).toBe('2026-11-08');
    const request = seen.find(item => item.path.startsWith('/v2/pjm/workitems?'))!;
    expect(new URL(request.path, address).searchParams.get('updated_between')).toMatch(/^\d+,\d+$/);
  });

  it('stops new pagination requests when a source is disabled during an in-flight read', async () => {
    const source = await service(); const saved = await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    onRequest = async path => { if (path.includes('merge_requests') && path.includes('page=1')) { onRequest = undefined; await source.updateSource('gitlab', { ...settings(saved), credential: undefined, credentialAction: 'keep', enabled: false }); } };
    expect((await source.sync('gitlab')).status).toBe('failed');
    expect(seen.filter(item => item.path.includes('merge_requests'))).toHaveLength(1);
    expect(source.listRecords()).toHaveLength(0);
  });

  it('binds an existing personal task, archives only the untouched import shell and keeps cross-source links independent', async () => {
    const source = await service();
    await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode'));
    await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    await source.sync('pingcode'); await source.sync('gitlab');
    const ping = source.listRecords().find(item => item.provider === 'pingcode')!; const mr = source.listRecords().find(item => item.provider === 'gitlab')!;
    const personal = workbench.createTask({ title: 'Existing synthetic task', notes: 'Keep this note', planDate: '2026-11-09' });
    const bound = source.bind(ping.id, { revision: ping.revision, taskId: personal.id });
    expect(bound.localTaskId).toBe(personal.id);
    expect(workbench.listTasks().find(item => item.id === personal.id)).toMatchObject({ title: 'Existing synthetic task', notes: 'Keep this note', planDate: '2026-11-09' });
    expect(workbench.listTasks().find(item => item.id === ping.localTaskId)?.archived).toBe(true);
    const linked = source.link(bound.id, { revision: bound.revision, sourceRecordIds: [mr.id] });
    expect(linked.linkedSourceIds).toEqual([mr.id]); expect(source.getRecord(mr.id).linkedSourceIds).toEqual([ping.id]);
    expect(source.listRecords()).toHaveLength(3);
    expect(() => source.bind(mr.id, { revision: source.getRecord(mr.id).revision, taskId: personal.id })).toThrow(/绑定/);
    await source.sync('pingcode'); expect(source.getRecord(ping.id).linkedSourceIds).toEqual([mr.id]);
    source.link(ping.id, { revision: source.getRecord(ping.id).revision, sourceRecordIds: [] }); expect(source.getRecord(mr.id).linkedSourceIds).toEqual([]);
  });

  it('preserves an imported task that acquired personal plans when rebinding the source', async () => {
    const source = await service(); await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode')); await source.sync('pingcode');
    const ping = source.listRecords()[0]; const imported = workbench.listTasks().find(item => item.id === ping.localTaskId)!;
    workbench.patchTask(imported.id, { revision: imported.revision, notes: 'A real independent synthetic action' });
    const existing = workbench.createTask({ title: 'Bind target' }); source.bind(ping.id, { revision: ping.revision, taskId: existing.id });
    expect(workbench.listTasks().find(item => item.id === imported.id)).toMatchObject({ archived: false, notes: 'A real independent synthetic action' });
  });

  it('rejects incomplete pagination without erasing cached records or advancing the last success time', async () => {
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!)); await source.sync('gitlab');
    const before = source.listSources().find(item => item.provider === 'gitlab')!.lastSuccessAt; const records = source.listRecords();
    truncated = true; const result = await source.sync('gitlab'); expect(result.status).toBe('failed');
    expect(source.listRecords()).toEqual(records); expect(source.listSources().find(item => item.provider === 'gitlab')!.lastSuccessAt).toBe(before);
  });

  it('detects removed reviewer assignments without substituting the author and preserves local review work', async () => {
    const source = await service(); await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!)); await source.sync('gitlab');
    const first = source.listRecords()[0]; source.review(first.id, { revision: first.revision, reviewStatus: 'reviewing', checkedSha: 'aaaa', conclusion: 'A synthetic note', followUpDate: null });
    assigned = false; await source.sync('gitlab');
    expect(source.getRecord(first.id)).toMatchObject({ assignedToMe: false, reviewAssignmentChanged: true, reviewStatus: 'reviewing', checkedSha: 'aaaa' });
    expect(source.listRecords()).toHaveLength(2);
  });

  it('survives restart with uncertain writes, refuses request-ID payload changes and clears credentials explicitly', async () => {
    const source = await service(); const config = await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode')); await source.sync('pingcode');
    const record = source.listRecords()[0]; const input = { sourceRecordId: record.id, field: 'comment', value: 'Synthetic persisted comment', requestId: '10000000-0000-4000-8000-000000000004' };
    const preview = source.createWriteback(input); loseResponse = true; await source.submitWriteback(preview.id);
    const reopened = await service(); expect(reopened.listRecords()[0].id).toBe(record.id);
    expect((await reopened.submitWriteback(preview.id)).status).toBe('uncertain'); expect(posts).toBe(1);
    expect(() => reopened.createWriteback({ ...input, value: 'Different' })).toThrow(/提交标识/);
    const cleared = await reopened.updateSource('pingcode', { ...settings(config, 'pingcode'), credentialAction: 'clear', credential: undefined }); expect(cleared.hasCredential).toBe(false);
    expect((await reopened.sync('pingcode')).status).toBe('failed'); expect(posts).toBe(1); expect(reopened.listRecords()).toHaveLength(1);
  });

  it('authenticates the configured identity before submitting a comment', async () => {
    const source = await service(); await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode')); await source.sync('pingcode');
    const preview = source.createWriteback({ sourceRecordId: source.listRecords()[0].id, field: 'comment', value: 'Synthetic', requestId: '10000000-0000-4000-8000-000000000005' });
    authenticatedIdentity = '9'; expect((await source.submitWriteback(preview.id)).status).toBe('blocked'); expect(posts).toBe(0);
  });

  it('preserves the stable PingCode work-item identity when the same item changes project', async () => {
    const source = await service(); const config = await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode')); await source.sync('pingcode');
    const before = source.listRecords()[0]; pingProject = 'p2'; await source.updateSource('pingcode', { ...settings(config, 'pingcode'), projectScope: 'p2', credentialAction: 'keep', credential: undefined });
    await source.sync('pingcode'); expect(source.listRecords()).toHaveLength(1); expect(source.listRecords()[0]).toMatchObject({ id: before.id, projectId: 'p2', localTaskId: before.localTaskId });
    expect(workbench.listTasks()).toHaveLength(1);
  });

  it('reports active outcome verification as busy so a restore cannot interleave with its database update', async () => {
    const source = await service(); await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode')); await source.sync('pingcode');
    const preview = source.createWriteback({ sourceRecordId: source.listRecords()[0].id, field: 'comment', value: 'Synthetic', requestId: '10000000-0000-4000-8000-000000000006' }); loseResponse = true; await source.submitWriteback(preview.id);
    const operation = source.verifyWriteback(preview.id); const busyDuringVerification = source.isBusy(); await operation;
    expect(busyDuringVerification).toBe(true); expect(source.isBusy()).toBe(false);
  });

  it('schedules only enabled configured pulls and stops further scheduled requests after pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    const source = await service(); let config = await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!)); source.startScheduler();
    vi.setSystemTime(new Date('2026-11-07T00:06:00Z')); await new Promise(resolve => setTimeout(resolve, 1100)); expect(seen).toHaveLength(0);
    config = await source.updateSource('gitlab', { ...settings(config), credentialAction: 'keep', credential: undefined, scheduleEnabled: true });
    vi.setSystemTime(new Date('2026-11-07T00:12:00Z')); await new Promise(resolve => setTimeout(resolve, 1100)); expect(source.listRecords()).toHaveLength(2);
    await source.updateSource('gitlab', { ...settings(config), credentialAction: 'keep', credential: undefined, scheduleEnabled: false });
    const count = seen.length; vi.setSystemTime(new Date('2026-11-07T00:18:00Z')); await new Promise(resolve => setTimeout(resolve, 1100)); expect(seen).toHaveLength(count);
  });

  it('recreates disabled source defaults when restoring an older snapshot that contained no source settings', async () => {
    const source = await service(); workbench.storage.database.exec("DELETE FROM documents WHERE kind = 'source'");
    expect(source.listSources()).toHaveLength(2); expect(source.listSources().every(item => !item.enabled && !item.hasCredential)).toBe(true);
  });

  it('keeps an import task active when a personal monthly plan references it without editing the task itself', async () => {
    const source = await service(); await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode')); await source.sync('pingcode');
    const record = source.listRecords()[0]; const manager = new Management(workbench); const line = manager.createLine({ name: 'Synthetic line' });
    manager.createPeriod({ title: 'Synthetic linked plan', kind: 'month', start: '2026-11-01', end: '2026-11-30', lineId: line.id, taskIds: [record.localTaskId!] });
    const target = workbench.createTask({ title: 'Explicit synthetic binding target' }); source.bind(record.id, { revision: record.revision, taskId: target.id });
    expect(workbench.listTasks().find(item => item.id === record.localTaskId)?.archived).toBe(false);
  });

  it('waits for a delayed sync to settle before close and starts no further pagination while closing', async () => {
    const source = await service(); expect(typeof source.close).toBe('function');
    await source.updateSource('gitlab', settings(source.listSources().find(item => item.provider === 'gitlab')!));
    let release!: () => void; let started!: () => void; const arrived = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    onRequest = async path => { if (path.includes('merge_requests')) { started(); await gate; } };
    const sync = source.sync('gitlab'); await arrived;
    let closed = false; const close = source.close().then(() => { closed = true; }); await new Promise<void>(resolve => setImmediate(resolve)); const closedBeforeResponse = closed;
    release(); await close; await sync;
    expect(closedBeforeResponse).toBe(false); expect(source.isBusy()).toBe(false); expect(seen.filter(item => item.path.includes('merge_requests'))).toHaveLength(1);
    workbench.close(); await source.close(); source.startScheduler();
    expect((await source.sync('gitlab')).status).toBe('skipped');
    await expect(source.submitWriteback('closed-service')).rejects.toThrow(/关闭/);
    await expect(source.verifyWriteback('closed-service')).rejects.toThrow(/关闭/);
  });

  it('retains an issued comment receipt when shutdown begins before the delayed POST response arrives', async () => {
    const source = await service(); expect(typeof source.close).toBe('function'); await source.updateSource('pingcode', settings(source.listSources().find(item => item.provider === 'pingcode')!, 'pingcode')); await source.sync('pingcode');
    const preview = source.createWriteback({ sourceRecordId: source.listRecords()[0].id, field: 'comment', value: 'Synthetic delayed shutdown write', requestId: '10000000-0000-4000-8000-000000000007' });
    let release!: () => void; let started!: () => void; const arrived = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    onRequest = async path => { if (path === '/v2/comments' && seen.at(-1)?.method === 'POST') { started(); await gate; } };
    const submitting = source.submitWriteback(preview.id); await arrived; const close = source.close(); release(); const result = await submitting; await close;
    expect(posts).toBe(1); expect(result).toMatchObject({ status: 'uncertain', receiptId: '1' }); expect(source.listWritebacks()[0].receiptId).toBe('1');
  });
});
