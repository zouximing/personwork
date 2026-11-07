import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workbench } from '../apps/server/src/workbench.js';
import { Management } from '../apps/server/src/management.js';
import { validateBackupSnapshot } from '../apps/server/src/backup-validation.js';
import type { Review } from '../packages/contracts/src/management.js';
import { SecretVault } from '../apps/server/src/secrets.js';
import { BackupService } from '../apps/server/src/backup.js';
import { protectWindowsDirectory } from '../apps/server/src/secrets.js';
import { execFileSync } from 'node:child_process';

describe('protected storage and restorable data', () => {
  let dir: string; let store: Workbench;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pwb-protect-')); store = new Workbench(dir); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  it('stores no plaintext credential and reads it after vault reopening', async () => {
    const vault = new SecretVault(dir); const value = 'synthetic-canary-not-a-real-token';
    await vault.set('canary', value);
    const reopened = new SecretVault(dir);
    expect(await reopened.get('canary')).toBe(value);
    for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) if (file.isFile()) expect(readFileSync(join(file.parentPath, file.name)).includes(Buffer.from(value))).toBe(false);
    await reopened.remove('canary'); expect(await reopened.get('canary')).toBeUndefined();
  });
  it('restores task links, exact prompt text and completion history without credentials', async () => {
    const parent = store.createTask({ title: '主事项' });
    const child = store.createTask({ title: '验证', parentId: parent.id });
    store.patchTask(child.id, { revision: child.revision, status: 'done' });
    store.savePrompt({ title: '模板', body: '首行\n  {{正文}}\n', tag: '' });
    const backup = new BackupService(store, new SecretVault(dir));
    const buffer = await backup.export('synthetic-long-backup-passphrase');
    expect(buffer.includes(Buffer.from('主事项'))).toBe(false);
    store.createTask({ title: '备份后新事项' });
    await backup.restore(buffer, 'synthetic-long-backup-passphrase');
    expect(store.listTasks()).toHaveLength(2);
    expect(store.listTasks().find(t => t.id === child.id)?.parentId).toBe(parent.id);
    expect(store.listPrompts()[0].body).toBe('首行\n  {{正文}}\n');
    expect(store.getHistory(child.id).some(event => event.kind === 'task.completed')).toBe(true);
    expect(store.listTasks().find(t => t.id === parent.id)?.revision).not.toBe(parent.revision);
  });
  it('leaves existing data untouched on wrong password and authenticated backup corruption', async () => {
    store.createTask({ title: '必须保留' });
    const backup = new BackupService(store, new SecretVault(dir));
    const buffer = await backup.export('synthetic-long-backup-passphrase');
    await expect(backup.restore(buffer, 'incorrect-password')).rejects.toThrow();
    const broken = Buffer.from(buffer); broken[broken.length - 1] ^= 1;
    await expect(backup.restore(broken, 'synthetic-long-backup-passphrase')).rejects.toThrow();
    expect(store.listTasks()[0].title).toBe('必须保留');
  });
  it('restores concise report text and frozen publications alongside legacy reviews', async () => {
    const task = store.createTask({ title: '合成备份事项', status: 'doing', nextAction: '测'.repeat(20000) });
    const management = new Management(store);
    const fields = { kind: 'month', start: '2026-11-01', end: '2026-11-30', selections: { taskIds: [task.id] } };
    const plan = store.createTask({ title: '备份中的下周计划', planDate: '2026-12-07' });
    const brief = management.createReview({ ...fields, title: '简报备份', includeNextWeekPlan: true, nextWeekTaskIds: [plan.id] });
    const edited = management.patchReview(brief.id, { revision: brief.revision, reportBody: '合成备份事项--进行中，等待联调' });
    const published = management.publishReview(brief.id, { revision: edited.revision });
    const legacyTask = store.createTask({ title: '旧版合成事项' });
    const legacy = management.createReview({ ...fields, title: '旧版备份', format: 'sections', selections: { taskIds: [legacyTask.id] } });
    const oldRecord = { ...store.storage.get<Record<string, unknown>>('review', legacy.id) };
    delete oldRecord.format; delete oldRecord.reportBody; delete oldRecord.includeNextWeekPlan; delete oldRecord.nextWeekTaskIds;
    store.storage.put('review', oldRecord as typeof legacy, legacy.revision);
    // Historical plan snapshots survive deletion of the original task.
    store.deleteTask(plan.id, { revision: plan.revision, confirm: true });
    const backup = new BackupService(store, new SecretVault(dir));
    const buffer = await backup.export('synthetic-review-backup-passphrase');
    await backup.restore(buffer, 'synthetic-review-backup-passphrase');
    const reviews = new Management(store).listReviews();
    expect(reviews.find(review => review.id === brief.id)).toMatchObject({ format: 'brief', includeNextWeekPlan: true, nextWeekTaskIds: [], reportBody: '合成备份事项--进行中，等待联调', versions: published.versions });
    expect(reviews.find(review => review.id === legacy.id)).toMatchObject({ includeNextWeekPlan: false, nextWeekTaskIds: [] });
    expect(reviews.find(review => review.id === legacy.id)?.markdown).toContain('## 成果');
  });
  it('rejects next-week plan references missing from the saved facts in drafts and publications', () => {
    const task = store.createTask({ title: '合法计划' });
    const unrelated = store.createTask({ title: '不在快照中的事项' });
    const management = new Management(store);
    const review = management.createReview({ title: '计划备份校验', kind: 'week', start: '2026-11-02', end: '2026-11-08', includeNextWeekPlan: true, nextWeekTaskIds: [task.id] });
    management.publishReview(review.id, { revision: review.revision });
    const backup = new BackupService(store, new SecretVault(dir));
    for (const target of ['draft', 'version']) {
      const snapshot = backup.snapshot();
      const record = snapshot.documents.find(document => document.kind === 'review')!.data as unknown as Review;
      if (target === 'draft') record.nextWeekTaskIds = [unrelated.id];
      else record.versions[0].nextWeekTaskIds = [unrelated.id];
      expect(() => validateBackupSnapshot(snapshot)).toThrow(/plan|reference/i);
    }
  });
  it('rolls back both task data and history when SQLite rejects a write', () => {
    const task = store.createTask({ title: '原数据' });
    const before = store.getHistory(task.id);
    store.storage.database.pragma('query_only = ON');
    expect(() => store.patchTask(task.id, { revision: task.revision, title: '不能保存' })).toThrow();
    expect(store.listTasks()[0].title).toBe('原数据');
    expect(store.getHistory(task.id)).toEqual(before);
    store.storage.database.pragma('query_only = OFF');
  });
  it.skipIf(process.platform !== 'win32')('sets an exact private Windows directory ACL and verifies the effective entries', () => {
    protectWindowsDirectory(dir);
    const script = `$d=[Console]::In.ReadToEnd(); $acl=[IO.Directory]::GetAccessControl($d); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($acl.Access); $safe=$acl.AreAccessRulesProtected -and $rules.Count -eq 2; foreach($rule in $rules) { $id=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; $safe=$safe -and ($id -eq $sid -or $id -eq 'S-1-5-18') -and $rule.AccessControlType -eq 'Allow' }; [Console]::Out.Write($safe)`;
    const checked = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: dir, windowsHide: true }).toString().trim();
    expect(checked).toBe('True');
  });
});
