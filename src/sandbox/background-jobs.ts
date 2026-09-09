// Module: Background Jobs — long-running Shell commands without blocking the
// agent loop.
//
// Why this module exists (v1.10):
// A test suite or build can take minutes. Before, the agent either waited (and
// burned the whole turn) or gave up. The timeout is now configurable, but a
// long command still occupies the turn. This registry lets a command run
// detached from the loop while the agent keeps working, then poll or kill it.
//
// Design:
// - Executor port (`BackgroundExecutor`) — the registry knows nothing about
//   sandboxes or platforms; the Shell tool injects the real contained executor
//   and tests inject fakes. Same dependency direction as the rest of the Runtime.
// - Per-run isolation + bounded concurrency + bounded output (shared budget).
// - Lifecycle is owned by the Host: every terminal Run state disposes its jobs,
//   and aborting the Run aborts the jobs, so a finished Run can never leave an
//   orphan process behind.

import { sliceTextToBudget, TOOL_OUTPUT_MAX_BYTES } from '../tool-output-budget.js';

export type BackgroundJobStatus = 'running' | 'succeeded' | 'failed' | 'killed';

export interface BackgroundJobResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Executes the command; resolves when the process exits. */
export type BackgroundExecutor = (signal: AbortSignal) => Promise<BackgroundJobResult>;

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
  runId: string;
  command: string;
  executor: BackgroundExecutor;
  /** The Run's AbortSignal: aborting the Run aborts its jobs. */
  parentSignal?: AbortSignal;
  maxOutputBytes?: number;
}

/** Concurrent jobs allowed per Run; beyond this the tool call fails loudly. */
export const MAX_JOBS_PER_RUN = 4;

interface JobRecord {
  view: BackgroundJobView;
  controller: AbortController;
  killRequested: boolean;
}

const jobsByRun = new Map<string, Map<string, JobRecord>>();
const counters = new Map<string, number>();

function runJobs(runId: string): Map<string, JobRecord> {
  let jobs = jobsByRun.get(runId);
  if (!jobs) {
    jobs = new Map();
    jobsByRun.set(runId, jobs);
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

/**
 * Start a job. Returns immediately with a `running` view; the executor runs in
 * the background. Throws when the per-run concurrency limit is reached.
 */
export function startBackgroundJob(input: StartBackgroundJobInput): BackgroundJobView {
  const jobs = runJobs(input.runId);
  const running = [...jobs.values()].filter((job) => job.view.status === 'running').length;
  if (running >= MAX_JOBS_PER_RUN) {
    throw new Error(
      `后台作业数量已达上限（${MAX_JOBS_PER_RUN} 个并发）。请先 shellJob {action:"list"} 查看并用 kill 终止，或等待其完成。`,
    );
  }
  const next = (counters.get(input.runId) ?? 0) + 1;
  counters.set(input.runId, next);
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
  };
  jobs.set(jobId, record);

  const abort = (): void => controller.abort();
  if (input.parentSignal) {
    if (input.parentSignal.aborted) abort();
    else input.parentSignal.addEventListener('abort', abort, { once: true });
  }

  const maxOutputBytes = input.maxOutputBytes ?? TOOL_OUTPUT_MAX_BYTES;
  void input
    .executor(controller.signal)
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
    });

  return toPublicView(record);
}

export function getBackgroundJob(runId: string, jobId: string): BackgroundJobView | undefined {
  const record = jobsByRun.get(runId)?.get(jobId);
  return record ? toPublicView(record) : undefined;
}

export function listBackgroundJobs(runId: string): BackgroundJobView[] {
  const jobs = jobsByRun.get(runId);
  if (!jobs) return [];
  return [...jobs.values()].map(toPublicView);
}

/** Abort a job. Returns false when the job does not exist. */
export function killBackgroundJob(runId: string, jobId: string): boolean {
  const record = jobsByRun.get(runId)?.get(jobId);
  if (!record) return false;
  if (record.view.status === 'running') {
    record.killRequested = true;
    record.controller.abort();
  }
  return true;
}

/** Abort and forget every job of a Run. Idempotent; called on Run terminal states. */
export function disposeRunBackgroundJobs(runId: string): void {
  const jobs = jobsByRun.get(runId);
  if (!jobs) return;
  for (const record of jobs.values()) {
    if (record.view.status === 'running') {
      record.killRequested = true;
      record.controller.abort();
    }
  }
  jobsByRun.delete(runId);
  counters.delete(runId);
}

/** Test/observability helper: number of tracked jobs for a Run. */
export function backgroundJobCount(runId: string): number {
  return jobsByRun.get(runId)?.size ?? 0;
}
