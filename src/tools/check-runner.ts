// Module: Check Runner — 单进程执行 + 完整日志采集 + 检查结论（计划 §5.2 / §5.3）。
//
// 分工：check.ts 只做参数契约（Schema / 互斥校验 / 解释器拒绝 / 超时解析），本模块
// 只做"跑一个进程、拿到完整日志、给出结论与事实"。两者都不依赖 Runtime / Harness。
//
// 三条不变量（每条都有 tests/check-tool.test.ts 的对应用例）：
// 1. 完整日志必须在**底层截断之前**采集。旧 Shell 路径的 outputLimit（64KB）与
//    Runtime 的 16KB 输出预算都会砍掉中间段，"只改 guard"救不回证据，所以这里走
//    executeSandboxedProcess 的原始带流标记 chunk 回调，落到单次受管 scratch。
// 2. 采集有上限（8MiB）。超限 → 保留已采集内容 + logsComplete=false → 结论
//    **inconclusive**：绝不伪装成完整报告，也绝不为换一个 tail 切片重跑进程
//    （重跑本身是新的副作用，而且旧结论并不会因此变成完整证据）。
// 3. `passed` 只代表进程退出协议通过（exit 0，未超时、未被信号终止），
//    不代表测试覆盖完整，更不代表用户任务已验收（§5.1 末段）。
//
// 结论与状态映射（§5.3 表）：
//   exit 0 / 非 0             → passed / failed（工具本身成功，不是 tool error）
//   超时 / 采集超限 / 发布失败 → inconclusive（保留退出码，但禁止比较与复用）
//   沙箱拒绝 / 程序缺失        → 抛回原有拒绝 / 依赖缺失语义，不产生任何通过记录
//   用户取消                  → 沿原取消路径 reject，不计失败、不生成通过记录
//   JSON 报告缺字段 / 非法     → inconclusive + diagnostics=null（绝不写成零诊断）

import fs from 'node:fs';
import path from 'node:path';
import {
  type CheckConclusion,
  type CheckProfileName,
  type Diagnostic,
  EXECUTION_EVIDENCE_VERSION,
  isStableDiagnosticFingerprint,
  isWorkspaceRelativePath,
  MAX_DIAGNOSTICS_PER_RECORD,
  type ToolFacts,
  validateToolFacts,
} from '../execution-evidence.js';
import { spillToolOutput } from '../runtime/tool-output-spill.js';
import {
  executeSandboxedProcess,
  type SandboxedProcessRequest,
  type SandboxedProcessResult,
} from '../sandbox/shell-executor.js';
import { createShellScratch, type ShellScratch } from '../sandbox/shell-scratch.js';
import { resolveToolOutputBudget } from '../tool-output-budget.js';
import type { ToolContext } from './tools.js';

/** 单次 check 的日志采集总上限（stdout+stderr，计划 §5.2 固定值）。 */
export const CHECK_LOG_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

/** 结构化检查报告的判别字段（适配器写入 stdout；stderr 永不参与解析）。 */
export const CHECK_REPORT_KIND = 'payaso-check-report';

export const CHECK_TOOL_NAME = 'check';

/** 单次进程执行的输入（已由 check.ts 完成参数契约校验与字面 argv 保证）。 */
export interface CheckProcessRequest {
  /** 可执行名称，或已按工作区授权解析出的绝对程序路径。 */
  program: string;
  /** 字面 argv：绝不拼接脚本，绝不交给解释器。 */
  args: string[];
  /** 已解析的绝对 cwd（必须在工作区内，沙箱再强制一次）。 */
  cwd: string;
  /** 工作区相对 cwd，仅用于事实与摘要展示（不泄漏宿主绝对路径）。 */
  cwdDisplay: string;
  timeoutMs: number;
}

export type PublishLog = (
  text: string,
  target: { workspaceRoot: string; toolName: string; runId: string },
) => string | null;

export interface CheckRunnerDeps {
  /** 注入执行器（测试用 platform 注入）；缺省 executeSandboxedProcess。 */
  executeProcess?: (request: SandboxedProcessRequest) => Promise<SandboxedProcessResult>;
  /** 日志发布（内容存储 + input/spill/ 硬链接）；失败返回 null。 */
  publishLog?: PublishLog;
  /** 受管 scratch 创建（测试可注入）。 */
  createScratch?: (scope: string) => ShellScratch;
  /** 采集上限字节数（默认 8MiB）。 */
  captureLimitBytes?: number;
  /** 平台注入：透传给执行器（缺省 = 当前平台）。 */
  platform?: NodeJS.Platform;
}

