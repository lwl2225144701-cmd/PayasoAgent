import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { HostEvent } from "../run-events.js";
import type { RunStore, StoredEvent, StoredRun, StoredRunStatus, StoredSession } from "./store.js";

// Repo root：sqlite-store.ts 位于 src/host/persistence/，往上 4 层回到 package.json 所在目录
const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "..");

// 默认数据库路径：优先放项目目录内 .data/payaso.db（一定可写，避免 HOME 目录权限/扩展属性/沙箱问题）
// 用户可通过环境变量 PAYASO_DB_PATH 覆盖：设为绝对路径就写指定位置，设为 ":memory:" 就全内存模式
const DEFAULT_DB_PATH = path.join(REPO_ROOT, ".data", "payaso.db");

interface RunRow {
  run_id: string;
  session_id: string;
  turn_index: number;
  task: string;
  status: string;
  workspace_root: string;
  workspace_name: string;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
}

interface SessionRow {
  session_id: string;
  title: string;
  workspace_root: string;
  workspace_name: string;
  created_at: string;
  updated_at: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.result !== null) run.result = row.result;
  if (row.error !== null) run.error = row.error;
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
  };
}

export function resolvePayasoDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.PAYASO_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

export class SqliteRunStore implements RunStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(readonly dbPath: string = resolvePayasoDbPath()) {
    let actualPath = dbPath;
    let initialized = false;
    const attempts: Array<{ path: string; error: string }> = [];

    // 先试用户指定路径（磁盘），磁盘任一步失败都再试一次 :memory:。
    // :memory: 再失败就直接抛，说明运行环境连 node:sqlite 内存模式都用不了（更严重的问题）。
    for (const candidate of [actualPath, ":memory:"]) {
      if (initialized) break;
      actualPath = candidate;
      try {
        if (actualPath !== ":memory:") {
          try { fs.mkdirSync(path.dirname(actualPath), { recursive: true }); } catch { /* 下面 open/create/exec 还会再报 */ }
        }
        this.db = new DatabaseSync(actualPath);
        if (actualPath !== ":memory:") {
          try { fs.chmodSync(actualPath, 0o600); } catch { /* best effort */ }
        }
        this.db.exec("PRAGMA foreign_keys = ON");
        this.db.exec("PRAGMA busy_timeout = 5000");
        if (actualPath !== ":memory:") {
          try {
            this.db.exec("PRAGMA journal_mode = WAL");
          } catch (err) {
            // 沙箱/扩展属性/只读挂载都可能导致 WAL 无法创建 -wal/-shm 伴生文件。
            // 回退到 DELETE journal 模式牺牲一点并发，保证能跑起来。
            console.warn(
              `[RunStore] 启用 WAL 失败（${(err as Error).message}），回退到 DELETE journal 模式；仍会持久化但写入性能较差`
            );
            try { this.db.exec("PRAGMA journal_mode = DELETE"); } catch { /* 都失败就用 SQLite 默认 */ }
          }
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            workspace_root TEXT NOT NULL,
            workspace_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            turn_index INTEGER NOT NULL,
            task TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped', 'interrupted')),
            workspace_root TEXT NOT NULL,
            workspace_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            result TEXT,
            error TEXT,
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
        `);
        this.migrateLegacyRuns();
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_runs_session_turn ON runs(session_id, turn_index ASC);
          CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
        `);
        initialized = true;
      } catch (err) {
        attempts.push({ path: actualPath, error: (err as Error).message });
        try { this.db?.close?.(); } catch { /* cleanup, ignore */ }
        if (actualPath === ":memory:") break; // :memory: 失败就不再试了，外层汇总抛
      }
    }

    if (!initialized) {
      const detail = attempts.map(a => `  ${a.path}: ${a.error}`).join("\n");
      throw new Error(`[RunStore] 无法在磁盘或内存中初始化 SQLite：\n${detail}`);
    }

