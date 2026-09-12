import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import url from 'node:url';
import { storedPermissionMode } from '../../permission-mode.js';
import type { HostEvent } from '../run-events.js';
import { createSecretStore, type SecretStore } from '../secrets/secret-store.js';
import type { ModelThinkingLevel } from './settings-store.js';
import { SettingsStore } from './settings-store.js';
import type {
  CreateModelProviderInput,
  DefaultModelSelection,
  DeletedWorkspaceView,
  ModelProviderView,
  RunStore,
  StoredEvent,
  StoredRun,
  StoredRunStatus,
  StoredSession,
  UpdateModelProviderInput,
} from './store.js';

// Repo root：sqlite-store.ts 位于 src/host/persistence/，往上 4 层回到 package.json 所在目录
const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');

// 默认数据库路径：优先放项目目录内 .data/payaso.db（一定可写，避免 HOME 目录权限/扩展属性/沙箱问题）
// 用户可通过环境变量 PAYASO_DB_PATH 覆盖：设为绝对路径就写指定位置，设为 ":memory:" 就全内存模式
const DEFAULT_DB_PATH = path.join(REPO_ROOT, '.data', 'payaso.db');

interface RunRow {
  run_id: string;
  session_id: string;
  turn_index: number;
  task: string;
  status: string;
  workspace_root: string;
  workspace_name: string;
  permission_mode: string;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
  deleted_at: string | null;
  model: string | null;
  provider_id: string | null;
  base_url: string | null;
}