export type CheckRunReason =
  | 'exit-protocol'
  | 'structured-report'
  | 'capture-limit'
  | 'log-publish-failed'
  | 'timed-out'
  | 'signal-terminated'
  | 'report-invalid'
  | 'report-over-capacity';

export interface CheckRunOutcome {
  conclusion: CheckConclusion;
  reasons: CheckRunReason[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  logsComplete: boolean;
  stdoutRef?: string;
  stderrRef?: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** null = 未取得结构化诊断；[] = 有效报告确实没有诊断。两者不可互换。 */
  diagnostics: Diagnostic[] | null;
  reportComplete: boolean;
  /** 由 facts 校验得出：是否允许参与比较 / 被后续调用复用（§5.3 消费规则）。 */
  comparable: boolean;
  reusable: boolean;
  /** 实际启动的进程数：C01/C04 用它证明"没有为了换 tail 而重跑"。 */
  processRuns: number;
  executor: SandboxedProcessResult['executor'] | null;
  /** 组装好的 facts；结构校验不过则为 null（不记录不可信事实）。 */
  facts: ToolFacts | null;
  factsIssues: string[];
  resolvedProgram: string | null;
  cwdDisplay: string;
  /**
   * 同一次调用内已采集的完整日志文本（**进程内私有**：facts 与摘要只携带引用与
   * 有界切片，序列化进 trace/Checkpoint 的是 content，不是这两个字段）。
   */
  stdoutText: string;
  stderrText: string;
}

/** 结构化 stdout 报告的解析结果。 */
export type CheckReportParseResult =
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }
  | {
      state: 'valid';
      profile: CheckProfileName;
      conclusion: CheckConclusion;
      diagnostics: Diagnostic[] | null;
      reportComplete: boolean;
      overCapacity: boolean;
    };

const STDOUT_LOG_NAME = 'payaso-check-stdout.log';
const STDERR_LOG_NAME = 'payaso-check-stderr.log';

function utf8SafeSlice(chunk: Buffer, maxBytes: number): Buffer {
  if (chunk.length <= maxBytes) return chunk;
  let end = maxBytes;
  // 不在 UTF-8 续字节中间切断（与 tool-output-budget 同一原则）。
  while (end > 0 && (chunk[end] & 0xc0) === 0x80) end--;
  return chunk.subarray(0, end);
}

/**
 * 单次 check 的原始日志采集器：按流写入 scratch 文件，共享 8MiB 总上限。
 * 超限后停止追加但保留已采集内容 —— inconclusive 的依据必须可复查。
 */
class ScratchLogCollector {
  private stdoutFd: number | null = null;
  private stderrFd: number | null = null;
  private collected = 0;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  overflowed = false;
  writeFailed = false;

  constructor(
    private readonly scratchDir: string,
    private readonly limit: number,
  ) {}

  open(): void {
    this.stdoutFd = fs.openSync(path.join(this.scratchDir, STDOUT_LOG_NAME), 'wx');
    this.stderrFd = fs.openSync(path.join(this.scratchDir, STDERR_LOG_NAME), 'wx');
  }

  push(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.collected >= this.limit) {
      this.overflowed = true;
      return;
    }
    const data = utf8SafeSlice(chunk, this.limit - this.collected);
    if (data.length < chunk.length) this.overflowed = true;
    const fd = stream === 'stdout' ? this.stdoutFd : this.stderrFd;
    if (fd === null) {
      this.writeFailed = true;
      return;
    }
    try {
      fs.writeSync(fd, data);
    } catch {
      this.writeFailed = true;
      return;
    }
    this.collected += data.length;
    if (stream === 'stdout') this.stdoutBytes += data.length;
    else this.stderrBytes += data.length;
  }

  close(): void {
    for (const fd of [this.stdoutFd, this.stderrFd]) {
      if (fd === null) continue;
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
    this.stdoutFd = null;
    this.stderrFd = null;
  }

  /** 读回已采集的原始日志（scratch 由调用方在发布后清理）。 */
  read(stream: 'stdout' | 'stderr'): string {
    const file = path.join(
      this.scratchDir,
      stream === 'stdout' ? STDOUT_LOG_NAME : STDERR_LOG_NAME,
    );
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      this.writeFailed = true;
      return '';
    }
  }

  sizes(): { stdoutBytes: number; stderrBytes: number } {
    return { stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes };
  }
}