    // 写回实际使用的路径（外部打印日志时能知道是不是内存模式）
    (this as { dbPath: string }).dbPath = actualPath;
    if (actualPath === ":memory:" && dbPath !== ":memory:") {
      console.warn(`[RunStore] 因无法写入 ${dbPath}，当前正在使用内存模式持久化；Host 进程退出后会话/Run/事件将全部丢失`);
    }
  }

  private migrateLegacyRuns(): void {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as unknown as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("session_id")) this.db.exec("ALTER TABLE runs ADD COLUMN session_id TEXT");
    if (!names.has("turn_index")) this.db.exec("ALTER TABLE runs ADD COLUMN turn_index INTEGER");
    this.db.exec(`
      INSERT OR IGNORE INTO sessions (
        session_id, title, workspace_root, workspace_name, created_at, updated_at
      )
      SELECT run_id, substr(task, 1, 80), workspace_root, workspace_name, created_at, updated_at
      FROM runs
      WHERE session_id IS NULL OR session_id = '';

      UPDATE runs SET session_id = run_id
      WHERE session_id IS NULL OR session_id = '';

      UPDATE runs SET turn_index = 1
      WHERE turn_index IS NULL OR turn_index < 1;
    `);
  }

  createSession(session: StoredSession): void {
    this.db.prepare(`
      INSERT INTO sessions (
        session_id, title, workspace_root, workspace_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.sessionId,
      session.title,
      session.workspaceRoot,
      session.workspaceName,
      session.createdAt,
      session.updatedAt,
    );
  }

  updateSession(session: StoredSession): void {
    const result = this.db.prepare(`
      UPDATE sessions SET title = ?, workspace_root = ?, workspace_name = ?,
        created_at = ?, updated_at = ? WHERE session_id = ?
    `).run(
      session.title,
      session.workspaceRoot,
      session.workspaceName,
      session.createdAt,
      session.updatedAt,
      session.sessionId,
    );
    if (result.changes !== 1) throw new Error(`Session not found: ${session.sessionId}`);
  }

  getSession(sessionId: string): StoredSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(): StoredSession[] {
    const rows = this.db.prepare(
      "SELECT * FROM sessions ORDER BY updated_at DESC, session_id ASC"
    ).all() as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  createRun(run: StoredRun): void {
    if (!this.getSession(run.sessionId)) {
      this.createSession({
        sessionId: run.sessionId,
        title: run.task.replace(/\s+/g, " ").trim().slice(0, 80) || "未命名任务",
        workspaceRoot: run.workspaceRoot,
        workspaceName: run.workspaceName,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    }
    this.db.prepare(`
      INSERT INTO runs (
        run_id, session_id, turn_index, task, status, workspace_root, workspace_name,
        created_at, updated_at, result, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
      run.sessionId,
      run.turnIndex,
      run.task,
      run.status,
      run.workspaceRoot,
      run.workspaceName,
      run.createdAt,
      run.updatedAt,
      nullable(run.result),
      nullable(run.error),
    );
  }

  updateRun(run: StoredRun): void {
    const result = this.db.prepare(`
      UPDATE runs SET
        session_id = ?, turn_index = ?, task = ?, status = ?, workspace_root = ?, workspace_name = ?,
        created_at = ?, updated_at = ?, result = ?, error = ?
      WHERE run_id = ?
    `).run(
      run.sessionId,
      run.turnIndex,
      run.task,
      run.status,
      run.workspaceRoot,
      run.workspaceName,
      run.createdAt,
      run.updatedAt,
      nullable(run.result),
      nullable(run.error),
      run.runId,
    );
    if (result.changes !== 1) throw new Error(`Run not found: ${run.runId}`);
  }

  getRun(runId: string): StoredRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(): StoredRun[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC, run_id ASC").all() as unknown as RunRow[];
    return rows.map(mapRun);
  }

  listRunsBySession(sessionId: string): StoredRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM runs WHERE session_id = ? ORDER BY turn_index ASC, created_at ASC"
    ).all(sessionId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  appendEvent(runId: string, event: HostEvent): number {
    // The aggregate INSERT allocates the next per-run sequence inside the same
    // SQLite statement. UNIQUE(run_id, seq) protects replay order.
    const row = this.db.prepare(`
      INSERT INTO events (run_id, seq, type, timestamp, payload)
      SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
      FROM events WHERE run_id = ?
      RETURNING seq
    `).get(runId, event.type, event.timestamp, JSON.stringify(event), runId) as { seq: number } | undefined;
    if (!row) throw new Error(`Failed to append event for Run: ${runId}`);
    return row.seq;
  }

  listEvents(runId: string): StoredEvent[] {
    const rows = this.db.prepare(
      "SELECT seq, payload FROM events WHERE run_id = ? ORDER BY seq ASC"
    ).all(runId) as unknown as EventRow[];
    return rows.map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as HostEvent }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function createDefaultRunStore(): SqliteRunStore {
  return new SqliteRunStore(resolvePayasoDbPath());
}
