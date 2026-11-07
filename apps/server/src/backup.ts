import { randomBytes, randomUUID } from 'node:crypto';
import { constants, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, rmSync, lstatSync, openSync, fstatSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDate, dateOnly, type Snapshot, type SourceRecord } from '@workbench/contracts';
import type { Workbench } from './workbench.js';
import type { SecretVault } from './secrets.js';
import { encrypt, decrypt, passwordKey } from './crypto.js';
import { AppError } from './errors.js';
import { extraKinds, validateBackupSnapshot, withoutBackupSecrets } from './backup-validation.js';

const maxBackupBytes = 30 * 1024 * 1024;
export type ProtectedSnapshotView = { name: string; savedAt: string; bytes: number };
export class BackupService {
  constructor(private readonly store: Workbench, private readonly vault: SecretVault) {}
  snapshot(): Snapshot {
    return this.store.storage.database.transaction(() => validateBackupSnapshot(withoutBackupSecrets({
      format: 1, createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai', tasks: this.store.listTasks(), prompts: this.store.listPrompts(),
      sources: this.store.storage.list<SourceRecord>('source'), events: this.store.storage.history(),
      documents: extraKinds.flatMap(kind => this.store.storage.list<Record<string, unknown>>(kind).map(data => ({ kind, data })))
    })))();
  }
  async export(password: string): Promise<Buffer> {
    if (password.length < 12 || password.length > 1024) throw new AppError(400, '备份口令需为 12—1024 个字符，请单独妥善保管');
    const content = Buffer.from(JSON.stringify(this.snapshot())); let key: Buffer | undefined;
    try {
      if (content.length + 48 > maxBackupBytes) throw new AppError(413, '完整备份超过当前 30 MiB 上限，未生成不可恢复的备份');
      const salt = randomBytes(16); key = await passwordKey(password, salt);
      return Buffer.concat([Buffer.from('PWB1'), salt, encrypt(content, key, 'pwb-backup/v1')]);
    }
    finally { key?.fill(0); content.fill(0); }
  }
  async restore(buffer: Buffer, password: string): Promise<void> {
    if (buffer.length > maxBackupBytes || buffer.length < 48 || buffer.subarray(0, 4).toString() !== 'PWB1' || password.length < 12 || password.length > 1024) throw new AppError(400, '备份格式、大小或口令无效');
    let snapshot: Snapshot;
    try {
      const key = await passwordKey(password, buffer.subarray(4, 20));
      let content: Buffer | undefined;
      try { content = decrypt(buffer.subarray(20), key, 'pwb-backup/v1'); snapshot = validateBackupSnapshot(JSON.parse(content.toString('utf8'))); }
      finally { key.fill(0); content?.fill(0); }
    } catch { throw new AppError(400, '备份口令不正确、内容损坏或版本不兼容；原数据未改变'); }
    this.restoreSnapshot(snapshot);
  }
  private restoreSnapshot(snapshot: Snapshot): void {
    this.saveProtectedSnapshot(`before-restore-${Date.now()}-${randomUUID()}`);
    const db = this.store.storage.database;
    db.transaction(() => {
      db.exec('DELETE FROM documents; DELETE FROM events;');
      for (const task of snapshot.tasks) this.store.storage.put('task', { ...task, revision: randomUUID() });
      for (const prompt of snapshot.prompts) this.store.storage.put('prompt', { ...prompt, revision: randomUUID() });
      for (const source of snapshot.sources) this.store.storage.put('source', { ...source, revision: randomUUID(), credentialRef: null, enabled: false, scheduleEnabled: false, connectionStatus: 'not_tested', writeStatus: 'not_verified' });
      for (const document of snapshot.documents) {
        const value: Record<string, unknown> & { id: string; revision: string } = { ...document.data, id: document.data.id, revision: randomUUID() };
        // Restored operations must never automatically resume external effects.
        if (document.kind === 'model') Object.assign(value, {
          credentialRef: null, enabled: false, isDefault: false, configurationRevision: randomUUID(),
          capabilities: { text: 'untested', tools: 'untested', testedAt: null, configurationRevision: null, message: '配置由备份恢复；需重新设置凭据、测试并启用', lastErrorKind: null }
        });
        if (document.kind === 'execution') Object.assign(value, { status: 'pending_verification', statusNote: '执行记录由备份恢复；保留步骤与产物，不恢复授权或自动执行' });
        if (document.kind === 'writeback') Object.assign(value, {
          status: value.submittedAt ? 'uncertain' : 'blocked',
          statusNote: value.submittedAt ? '已发出操作的记录由备份恢复；历史回执已保留，需在原实例核实，禁止自动重发' : '预览由备份恢复；原配置与授权已失效，请重新读取并建立预览'
        });
        this.store.storage.put(document.kind, value);
      }
      const insert = db.prepare('INSERT INTO events(id,resource_id,kind,at,details) VALUES(?,?,?,?,?)');
      for (const event of [...snapshot.events].reverse()) insert.run(event.id, event.resourceId, event.kind, event.at, JSON.stringify(event.details));
      this.store.storage.event(randomUUID(), 'backup.restored', { taskCount: snapshot.tasks.length, promptCount: snapshot.prompts.length, credentials: 'excluded' });
    })();
  }
  private snapshotDir(create = false): string {
    const dir = join(this.store.storage.dir, 'snapshots'); if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(dir)) { const stat = lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(400, '快照目录不是受保护的普通目录'); }
    return dir;
  }
  private validSnapshotName(name: string): boolean {
    if (/^\d{4}-\d{2}-\d{2}\.protected$/.test(name)) return dateOnly.safeParse(name.slice(0, 10)).success;
    return /^before-restore-\d{13}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.protected$/.test(name);
  }
  listSnapshots(): ProtectedSnapshotView[] {
    const dir = this.snapshotDir(); if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile() && this.validSnapshotName(entry.name)).flatMap(entry => {
      const stat = lstatSync(join(dir, entry.name)); return stat.isFile() && !stat.isSymbolicLink() ? [{ name: entry.name, savedAt: stat.mtime.toISOString(), bytes: stat.size }] : [];
    }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  private readProtected(name: string): Buffer {
    if (!this.validSnapshotName(name)) throw new AppError(400, '快照文件名无效');
    const path = join(this.snapshotDir(), name); const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBackupBytes) || before.size < 28n) throw new AppError(400, '快照不是允许的普通文件或大小无效');
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor, { bigint: true }); const after = lstatSync(path, { bigint: true });
      if (!opened.isFile() || after.isSymbolicLink() || opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== opened.ino || after.dev !== opened.dev || opened.size > BigInt(maxBackupBytes)) throw new AppError(400, '快照文件在读取期间发生变化');
      return this.vault.unprotect(readFileSync(descriptor), 'pwb-snapshot/v1');
    } finally { closeSync(descriptor); }
  }
  async restoreProtected(name: string): Promise<void> {
    let content: Buffer | undefined; let snapshot: Snapshot;
    try { content = this.readProtected(name); snapshot = validateBackupSnapshot(JSON.parse(content.toString('utf8'))); }
    catch { throw new AppError(400, '本机快照不可读、已损坏、含无效引用或当前账号无法解密；原数据未改变'); }
    finally { content?.fill(0); }
    this.restoreSnapshot(snapshot);
  }
  saveProtectedSnapshot(name: string): string {
    const fileName = `${name}.protected`; if (!this.validSnapshotName(fileName)) throw new AppError(400, '快照名称无效');
    const dir = this.snapshotDir(true); const path = join(dir, fileName);
    if (lstatSync(path, { throwIfNoEntry: false })) { const previous = this.readProtected(fileName); previous.fill(0); }
    const content = Buffer.from(JSON.stringify(this.snapshot())); const temp = `${path}.${randomUUID()}.tmp`;
    try {
      if (content.length + 28 > maxBackupBytes) throw new AppError(413, '完整快照超过当前 30 MiB 上限，原快照已保留');
      writeFileSync(temp, this.vault.protect(content, 'pwb-snapshot/v1'), { flag: 'wx', mode: 0o600 }); renameSync(temp, path);
    }
    finally { content.fill(0); rmSync(temp, { force: true }); }
    return path;
  }
  daily(): void {
    this.saveProtectedSnapshot(localDate());
    const daily = this.listSnapshots().filter(value => /^\d{4}-\d{2}-\d{2}\.protected$/.test(value.name)).sort((a, b) => b.name.localeCompare(a.name));
    for (const item of daily.slice(7)) {
      try { const content = this.readProtected(item.name); content.fill(0); rmSync(join(this.snapshotDir(), item.name)); } catch { /* Preserve unrecognized or damaged files for inspection. */ }
    }
  }
}
