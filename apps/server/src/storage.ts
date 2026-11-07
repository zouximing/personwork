import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecordEvent } from '@workbench/contracts';
import { AppError } from './errors.js';
export type DocumentKind = 'task' | 'prompt' | 'source' | 'source-record' | 'writeback' | 'line' | 'period' | 'risk' | 'review' | 'recurrence' | 'milestone' | 'model' | 'execution' | 'dashboard-settings';
type Stored = { id: string; revision: string };
export class Storage {
  readonly database: Database.Database;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.database = new Database(join(dir, 'workbench.db'));
    this.database.pragma('journal_mode = WAL'); this.database.pragma('synchronous = FULL');
    this.database.pragma('foreign_keys = ON'); this.database.pragma('busy_timeout = 1000');
    const version = this.database.pragma('user_version', { simple: true }) as number;
    if (version > 1) { this.database.close(); throw new Error('数据库版本高于当前程序，已停止打开'); }
    this.database.transaction(() => {
      this.database.exec(`CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, details TEXT NOT NULL CHECK(json_valid(details)));
        CREATE INDEX IF NOT EXISTS events_resource ON events(resource_id, at);
        PRAGMA user_version = 1;`);
    })();
  }
  list<T>(kind: DocumentKind): T[] {
    return (this.database.prepare('SELECT data FROM documents WHERE kind = ?').all(kind) as { data: string }[]).map(row => JSON.parse(row.data) as T);
  }
  get<T>(kind: DocumentKind, id: string): T | undefined {
    const row = this.database.prepare('SELECT data FROM documents WHERE kind = ? AND id = ?').get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  put<T extends Stored>(kind: DocumentKind, value: T, previousRevision?: string): void {
    if (previousRevision) {
      const result = this.database.prepare('UPDATE documents SET revision = ?, data = ? WHERE kind = ? AND id = ? AND revision = ?').run(value.revision, JSON.stringify(value), kind, value.id, previousRevision);
      if (result.changes !== 1) throw new AppError(409, '记录已被更新，请保留当前输入并重新读取最新版本');
    } else this.database.prepare('INSERT INTO documents(kind,id,revision,data) VALUES(?,?,?,?)').run(kind, value.id, value.revision, JSON.stringify(value));
  }
  removeTask(id: string): void {
    this.database.prepare('DELETE FROM documents WHERE kind = ? AND id = ?').run('task', id);
    // No tombstone or deletion event: permanent deletion also removes operation references.
    this.database.prepare('DELETE FROM events WHERE resource_id = ? OR instr(details, ?) > 0').run(id, id);
  }
  delete(kind: DocumentKind, id: string, revision: string): void {
    const result = this.database.prepare('DELETE FROM documents WHERE kind = ? AND id = ? AND revision = ?').run(kind, id, revision);
    if (result.changes !== 1) throw new AppError(409, '记录已被更新，请保留当前输入并重新读取最新版本');
  }
  event(resourceId: string, kind: string, details: Record<string, unknown>): void {
    this.database.prepare('INSERT INTO events(id,resource_id,kind,at,details) VALUES(?,?,?,?,?)').run(randomUUID(), resourceId, kind, new Date().toISOString(), JSON.stringify(details));
  }
  history(resourceId?: string): RecordEvent[] {
    const sql = `SELECT id, resource_id AS resourceId, kind, at, details FROM events ${resourceId ? 'WHERE resource_id = ?' : ''} ORDER BY at DESC, rowid DESC`;
    const rows = (resourceId ? this.database.prepare(sql).all(resourceId) : this.database.prepare(sql).all()) as (Omit<RecordEvent, 'details'> & { details: string })[];
    return rows.map(row => ({ ...row, details: JSON.parse(row.details) }));
  }
  close(): void { if (this.database.open) this.database.close(); }
}
