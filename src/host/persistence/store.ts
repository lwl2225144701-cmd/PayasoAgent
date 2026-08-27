import type { HostEvent } from "../run-events.js";

export type StoredRunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface StoredSession {
  sessionId: string;
  title: string;
  workspaceRoot: string;
  workspaceName: string;
  createdAt: string;
  updatedAt: string;
}

// Host-private persistence record. workspaceRoot is deliberately absent from
// public API projections and remains available only to Host/Runtime code.
export interface StoredRun {
  runId: string;
  sessionId: string;
  turnIndex: number;
  task: string;
  status: StoredRunStatus;
  workspaceRoot: string;
  workspaceName: string;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}

export interface StoredEvent {
  seq: number;
  event: HostEvent;
}

// Thin product-persistence boundary. Runtime checkpoints intentionally do not
// pass through this interface.
export interface RunStore {
  createSession(session: StoredSession): void;
  updateSession(session: StoredSession): void;
  getSession(sessionId: string): StoredSession | null;
  listSessions(): StoredSession[];
  renameSessionsWorkspace(fromName: string, toName: string): number;
  deleteSessionsByWorkspace(name: string): number;
  findSessionByWorkspaceName(name: string): StoredSession | null;
  createRun(run: StoredRun): void;
  updateRun(run: StoredRun): void;
  getRun(runId: string): StoredRun | null;
  listRuns(): StoredRun[];
  listRunsBySession(sessionId: string): StoredRun[];
  appendEvent(runId: string, event: HostEvent): number;
  listEvents(runId: string): StoredEvent[];
  close(): void;
}