interface SessionRow {
  session_id: string;
  title: string;
  workspace_root: string;
  workspace_name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface EventRow {
  seq: number;
  payload: string;
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

function mapRun(row: RunRow): StoredRun {
  const run: StoredRun = {
    runId: row.run_id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    task: row.task,
    status: row.status as StoredRunStatus,
    workspaceRoot: row.workspace_root,
    workspaceName: row.workspace_name,
    permissionMode: storedPermissionMode(row.permission_mode),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.result !== null) run.result = row.result;
  if (row.error !== null) run.error = row.error;
  if (row.deleted_at !== null) run.deletedAt = row.deleted_at;
  if (row.model !== null) run.model = row.model;
  if (row.provider_id !== null) run.providerId = row.provider_id;
  if (row.base_url !== null) run.baseUrl = row.base_url;
  return run;
}

function mapSession(row: SessionRow): StoredSession {
  return {
    sessionId: row.session_id,
    title: row.title,
    workspaceRoot: row.workspace_root,
    workspaceName: row.workspace_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

export function resolvePayasoDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.PAYASO_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

export class SqliteRunStore implements RunStore {
  private db!: DatabaseSync;
  private closed = false;
  private settings!: SettingsStore;

  constructor(dbPath: string = resolvePayasoDbPath(), secrets: SecretStore = createSecretStore()) {
    let actualPath = dbPath;
    let initialized = false;
    const attempts: Array<{ path: string; error: string }> = [];

    for (const candidate of [actualPath, ':memory:']) {
      if (initialized) break;
      actualPath = candidate;
      let opened: DatabaseSync | undefined;
      try {
        if (actualPath !== ':memory:') {
          try {
            fs.mkdirSync(path.dirname(actualPath), { recursive: true });
          } catch {
            /* 下面 open/create/exec 还会再报 */
          }
        }
        opened = new DatabaseSync(actualPath);
        this.db = opened;
        this.settings = new SettingsStore(this.db, secrets);
        if (actualPath !== ':memory:') {
          try {
            fs.chmodSync(actualPath, 0o600);
          } catch {
            /* best effort */
          }
        }
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA busy_timeout = 5000');
        if (actualPath !== ':memory:') {
          try {
            this.db.exec('PRAGMA journal_mode = WAL');
          } catch (err) {
            console.warn(
              `[RunStore] 启用 WAL 失败（${(err as Error).message}），回退到 DELETE journal 模式；仍会持久化但写入性能较差`,
            );
            try {
              this.db.exec('PRAGMA journal_mode = DELETE');
            } catch {
              /* 都失败就用 SQLite 默认 */
            }
          }
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            workspace_root TEXT NOT NULL,
            workspace_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
          );

          CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            turn_index INTEGER NOT NULL,
            task TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running', 'stopping', 'completed', 'failed', 'stopped', 'interrupted')),
            workspace_root TEXT NOT NULL,
            workspace_name TEXT NOT NULL,
            permission_mode TEXT NOT NULL DEFAULT 'workspace-write'
              CHECK (permission_mode IN ('read-only', 'workspace-write', 'full-access')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            result TEXT,
            error TEXT,
            deleted_at TEXT,
            model TEXT,
            provider_id TEXT,
            base_url TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id),
            UNIQUE (session_id, turn_index)
          );

          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            type TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            payload TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
            UNIQUE (run_id, seq)
          );

          CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);

          CREATE TABLE IF NOT EXISTS session_meta (
            session_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, key)
          );
        `);
        this.migrateDeletedAt();
        this.migrateLegacyRuns();
        this.migrateStoppingStatus();
        this.migratePermissionMode();
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_runs_session_turn ON runs(session_id, turn_index ASC);
          CREATE INDEX IF NOT EXISTS idx_runs_workspace_name ON runs(workspace_name);
        `);
        initialized = true;
      } catch (err) {
        attempts.push({ path: actualPath, error: (err as Error).message });
        try {
          opened?.close();
        } catch {
          /* ignore */
        }
        if (actualPath === ':memory:') {
          throw new Error(
            `[RunStore] 无法初始化持久层（磁盘和 :memory: 均失败）：\n${attempts.map((a) => `- ${a.path}: ${a.error}`).join('\n')}`,
          );
        }
      }
    }
    if (actualPath !== dbPath) {
      (this as any).dbPath = actualPath;
      console.warn(`[RunStore] 无法使用 ${dbPath}，已回退到内存模式（:memory:）；数据不会持久化`);
    }
  }

  private migrateDeletedAt(): void {
    const sessionColumns = this.db
      .prepare('PRAGMA table_info(sessions)')
      .all() as unknown as Array<{ name: string }>;
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all() as unknown as Array<{
      name: string;
    }>;
    const sessionHasDeleted = sessionColumns.some((c) => c.name === 'deleted_at');
    const runHasDeleted = runColumns.some((c) => c.name === 'deleted_at');
    if (!sessionHasDeleted) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN deleted_at TEXT');
    }
    if (!runHasDeleted) {
      this.db.exec('ALTER TABLE runs ADD COLUMN deleted_at TEXT');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_deleted_at ON sessions(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_runs_deleted_at ON runs(deleted_at);
    `);
  }

  private migrateLegacyRuns(): void {
    const names = new Set(
      this.db
        .prepare('PRAGMA table_info(runs)')
        .all()
        .map((r) => (r as any).name),
    );
    if (!names.has('session_id')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN session_id TEXT');
    }
    if (!names.has('turn_index')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN turn_index INTEGER');
    }
    if (!names.has('workspace_root')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN workspace_root TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('workspace_name')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN workspace_name TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('result')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN result TEXT');
    }
    if (!names.has('error')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN error TEXT');
    }
    if (!names.has('deleted_at')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN deleted_at TEXT');
    }
    if (!names.has('model')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN model TEXT');
    }
    if (!names.has('provider_id')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN provider_id TEXT');
    }
    if (!names.has('base_url')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN base_url TEXT');
    }
    const rows = this.db
      .prepare(
        "SELECT run_id, task, workspace_root, workspace_name, created_at, updated_at FROM runs WHERE session_id IS NULL OR session_id = ''",
      )
      .all() as Array<{
      run_id: string;
      task: string;
      workspace_root: string;
      workspace_name: string;
      created_at: string;
      updated_at: string;
    }>;
    for (const row of rows) {
      const sessionId = row.run_id;
      const title = row.task.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名任务';
      this.db
        .prepare(
          'INSERT OR REPLACE INTO sessions (session_id, title, workspace_root, workspace_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          sessionId,
          title,
          row.workspace_root,
          row.workspace_name,
          row.created_at,
          row.updated_at,
        );
      this.db
        .prepare('UPDATE runs SET session_id = ?, turn_index = ? WHERE run_id = ?')
        .run(sessionId, 1, row.run_id);
    }
  }

  // v1.6 True Cancellation：status CHECK 约束加入 'stopping'。
  // SQLite 无法 ALTER CHECK —— 检测旧 DDL 后整表重建（保留全部行与 events 外键）。
  private migrateStoppingStatus(): void {
    const table = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get() as { sql?: string } | undefined;
    if (!table?.sql || table.sql.includes("'stopping'")) return;

    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE runs_new (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'stopping', 'completed', 'failed', 'stopped', 'interrupted')),
        workspace_root TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT 'workspace-write'
          CHECK (permission_mode IN ('read-only', 'workspace-write', 'full-access')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result TEXT,
        error TEXT,
        deleted_at TEXT,
        model TEXT,
        provider_id TEXT,
        base_url TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id),
        UNIQUE (session_id, turn_index)
      );
      INSERT INTO runs_new (
        run_id, session_id, turn_index, task, status, workspace_root, workspace_name,
        permission_mode, created_at, updated_at, result, error, deleted_at, model, provider_id, base_url
      )
      SELECT
        run_id, session_id, turn_index, task, status, workspace_root, workspace_name,
        'workspace-write', created_at, updated_at, result, error, deleted_at, model, provider_id, base_url
      FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  private migratePermissionMode(): void {
    const columns = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'permission_mode')) return;
    this.db.exec(`
      ALTER TABLE runs ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'workspace-write'
        CHECK (permission_mode IN ('read-only', 'workspace-write', 'full-access'));
    `);
  }

  private deletedFilter(opts?: { includeDeleted?: boolean }): string {
    return opts?.includeDeleted ? '' : ' AND deleted_at IS NULL';
  }

  createSession(session: StoredSession): void {
    this.db
      .prepare(`
      INSERT INTO sessions (session_id, title, workspace_root, workspace_name, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        session.sessionId,
        session.title,
        session.workspaceRoot,
        session.workspaceName,
        session.createdAt,
        session.updatedAt,
        nullable(session.deletedAt),
      );
  }

  updateSession(session: StoredSession): void {
    this.db
      .prepare(`
      UPDATE sessions SET title = ?, workspace_root = ?, workspace_name = ?, updated_at = ?, deleted_at = ? WHERE session_id = ?
    `)
      .run(
        session.title,
        session.workspaceRoot,
        session.workspaceName,
        session.updatedAt,
        nullable(session.deletedAt),
        session.sessionId,
      );
  }

  getSession(sessionId: string, opts?: { includeDeleted?: boolean }): StoredSession | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?${this.deletedFilter(opts)}`)
      .get(sessionId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  /** 读取会话元数据（goal / plan_mode / force_compact / feedback 共用一张 KV 表）。 */
  getSessionMeta(sessionId: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM session_meta WHERE session_id = ? AND key = ?')
      .get(sessionId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSessionMeta(sessionId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO session_meta (session_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(sessionId, key, value, new Date().toISOString());
  }

  deleteSessionMeta(sessionId: string, key: string): void {
    this.db
      .prepare('DELETE FROM session_meta WHERE session_id = ? AND key = ?')
      .run(sessionId, key);
  }

  /** 按前缀列出会话元数据（key 升序，供 feedback 列表/导出汇总）。 */
  listSessionMeta(sessionId: string, prefix?: string): Array<{ key: string; value: string }> {
    const rows = (
      prefix
        ? this.db
            .prepare(
              'SELECT key, value FROM session_meta WHERE session_id = ? AND key LIKE ? ORDER BY key ASC',
            )
            .all(sessionId, `${prefix}%`)
        : this.db
            .prepare('SELECT key, value FROM session_meta WHERE session_id = ? ORDER BY key ASC')
            .all(sessionId)
    ) as Array<{ key: string; value: string }>;
    return rows;
  }

  listSessions(opts?: { includeDeleted?: boolean }): StoredSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE 1=1${this.deletedFilter(opts)} ORDER BY updated_at DESC, session_id ASC`,
      )
      .all() as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      throw err;
    }
  }

  renameSessionsWorkspace(fromName: string, toName: string): number {
    const sessionsResult = this.db
      .prepare(
        'UPDATE sessions SET workspace_name = ? WHERE workspace_name = ? AND deleted_at IS NULL',
      )
      .run(toName, fromName);
    this.db
      .prepare('UPDATE runs SET workspace_name = ? WHERE workspace_name = ? AND deleted_at IS NULL')
      .run(toName, fromName);
    return Number(sessionsResult.changes);
  }

  softDeleteWorkspace(workspaceRoot: string, now: string): number {
    return this.tx(() => {
      const sessionsResult = this.db
        .prepare(
          'UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE workspace_root = ? AND deleted_at IS NULL',
        )
        .run(now, now, workspaceRoot);
      this.db
        .prepare(
          'UPDATE runs SET deleted_at = ?, updated_at = ? WHERE workspace_root = ? AND deleted_at IS NULL',
        )
        .run(now, now, workspaceRoot);
      return Number(sessionsResult.changes);
    });
  }

  restoreWorkspace(workspaceRoot: string, now: string): number {
    return this.tx(() => {
      const sessionsResult = this.db
        .prepare(
          'UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE workspace_root = ? AND deleted_at IS NOT NULL',
        )
        .run(now, workspaceRoot);
      this.db
        .prepare(
          'UPDATE runs SET deleted_at = NULL, updated_at = ? WHERE workspace_root = ? AND deleted_at IS NOT NULL',
        )
        .run(now, workspaceRoot);
      return Number(sessionsResult.changes);
    });
  }

  purgeWorkspace(workspaceRoot: string): number {
    return this.tx(() => {
      this.db
        .prepare('DELETE FROM runs WHERE workspace_root = ? AND deleted_at IS NOT NULL')
        .run(workspaceRoot);
      const sessionsDelete = this.db
        .prepare('DELETE FROM sessions WHERE workspace_root = ? AND deleted_at IS NOT NULL')
        .run(workspaceRoot);
      return Number(sessionsDelete.changes);
    });
  }

  listDeletedWorkspaces(): DeletedWorkspaceView[] {
    const rows = this.db
      .prepare(`
      SELECT workspace_root, workspace_name, MAX(deleted_at) AS deleted_at
      FROM sessions
      WHERE deleted_at IS NOT NULL
      GROUP BY workspace_root
      ORDER BY deleted_at DESC
    `)
      .all() as unknown as Array<{
      workspace_root: string;
      workspace_name: string;
      deleted_at: string;
    }>;
    return rows.map((r) => ({
      workspaceRoot: r.workspace_root,
      workspaceName: r.workspace_name,
      deletedAt: r.deleted_at,
    }));
  }

  findSessionByWorkspaceName(
    name: string,
    opts?: { includeDeleted?: boolean },
  ): StoredSession | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE workspace_name = ?${this.deletedFilter(opts)} ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(name) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  createRun(run: StoredRun): void {
    if (!this.getSession(run.sessionId)) {
      this.createSession({
        sessionId: run.sessionId,
        title: run.task.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名任务',
        workspaceRoot: run.workspaceRoot,
        workspaceName: run.workspaceName,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    }
    this.db
      .prepare(`
      INSERT INTO runs (
        run_id, session_id, turn_index, task, status, workspace_root, workspace_name,
        permission_mode, created_at, updated_at, result, error, deleted_at, model, provider_id, base_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        run.runId,
        run.sessionId,
        run.turnIndex,
        run.task,
        run.status,
        run.workspaceRoot,
        run.workspaceName,
        storedPermissionMode(run.permissionMode),
        run.createdAt,
        run.updatedAt,
        nullable(run.result),
        nullable(run.error),
        nullable(run.deletedAt),
        nullable(run.model),
        nullable(run.providerId),
        nullable(run.baseUrl),
      );
  }

  updateRun(run: StoredRun): void {
    const result = this.db
      .prepare(`
      UPDATE runs SET
        session_id = ?, turn_index = ?, task = ?, status = ?, workspace_root = ?, workspace_name = ?,
        permission_mode = ?, created_at = ?, updated_at = ?, result = ?, error = ?, deleted_at = ?,
        model = ?, provider_id = ?, base_url = ?
      WHERE run_id = ?
    `)
      .run(
        run.sessionId,
        run.turnIndex,
        run.task,
        run.status,
        run.workspaceRoot,
        run.workspaceName,
        storedPermissionMode(run.permissionMode),
        run.createdAt,
        run.updatedAt,
        nullable(run.result),
        nullable(run.error),
        nullable(run.deletedAt),
        nullable(run.model),
        nullable(run.providerId),
        nullable(run.baseUrl),
        run.runId,
      );
    if (result.changes !== 1) throw new Error(`Run not found: ${run.runId}`);
  }

  getRun(runId: string, opts?: { includeDeleted?: boolean }): StoredRun | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE run_id = ?${this.deletedFilter(opts)}`)
      .get(runId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(opts?: { includeDeleted?: boolean }): StoredRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE 1=1${this.deletedFilter(opts)} ORDER BY created_at DESC, run_id ASC`,
      )
      .all() as unknown as RunRow[];
    return rows.map(mapRun);
  }

  listRunsBySession(sessionId: string, opts?: { includeDeleted?: boolean }): StoredRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE session_id = ?${this.deletedFilter(opts)} ORDER BY turn_index ASC`,
      )
      .all(sessionId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  appendEvent(runId: string, event: HostEvent): number {
    const row = this.db
      .prepare(`
      INSERT INTO events (run_id, seq, type, timestamp, payload)
      SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
      FROM events WHERE run_id = ?
      RETURNING seq
    `)
      .get(runId, event.type, event.timestamp, JSON.stringify(event), runId) as
      | { seq: number }
      | undefined;
    if (!row) throw new Error(`Failed to append event for Run: ${runId}`);
    return row.seq;
  }

  // v1.6 Atomic Run Finalization：terminal status 更新 + terminal 事件插入在同一
  // 事务内提交 —— COMMIT 前崩溃则两者都不存在，COMMIT 后崩溃则两者都已落库。
  // 任一步失败 ROLLBACK（Run 保持原状态、terminal event 不存在）。seq 在事务内
  // 用 appendEvent 的既有分配逻辑生成，不绕开序号生成。
  finalizeRun(run: StoredRun, event: HostEvent): number {
    return this.tx(() => {
      this.updateRun(run);
      return this.appendEvent(run.runId, event);
    });
  }

  listEvents(runId: string): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, payload FROM events WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as unknown as EventRow[];
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as HostEvent }));
  }

  renameSession(sessionId: string, title: string): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        'UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ? AND deleted_at IS NULL',
      )
      .run(title, now, sessionId);
    if (result.changes !== 1) throw new Error(`Session not found: ${sessionId}`);
  }

  archiveSession(sessionId: string, now: string): number {
    return this.tx(() => {
      const sessionsResult = this.db
        .prepare(
          'UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE session_id = ? AND deleted_at IS NULL',
        )
        .run(now, now, sessionId);
      this.db
        .prepare(
          'UPDATE runs SET deleted_at = ?, updated_at = ? WHERE session_id = ? AND deleted_at IS NULL',
        )
        .run(now, now, sessionId);
      return Number(sessionsResult.changes);
    });
  }

  restoreSession(sessionId: string, now: string): number {
    return this.tx(() => {
      const sessionsResult = this.db
        .prepare(
          'UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE session_id = ? AND deleted_at IS NOT NULL',
        )
        .run(now, sessionId);
      this.db
        .prepare(
          'UPDATE runs SET deleted_at = NULL, updated_at = ? WHERE session_id = ? AND deleted_at IS NOT NULL',
        )
        .run(now, sessionId);
      return Number(sessionsResult.changes);
    });
  }

  deleteSession(sessionId: string): number {
    return this.tx(() => {
      this.db
        .prepare(
          'DELETE FROM events WHERE run_id IN (SELECT run_id FROM runs WHERE session_id = ?)',
        )
        .run(sessionId);
      this.db.prepare('DELETE FROM runs WHERE session_id = ?').run(sessionId);
      const sessionsDelete = this.db
        .prepare('DELETE FROM sessions WHERE session_id = ?')
        .run(sessionId);
      return Number(sessionsDelete.changes);
    });
  }

  listModelProviders(): ModelProviderView[] {
    return this.settings.listViews();
  }

  getModelProvider(id: string): ModelProviderView | null {
    return this.settings.getModelView(id);
  }

  getModelProviderSecret(
    id: string,
    model?: string,
  ): {
    apiKey: string;
    baseUrl: string;
    models: string[];
    piProviderId?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    vision?: boolean;
    thinkingLevel?: ModelThinkingLevel;
  } | null {
    // 凭证经 SecretStore（macOS Keychain）读取；metadata 只提供 hasApiKey；
    // model 提供时附带该模型的能力覆盖（设置页配置）
    return this.settings.getProviderCredentials(id, model);
  }

  getDefaultProviderId(): string {
    return this.settings.getDefaultProviderId();
  }

  getDefaultModelId(): string {
    return this.settings.getDefaultModelId();
  }

  setDefaultModel(providerId: string, modelId?: string): DefaultModelSelection {
    return this.settings.setDefaultModel(providerId, modelId);
  }

  recordModelProbe(
    id: string,
    result: { status: 'available' | 'error'; error?: string },
  ): ModelProviderView | null {
    return this.settings.recordModelProbe(id, result);
  }

  importEnvFallback(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): DefaultModelSelection | null {
    return this.settings.importEnvFallback(input);
  }

  addModelProvider(input: CreateModelProviderInput): ModelProviderView {
    return this.settings.addModel(input);
  }

  updateModelProvider(id: string, input: UpdateModelProviderInput): ModelProviderView | null {
    return this.settings.updateModel(id, input);
  }

  deleteModelProvider(id: string): boolean {
    return this.settings.deleteModel(id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function createDefaultRunStore(secrets: SecretStore = createSecretStore()): SqliteRunStore {
  return new SqliteRunStore(resolvePayasoDbPath(), secrets);
}
