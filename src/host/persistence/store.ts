import type { HostEvent } from "../run-events.js";
import type { StoredModelProvider, ModelProviderView, CreateModelProviderInput, UpdateModelProviderInput, DefaultModelSelection } from "./settings-store.js";

// stopping（v1.6）：用户已请求停止、AbortSignal 已发出，但执行尚未真正退出。
export type StoredRunStatus = "running" | "stopping" | "completed" | "failed" | "stopped" | "interrupted";

export interface StoredSession {
  sessionId: string;
  title: string;
  workspaceRoot: string;
  workspaceName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
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
  deletedAt?: string;
  model?: string;
  providerId?: string;
  baseUrl?: string;
}

export interface StoredEvent {
  seq: number;
  event: HostEvent;
}

export interface DeletedWorkspaceView {
  workspaceRoot: string;
  workspaceName: string;
  deletedAt: string;
}

// Thin product-persistence boundary. Runtime checkpoints intentionally do not
// pass through this interface.
export interface RunStore {
  createSession(session: StoredSession): void;
  updateSession(session: StoredSession): void;
  getSession(sessionId: string, opts?: { includeDeleted?: boolean }): StoredSession | null;
  listSessions(opts?: { includeDeleted?: boolean }): StoredSession[];
  renameSessionsWorkspace(fromName: string, toName: string): number;
  softDeleteWorkspace(workspaceRoot: string, now: string): number;
  restoreWorkspace(workspaceRoot: string, now: string): number;
  purgeWorkspace(workspaceRoot: string): number;
  listDeletedWorkspaces(): DeletedWorkspaceView[];
  findSessionByWorkspaceName(name: string, opts?: { includeDeleted?: boolean }): StoredSession | null;
  createRun(run: StoredRun): void;
  updateRun(run: StoredRun): void;
  getRun(runId: string, opts?: { includeDeleted?: boolean }): StoredRun | null;
  listRuns(opts?: { includeDeleted?: boolean }): StoredRun[];
  listRunsBySession(sessionId: string, opts?: { includeDeleted?: boolean }): StoredRun[];
  appendEvent(runId: string, event: HostEvent): number;
  listEvents(runId: string): StoredEvent[];
  renameSession(sessionId: string, title: string): void;
  archiveSession(sessionId: string, now: string): number;
  restoreSession(sessionId: string, now: string): number;
  deleteSession(sessionId: string): number;
  listModelProviders(): ModelProviderView[];
  getModelProvider(id: string): ModelProviderView | null;
  getModelProviderSecret(id: string): { apiKey: string; baseUrl: string; models: string[] } | null;
  getDefaultProviderId(): string;
  getDefaultModelId(): string;
  setDefaultModel(providerId: string, modelId?: string): DefaultModelSelection;
  importEnvFallback(input: { baseUrl: string; apiKey: string; model: string }): DefaultModelSelection | null;
  addModelProvider(input: CreateModelProviderInput): ModelProviderView;
  updateModelProvider(id: string, input: UpdateModelProviderInput): ModelProviderView | null;
  deleteModelProvider(id: string): boolean;
  close(): void;
}

export type { StoredModelProvider, ModelProviderView, CreateModelProviderInput, UpdateModelProviderInput, DefaultModelSelection } from "./settings-store.js";