/**
 * 解析 stdout 中的结构化检查报告（JSON 适配只读 stdout；stderr 单独保留）。
 * fail-closed：字段缺失、类型不符、诊断非法一律 `invalid` —— 调用方据此给出
 * inconclusive，绝不把"没解析出来"写成"零诊断"或"通过"。
 */
export function parseCheckReport(stdoutText: string): CheckReportParseResult {
  const trimmed = stdoutText.trim();
  if (trimmed === '') return { state: 'absent' };
  if (trimmed.startsWith('{')) return parseReportObject(trimmed);
  const candidateLine = lastJsonObjectLine(trimmed);
  if (candidateLine === null) return { state: 'absent' };
  return parseReportObject(candidateLine);
}

function lastJsonObjectLine(text: string): string | null {
  // 报告适配发生在**已采集完整的同一份日志文本**上，不是"重跑取 tail"：这里没有
  // 任何进程执行，只是对同一份事实做一次有界的尾部扫描。
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line.startsWith('{') && line.endsWith('}')) return line;
  }
  return null;
}

function parseReportObject(raw: string): CheckReportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'invalid', reason: 'stdout 报告不是合法 JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'absent' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind !== CHECK_REPORT_KIND) return { state: 'absent' };
  if (record.version !== 1) {
    return { state: 'invalid', reason: `报告版本不受支持: ${String(record.version)}` };
  }
  if (record.profile !== 'process' && record.profile !== 'biome-lint') {
    return { state: 'invalid', reason: `报告 profile 不受支持: ${String(record.profile)}` };
  }
  const conclusion = record.conclusion;
  if (conclusion !== 'passed' && conclusion !== 'failed' && conclusion !== 'inconclusive') {
    // 缺字段就是缺字段：不默认成 passed，也不默认成"零诊断"。
    return { state: 'invalid', reason: `报告缺少有效 conclusion: ${String(conclusion)}` };
  }
  if (typeof record.reportComplete !== 'boolean') {
    return { state: 'invalid', reason: '报告缺少 reportComplete 布尔字段' };
  }
  if (record.diagnostics !== null && !Array.isArray(record.diagnostics)) {
    return { state: 'invalid', reason: '报告 diagnostics 必须是 null 或数组' };
  }
  let overCapacity = false;
  let diagnostics: Diagnostic[] | null = null;
  if (Array.isArray(record.diagnostics)) {
    const kept: Diagnostic[] = [];
    for (let index = 0; index < record.diagnostics.length; index++) {
      const coerced = coerceDiagnostic(record.diagnostics[index]);
      if (!coerced.ok) return { state: 'invalid', reason: coerced.reason };
      if (kept.length < MAX_DIAGNOSTICS_PER_RECORD) {
        kept.push(coerced.diagnostic);
        continue;
      }
      // 超容量：保留有界切片 + 报告不完整 + 禁止比较与复用（§5.3 消费规则）。
      overCapacity = true;
      break;
    }
    diagnostics = kept;
  }
  return {
    state: 'valid',
    profile: record.profile,
    conclusion,
    diagnostics,
    reportComplete: record.reportComplete && !overCapacity,
    overCapacity,
  };
}

function coerceDiagnostic(
  raw: unknown,
): { ok: true; diagnostic: Diagnostic } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: '诊断条目必须是对象' };
  }
  const d = raw as Record<string, unknown>;
  const pathValue = d.path;
  if (!isWorkspaceRelativePath(pathValue)) {
    return { ok: false, reason: `诊断 path 必须是工作区相对路径: ${String(d.path)}` };
  }
  const rule = d.rule;
  if (typeof rule !== 'string' || rule === '') {
    return { ok: false, reason: '诊断缺少 rule' };
  }
  const severity = d.severity;
  if (severity !== 'error' && severity !== 'warning' && severity !== 'info') {
    return { ok: false, reason: `诊断 severity 不受支持: ${String(severity)}` };
  }
  const message = d.message;
  const primarySnippet = d.primarySnippet;
  if (typeof message !== 'string' || typeof primarySnippet !== 'string') {
    return { ok: false, reason: '诊断 message/primarySnippet 必须是字符串' };
  }
  const relatedSnippets = d.relatedSnippets;
  if (
    !Array.isArray(relatedSnippets) ||
    !relatedSnippets.every((snippet) => typeof snippet === 'string')
  ) {
    return { ok: false, reason: '诊断 relatedSnippets 必须是字符串数组' };
  }
  const fingerprint = d.fingerprint;
  if (!isStableDiagnosticFingerprint(fingerprint)) {
    return {
      ok: false,
      reason: `诊断 fingerprint 不是稳定的逻辑指纹（禁止临时绝对路径/行号）: ${String(fingerprint)}`,
    };
  }
  return {
    ok: true,
    diagnostic: {
      path: pathValue,
      rule,
      severity,
      message,
      primarySnippet,
      relatedSnippets: relatedSnippets as string[],
      fingerprint,
    },
  };
}

