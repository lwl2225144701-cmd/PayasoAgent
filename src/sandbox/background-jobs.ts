// Module: Background Jobs — long-running Shell commands without blocking the
// agent loop.
//
// Why this module exists (v1.10, Session-owned since v2.3):
// A test suite or build can take minutes. Before, the agent either waited (and
// burned the whole turn) or gave up. This registry lets a command run detached
// from the loop while the agent keeps working, then poll or kill it.
//
// v2.3 (docs/plans/long-task-timeout-plan.md steps 4-5):
// - Ownership moved from Run to Session: a job survives the Run that started
//   it (terminal Run states no longer dispose the registry) and stays visible
//   to later Runs of the same Session.
// - Incremental output: executors may push chunks while running; readers pull
//   new text with a character offset, so polling does not re-read everything.
// - Completion notification: each settled job queues a notification per
//   Session that the agent loop drains and presents to the model (with a
//   consecutive-wakeup cap owned by the loop, not the registry).
// - Cleanup remains explicit: user kill, Session deletion, or Host shutdown.
//   A Run's user-stop still aborts its jobs through the parentSignal it passed.
//
// Design:
// - Executor port (`BackgroundExecutor`) — the registry knows nothing about
//   sandboxes or platforms; the Shell tool injects the real contained executor
//   and tests inject fakes. Same dependency direction as the rest of the Runtime.
// - Per-Session isolation + bounded concurrency + bounded output (shared budget).

import { sliceTextToBudget, TOOL_OUTPUT_MAX_BYTES } from '../tool-output-budget.js';

export type BackgroundJobStatus = 'running' | 'succeeded' | 'failed' | 'killed';

export interface BackgroundJobResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Executes the command; resolves when the process exits. May push incremental
 * text through `onOutput` while running (registry keeps a bounded rolling
 * buffer for offset-based reads); the final result remains authoritative for
 * the completion view.
 */
export type BackgroundExecutor = (
  signal: AbortSignal,
  onOutput?: (chunk: string) => void,
) => Promise<BackgroundJobResult>;

export interface BackgroundJobView {
  jobId: string;
  command: string;
  status: BackgroundJobStatus;
  startedAt: string;
  finishedAt?: string;
  /** Capped stdout+stderr; present once the job is no longer running. */
  output?: string;
  error?: string;
}

export interface StartBackgroundJobInput {
  /** Session-level ownership key. Missing sessionId falls back to runId. */
  sessionId?: string;
  command: string;
  executor: BackgroundExecutor;
  /** The Run's AbortSignal: aborting the Run aborts the jobs *it started*. */
  parentSignal?: AbortSignal;
  /** Attribution + fallback key; the registry is indexed by sessionId. */
  runId?: string;
  maxOutputBytes?: number;
}

/** Concurrent jobs allowed per Session; beyond this the tool call fails loudly. */
export const MAX_JOBS_PER_SESSION = 4;

/** Rolling incremental-output buffer per job (4× the completion budget). */
const JOB_OUTPUT_BUFFER_MAX_CHARS = TOOL_OUTPUT_MAX_BYTES * 2;
/** Per-Session completion-notification queue cap (防失控：通知风暴有界). */
const MAX_PENDING_JOB_NOTIFICATIONS = 64;

export interface JobCompletionNotification {
  jobId: string;
  status: BackgroundJobStatus;
  finishedAt: string;
}

interface JobRecord {
  view: BackgroundJobView;
  controller: AbortController;
  killRequested: boolean;
  waiters: Set<() => void>;
  /** Incremental output (chars); stops growing past the rolling cap. */
  outputBuffer: string;
  outputOverflow: boolean;
}

const jobsBySession = new Map<string, Map<string, JobRecord>>();
const countersBySession = new Map<string, number>();
const notificationsBySession = new Map<string, JobCompletionNotification[]>();

function runJobs(sessionId: string): Map<string, JobRecord> {
  let jobs = jobsBySession.get(sessionId);
  if (!jobs) {
    jobs = new Map();
    jobsBySession.set(sessionId, jobs);
  }
  return jobs;
}

function toPublicView(record: JobRecord): BackgroundJobView {
  return { ...record.view };
}

function capOutput(stdout: string, stderr: string, maxBytes: number): string {
  const combined = [stdout, stderr].filter((part) => part.length > 0).join('\n');
  const sliced = sliceTextToBudget(combined, { maxBytes });
  return sliced.content;
}

function queueNotification(sessionId: string, jobId: string, status: BackgroundJobStatus): void {
  const queue = notificationsBySession.get(sessionId);
  if (queue && queue.length >= MAX_PENDING_JOB_NOTIFICATIONS) return; // 防失控：有界
  const list = queue ?? [];
  list.push({ jobId, status, finishedAt: new Date().toISOString() });
  if (!queue) notificationsBySession.set(sessionId, list);
}

/**
 * Start a job. Returns immediately with a `running` view; the executor runs in
 * the background. Throws when the per-Session concurrency limit is reached.
 */
