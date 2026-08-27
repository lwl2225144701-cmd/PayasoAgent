import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HostEvent } from "../run-events.js";
import type { RunStore, StoredEvent, StoredRun, StoredRunStatus } from "./store.js";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".payaso", "payaso.db");

interface RunRow {
  run_id: string;
  task: string;
  status: string;
  workspace_root: string;
  workspace_name: string;
  created_at: string;
  updated_at: string;
  result: string | null;
  error: string | null;
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

export function resolvePayasoDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.PAYASO_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

export class SqliteRunStore implements RunStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(readonly dbPath: string = resolvePayasoDbPath()) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped', 'interrupted')),
        workspace_root TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result TEXT,
        error TEXT
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
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
    `);
  }

  createRun(run: StoredRun): void {
    this.db.prepare(`
      INSERT INTO runs (
        run_id, task, status, workspace_root, workspace_name,
        created_at, updated_at, result, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
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
        task = ?, status = ?, workspace_root = ?, workspace_name = ?,
        created_at = ?, updated_at = ?, result = ?, error = ?
      WHERE run_id = ?
    `).run(
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