/**
 * 执行一次 process 检查并给出结论 + facts。抛错情形（调用方保留原语义）：
 * - RequiredRuntimeToolUnavailableError：程序缺失 / 不可解析（执行器抛出）
 * - Error：沙箱不可用、沙箱拒绝（fail-closed，不产生任何通过记录）
 * - AbortError：用户取消（沿原取消路径退出）
 */
export async function runCheckProcess(
  request: CheckProcessRequest,
  context: ToolContext,
  deps: CheckRunnerDeps = {},
): Promise<CheckRunOutcome> {
  const executeProcess = deps.executeProcess ?? executeSandboxedProcess;
  const publishLog = deps.publishLog ?? ((text, target) => spillToolOutput(text, target));
  const createScratch = deps.createScratch ?? ((scope: string) => createShellScratch(scope));
  const limit = deps.captureLimitBytes ?? CHECK_LOG_CAPTURE_MAX_BYTES;

  const scratch = createScratch(context.runId);
  const collector = new ScratchLogCollector(scratch.path, limit);
  let processRuns = 0;
  let result: SandboxedProcessResult | null = null;
  let cancelled: unknown = null;
  try {
    collector.open();
    processRuns = 1;
    result = await executeProcess({
      program: request.program,
      args: request.args,
      workspaceRoot: context.workspaceRoot,
      cwd: request.cwd,
      permissionMode: context.writeScope !== undefined ? 'read-only' : context.permissionMode,
      networkMode: context.networkMode,
      scratch,
      timeoutMs: request.timeoutMs,
      signal: context.signal,
      platform: deps.platform,
      onRawChunk: (stream, chunk) => collector.push(stream, chunk),
      onOutput: livePreview(context.onShellOutput),
      onSandboxEvent: context.onSandboxEvent,
    });
  } catch (err) {
    // 取消：沿原取消路径退出 —— 不计为检查失败，也不生成任何通过记录。
    if (isAbortLike(err)) cancelled = err;
    else throw err;
  } finally {
    collector.close();
  }

  if (cancelled) {
    scratch.dispose();
    throw cancelled;
  }
  const finished = result as SandboxedProcessResult;
  if (finished.denied) {
    // 沙箱拒绝保持与 Shell 一致的错误语义（不把 stderr / 宿主路径暴露给模型），
    // 并且不产生任何检查通过记录。
    scratch.dispose();
    throw new Error(
      'Check denied by the workspace sandbox (filesystem policy): the process attempted to access ' +
        'paths outside the allowed roots. The check is inconclusive; no pass record was created.',
    );
  }

  const outcome = finishRun({
    request,
    context,
    collector,
    result: finished,
    processRuns,
    publishLog,
  });
  scratch.dispose();
  return outcome;
}

/** v2.4 前台实时输出预览：与 shell 共用同一预算封顶，避免刷屏打满 SSE 通道。 */
function livePreview(onOutput?: (chunk: string) => void): ((text: string) => void) | undefined {
  if (!onOutput) return undefined;
  const maxBytes = resolveToolOutputBudget().maxBytes;
  let forwarded = 0;
  return (text: string) => {
    if (forwarded >= maxBytes || !text) return;
    const remaining = maxBytes - forwarded;
    const slice = text.length <= remaining ? text : text.slice(0, remaining);
    forwarded += slice.length;
    onOutput(slice);
  };
}