export function startBackgroundJob(input: StartBackgroundJobInput): BackgroundJobView {
  const sessionId = input.sessionId || `run-${input.runId ?? 'unknown'}`;
  const jobs = runJobs(sessionId);
  const running = [...jobs.values()].filter((job) => job.view.status === 'running').length;
  if (running >= MAX_JOBS_PER_SESSION) {
    throw new Error(
      `后台作业数量已达上限（${MAX_JOBS_PER_SESSION} 个并发）。请先 shellJob {action:"list"} 查看并用 kill 终止，或等待其完成。`,
    );
  }
  const next = (countersBySession.get(sessionId) ?? 0) + 1;
  countersBySession.set(sessionId, next);
  const jobId = `job-${next}`;
  const controller = new AbortController();
  const record: JobRecord = {
    view: {
      jobId,
      command: input.command,
      status: 'running',
      startedAt: new Date().toISOString(),
    },
    controller,
    killRequested: false,
    waiters: new Set(),
    outputBuffer: '',
    outputOverflow: false,
  };
  jobs.set(jobId, record);

  const abort = (): void => controller.abort();
  if (input.parentSignal) {
    if (input.parentSignal.aborted) abort();
    else input.parentSignal.addEventListener('abort', abort, { once: true });
  }

  const maxOutputBytes = input.maxOutputBytes ?? TOOL_OUTPUT_MAX_BYTES;
  const onOutput = (chunk: string): void => {
    if (record.outputOverflow || chunk.length === 0) return;
    if (record.outputBuffer.length + chunk.length > JOB_OUTPUT_BUFFER_MAX_CHARS) {
      record.outputOverflow = true;
      return;
    }
    record.outputBuffer += chunk;
  };

  void input
    .executor(controller.signal, onOutput)
    .then((result) => {
      record.view.status = result.exitCode === 0 && !result.timedOut ? 'succeeded' : 'failed';
      record.view.output = capOutput(result.stdout, result.stderr, maxOutputBytes);
      if (result.timedOut) record.view.error = '命令超时或强制终止';
      record.view.finishedAt = new Date().toISOString();
    })
    .catch((error: unknown) => {
      record.view.status = record.killRequested || controller.signal.aborted ? 'killed' : 'failed';
      record.view.error = (error as Error).message ?? String(error);
      record.view.finishedAt = new Date().toISOString();
    })
    .finally(() => {
      input.parentSignal?.removeEventListener('abort', abort);
      queueNotification(sessionId, jobId, record.view.status);
      for (const notify of record.waiters) notify();
      record.waiters.clear();
    });

  return toPublicView(record);
}

export function getBackgroundJob(sessionId: string, jobId: string): BackgroundJobView | undefined {
  const record = jobsBySession.get(sessionId)?.get(jobId);
  return record ? toPublicView(record) : undefined;
}

export function listBackgroundJobs(sessionId: string): BackgroundJobView[] {
  const jobs = jobsBySession.get(sessionId);
  if (!jobs) return [];
  return [...jobs.values()].map(toPublicView);
}

/**
 * Incremental read of a running (or settled) job's output. `offsetChars` is
 * the character index returned by a previous read's `nextOffset`; returns the
 * text produced since then. A truncated rolling buffer reports `truncated`.
 */
export function readBackgroundJobOutput(
  sessionId: string,
  jobId: string,
  offsetChars = 0,
): { text: string; nextOffset: number; truncated: boolean } | undefined {
  const record = jobsBySession.get(sessionId)?.get(jobId);
  if (!record) return undefined;
  const from = Math.max(0, Math.min(Math.floor(offsetChars), record.outputBuffer.length));
  return {
    text: record.outputBuffer.slice(from),
    nextOffset: record.outputBuffer.length,
    truncated: record.outputOverflow,
  };
}

/** Pull and clear the Session's pending completion notifications (FIFO). */
export function drainJobCompletionNotifications(sessionId: string): JobCompletionNotification[] {
  const queue = notificationsBySession.get(sessionId);
  if (!queue || queue.length === 0) return [];
  notificationsBySession.set(sessionId, []);
  return queue;
}

export function pendingJobNotificationCount(sessionId: string): number {
  return notificationsBySession.get(sessionId)?.length ?? 0;
}

/**
 * Wait at most `waitMs` for one job to leave `running`.
 * The returned view is always current; a timeout is a normal `running` result.
 */
export async function waitForBackgroundJob(
  sessionId: string,
  jobId: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<BackgroundJobView | undefined> {
  const record = jobsBySession.get(sessionId)?.get(jobId);
  if (record?.view.status !== 'running' || waitMs <= 0) {
    return record ? toPublicView(record) : undefined;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.waiters.delete(finish);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.waiters.delete(finish);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(finish, waitMs);
    record.waiters.add(finish);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

  return toPublicView(record);
}

/** Abort a job. Returns false when the job does not exist. */
export function killBackgroundJob(sessionId: string, jobId: string): boolean {
  const record = jobsBySession.get(sessionId)?.get(jobId);
  if (!record) return false;
  if (record.view.status === 'running') {
    record.killRequested = true;
    record.controller.abort();
  }
  return true;
}

/**
 * Abort and forget every job of a Session (Session deletion / Host shutdown
 * path). Idempotent. Jobs are intentionally NOT disposed on Run terminal
 * states — Session ownership means they outlive the Run that started them.
 */
export function disposeSessionBackgroundJobs(sessionId: string): void {
  const jobs = jobsBySession.get(sessionId);
  if (jobs) {
    for (const record of jobs.values()) {
      if (record.view.status === 'running') {
        record.killRequested = true;
        record.controller.abort();
      }
    }
  }
  jobsBySession.delete(sessionId);
  countersBySession.delete(sessionId);
  notificationsBySession.delete(sessionId);
}

/** Abort and forget every job across all Sessions (Host shutdown path). */
export function disposeAllBackgroundJobs(): void {
  for (const sessionId of [...jobsBySession.keys()]) {
    disposeSessionBackgroundJobs(sessionId);
  }
}

/** Test/observability helper: number of tracked jobs for a Session. */
export function backgroundJobCount(sessionId: string): number {
  return jobsBySession.get(sessionId)?.size ?? 0;
}