function isAbortLike(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

interface FinishInput {
  request: CheckProcessRequest;
  context: ToolContext;
  collector: ScratchLogCollector;
  result: SandboxedProcessResult;
  processRuns: number;
  publishLog: PublishLog;
}

function finishRun(input: FinishInput): CheckRunOutcome {
  const { request, context, collector, result, processRuns, publishLog } = input;
  const sizes = collector.sizes();
  const reasons: CheckRunReason[] = [];
  const stdoutText = collector.read('stdout');
  const stderrText = collector.read('stderr');

  const captureIncomplete = collector.overflowed || collector.writeFailed;
  if (collector.overflowed) reasons.push('capture-limit');
  if (collector.writeFailed) reasons.push('log-publish-failed');

  // 退出后才发布日志引用：复用附件内容存储 + input/spill/ 硬链接发布，stdout / stderr
  // 各成一份可独立读回的完整日志；scratch 随后由调用方清理（单次调用生命周期）。
  const target = {
    workspaceRoot: context.workspaceRoot,
    toolName: CHECK_TOOL_NAME,
    runId: context.runId,
  };
  let stdoutRef: string | undefined;
  let stderrRef: string | undefined;
  let publishFailed = false;
  if (stdoutText.length > 0) {
    const ref = publishLog(stdoutText, target);
    if (ref) stdoutRef = ref;
    else publishFailed = true;
  }
  if (stderrText.length > 0) {
    const ref = publishLog(stderrText, target);
    if (ref) stderrRef = ref;
    else publishFailed = true;
  }
  if (publishFailed) reasons.push('log-publish-failed');

  // 采集超限或发布失败都意味着"完整证据不可得"：结论必须 inconclusive，
  // 但退出码照常保留（日志发布失败不丢退出码）。
  const logsComplete = !captureIncomplete && !publishFailed;

  let conclusion: CheckConclusion = 'inconclusive';
  let diagnostics: Diagnostic[] | null = null;
  let reportComplete = logsComplete;

  // JSON 适配只读 stdout；stderr 单独保留（不参与解析）。
  const report =
    stdoutText.length > 0 ? parseCheckReport(stdoutText) : ({ state: 'absent' } as const);

  if (result.timedOut) {
    reasons.push('timed-out');
    conclusion = 'inconclusive';
    reportComplete = false;
  } else if (report.state === 'invalid') {
    reasons.push('report-invalid');
    conclusion = 'inconclusive';
    diagnostics = null;
    reportComplete = false;
  } else if (report.state === 'valid') {
    reasons.push('structured-report');
    if (report.overCapacity) reasons.push('report-over-capacity');
    diagnostics = report.diagnostics;
    reportComplete = logsComplete && report.reportComplete;
    if (report.conclusion === 'passed' && result.exitCode !== 0) {
      // 报告自称通过但进程没有正常退出：两份证据矛盾，不采信任何一边。
      conclusion = 'inconclusive';
      reportComplete = false;
      reasons.push('exit-protocol');
    } else {
      conclusion = report.conclusion;
    }
  } else if (result.exitCode === null) {
    reasons.push('signal-terminated');
    conclusion = 'inconclusive';
    reportComplete = false;
  } else if (!logsComplete) {
    conclusion = 'inconclusive';
  } else {
    reasons.push('exit-protocol');
    conclusion = result.exitCode === 0 ? 'passed' : 'failed';
  }

  const facts: ToolFacts = {
    version: EXECUTION_EVIDENCE_VERSION,
    process: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      logsComplete,
      ...(stdoutRef ? { stdoutRef } : {}),
      ...(stderrRef ? { stderrRef } : {}),
    },
    check: {
      profile: 'process',
      conclusion,
      diagnostics,
      reportComplete,
    },
  };

  // facts 校验落点（本批次）：产出方在返回前自证 —— 不合法的 facts 一律不外传。
  // 消费侧（批次 C 的 execution-evidence-store）会再校验一次版本/字段/路径/大小。
  const validation = validateToolFacts(facts);

  return {
    conclusion,
    reasons,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    logsComplete,
    stdoutRef,
    stderrRef,
    stdoutBytes: sizes.stdoutBytes,
    stderrBytes: sizes.stderrBytes,
    diagnostics,
    reportComplete,
    comparable: validation.comparable,
    reusable: validation.reusable,
    processRuns,
    executor: result.executor,
    facts: validation.valid ? validation.facts : null,
    factsIssues: validation.issues,
    resolvedProgram: result.resolvedProgram,
    cwdDisplay: request.cwdDisplay,
    stdoutText,
    stderrText,
  };
}
