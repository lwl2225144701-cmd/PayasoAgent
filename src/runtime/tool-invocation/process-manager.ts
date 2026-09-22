// 模块: ToolInvocation ProcessManager —— 一次工具调用的完整生命周期。
//
// 为什么单独存在：工具调用管道（parse → resolve → schema 校验 → JIT 审批 →
// side-effect 判定 → 防死循环 → execute → 结果校验 → output guard → 有界重试 →
// 失败恢复）是 runAgent 里最重的一段，包含封闭的安全顺序（授权、Intent、
// 执行、结果校验、Checkpoint、Abort 不可重排）。独立成模块后该顺序有唯一
// owner，runAgent 主循环只保留「逐 call 调用」的编排。
//
// 边界：只消费注入的 ToolInvocationContext（由 runAgent 装配），不反向依赖
// agent.ts；本模块不拥有可变状态（State/Scratchpad/Messages 均为引用传入）。

import type { AgentContextHarness } from '../../harness/context-harness.js';
import type { ChatMessage } from '../../llm/llm.js';
import { getNetworkMode } from '../../network-mode.js';
import type { ToolchainPreparationPort } from '../../sandbox/toolchain-preparation.js';
import { getToolchainPreparationPlan } from '../../sandbox/toolchain-preparation.js';
import { formatToolArgumentIssues, validateToolArguments } from '../../tools/tool-arguments.js';
import {
  execute,
  getTool,
  invalidToolArgumentsError,
  NetworkDeniedError,
  needsNetworkApproval,
  normalizeToolResult,
  parseToolArguments,
  RequiredRuntimeToolUnavailableError,
  resolveToolEffect,
  type Tool,
  type ToolCallError,
  type ToolContext,
  type ToolImage,
  type ToolSandboxEvent,
  toolNotFoundError,
  validateToolResult,
} from '../../tools/tools.js';
import { isAbortError } from '../../util/abort.js';
import {
  clampTimeoutMs,
  createDeadline,
  positiveIntMs,
  TimeoutAbortError,
  type TimeoutPolicy,
} from '../../util/timeout.js';
import { type ApprovalPort, resolveApprovalPort } from '../approval-port.js';
import type { RuntimeObserver } from '../observer-port.js';
import { guardToolOutput } from '../output-guard.js';
import {
  clearFailure,
  completeStep,
  isBlocked,
  recordFailure,
  recordInvalid,
  type Scratchpad,
  setNextStep,
} from '../scratchpad.js';
import {
  markExecuted,
  operationIdentity,
  resolveOperation,
  type SideEffectGuard,
} from '../side-effect.js';
import { type AgentState, updateState } from '../state.js';
import { classifyToolError } from '../tool-error-classifier.js';
import type { TraceEventInput } from '../trace.js';
import { ToolInvocationStateMachine } from './state-machine.js';

/** 工具执行最大重试次数（总尝试 = 1 + MAX_RETRY）。 */
export const MAX_RETRY = 2;

// ---- v2.3 工具级超时预算（docs/plans/long-task-timeout-plan.md 步骤 3）----
// 超时由"声明预算的工具"负责，不由 Agent Loop 统一计时：
// - Tool.timeoutMs 声明自己的 deadline（函数形式可参考运行时策略，如 shell）；
// - 未声明 → 全局策略默认（env 可覆盖）；
// - 到期以 TimeoutAbortError 中止本次调用，返回结构化 TOOL_TIMEOUT（不重试）；
// - 用户取消仍以标准 AbortError 传播，两者语义永不混淆。
const TOOL_TIMEOUT_DEFAULT_MS = 300_000;
const TOOL_TIMEOUT_MIN_MS = 1_000;
const TOOL_TIMEOUT_MAX_MS = 3_600_000;

export function toolTimeoutPolicy(
  env: Record<string, string | undefined> = process.env,
): TimeoutPolicy {
  const maxMs = Math.max(
    positiveIntMs(env.PAYASO_TOOL_TIMEOUT_MAX_MS) ?? TOOL_TIMEOUT_MAX_MS,
    TOOL_TIMEOUT_MIN_MS,
  );
  const defaultMs = Math.max(
    positiveIntMs(env.PAYASO_TOOL_TIMEOUT_MS) ?? TOOL_TIMEOUT_DEFAULT_MS,
    TOOL_TIMEOUT_MIN_MS,
  );
  return { defaultMs, minMs: TOOL_TIMEOUT_MIN_MS, maxMs: Math.max(maxMs, defaultMs) };
}

/** 解析一次工具调用的 deadline：声明值（可能随 context 变化）收敛进全局策略。 */
export function resolveToolTimeoutMs(tool: Tool, context: ToolContext): number {
  const declared = typeof tool.timeoutMs === 'function' ? tool.timeoutMs(context) : tool.timeoutMs;
  return clampTimeoutMs(declared, toolTimeoutPolicy());
}

export interface ToolInvocationContext {
  runId: string;
  toolContext: ToolContext;
  messages: ChatMessage[];
  state: AgentState;
  scratchpad: Scratchpad;
  sideEffectGuard: SideEffectGuard;
  contextHarness: AgentContextHarness;
  signal?: AbortSignal;
  approvalPort: ApprovalPort | undefined;
  toolchainPreparationPort: ToolchainPreparationPort | undefined;
  emit: (input: TraceEventInput) => void;
  // v2.4 前台 shell 流式输出：工具执行期的 stdout/stderr 增量回调（由 agent loop
  // 接进 onStreamDelta，messageId = 本次工具调用 id）。缺省 = 不流式，行为与旧版一致。
  onToolOutput?: (chunk: string) => void;
  save: (status?: string) => void;
  observer: RuntimeObserver;
  observeState: (detail: 'summary' | 'full') => void;
  observeScratchpad: () => void;
  pushToolCallError: (toolCallId: string, toolName: string, error: ToolCallError) => void;
}

interface ToolCallShape {
  id: string;
  function: { name: string; arguments: string };
}

/**
 * 执行一次工具调用（含重试 + 失败恢复 + 防死循环）。
 * 返回即表示该 call 处理完毕（成功 / 无效 / 拒绝 / 恢复消息已回传 LLM）；
 * 仅在 abort 时向上抛出（由 Host 落 stopped，不写恢复消息）。
 */
export async function invokeToolCall(
  ctx: ToolInvocationContext,
  call: ToolCallShape,
): Promise<void> {
  const lifecycle = new ToolInvocationStateMachine();
  const {
    runId,
    toolContext,
    messages,
    state,
    scratchpad,
    sideEffectGuard,
    contextHarness,
    signal,
    emit,
    save,
    observer,
    observeState,
    observeScratchpad,
    pushToolCallError,
    onToolOutput,
  } = ctx;
  const toolName = call.function.name;

  // v1.6 Tool Call Pipeline ①②：Parse + Validate。
  // malformed / 非 object 的 arguments 是可恢复 invocation error：
  // 工具绝不执行、side-effect 绝不创建，结构化错误回传模型修正。
  const parsed = parseToolArguments(call.function.arguments);
  if (!parsed.ok) {
    lifecycle.transition('invalid');
    pushToolCallError(call.id, toolName, parsed.error);
    return;
  }
  lifecycle.transition('parsed');
  const args = parsed.args;

  // v1.6 Pipeline ③：Resolve —— 未知工具同样是 invocation error，
  // 直接回传错误结果，不进入 execution retry（模型修正 ≠ 瞬态重试）。
  const toolDef = getTool(toolName);
  if (!toolDef) {
    lifecycle.transition('invalid');
    pushToolCallError(call.id, toolName, toolNotFoundError(toolName));
    return;
  }
  lifecycle.transition('resolved');

  // v1.8 Pipeline ③.5：Schema 校验 —— 声明的 Tool schema 是契约。
  // 未知参数/缺必填/类型错一律显式回传（绝不静默丢弃），否则模型会带着
  // 被忽略的意图继续跑（例如它以为传了 timeout 就延长了超时）。
  const argumentCheck = validateToolArguments(toolDef.parameters, args);
  if (!argumentCheck.ok) {
    lifecycle.transition('invalid');
    pushToolCallError(
      call.id,
      toolName,
      invalidToolArgumentsError(formatToolArgumentIssues(toolName, argumentCheck.issues)),
    );
    return;
  }
  lifecycle.transition('validated');

  // v1.9：副作用类别按本次调用解析（shell 只读命令不再被回放缓存结果）。
  // 后续所有 effect 判定统一使用 effect，不再直接读 toolDef.effect。
  const effect = resolveToolEffect(toolDef, args, toolContext);

  // v2.0.1 JIT Approval：ask 模式 + 网络工具 → 执行前即时授权。
  // 批准通过才继续（不创建 side-effect）；拒绝/超时走 NetworkDenied 语义。
  if (needsNetworkApproval(toolDef, getNetworkMode())) {
    lifecycle.transition('authorization_pending');
    const approved = await resolveApprovalPort(ctx.approvalPort).request({
      runId,
      toolName,
      args,
      timestamp: new Date().toISOString(),
    });
    if (!approved) {
      lifecycle.transition('denied');
      const deniedMsg =
        `Tool "${toolName}" requires network access but approval was not granted (network.mode=ask). ` +
        `Ask the user to approve this network call or switch network mode to "on".`;
      observer.log(`[Approval Denied] ${toolName}: ${deniedMsg}`);
      // 审计：拒绝事件（network:"denied"），非执行失败、不创建副作用
      emit({
        type: 'tool_error',
        tool: toolName,
        error: deniedMsg,
        attempt: 1,
        exhausted: true,
        network: 'denied',
      });
      updateState(state, {
        currentStep: 'tool_error',
        currentError: deniedMsg,
        lastToolError: {
          tool: toolName,
          input: JSON.stringify(args),
          error: deniedMsg,
          retries: 1,
        },
      });
      observeState('summary');
      save();
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: deniedMsg,
      });
      return; // 不执行本工具，继续处理剩余 tool_calls / 下一轮 LLM
    }
    lifecycle.transition('authorized');
    // 批准通过 → 继续执行。审计口径：
    // - tool_call 事件带 network:"ask"（请求发起时的模式）
    // - 拒绝路径已由上方 tool_error(network:"denied") 记录
    // - 批准耗时由 tool_result 的 durationMs 统一覆盖（执行含批准等待）
  }
  if (lifecycle.state.phase === 'validated') lifecycle.transition('authorized');
  lifecycle.transition('effect_checked');

  // 规范化输入：calculator 用表达式原文；其余工具用规范化 JSON（消除 LLM 序列化空白差异，
  // 否则同参数换空格写法可绕过 isBlocked 的防重调/防死循环判定）
  const input = 'expression' in args ? String(args.expression) : JSON.stringify(args);

  // v1.3.2 Side-Effect Safety：non_idempotent 操作生命周期 ——
  //   succeeded  → 回放首次结果，不执行
  //   executing / uncertain → 不执行，返回明确 uncertain recovery 信息（不伪造成功）
  //   start      → 正常开始（execute 前持久化 executing，见下）
  // 置于防死循环判定之前。
  if (effect === 'non_idempotent') {
    // 注入 ToolContext（runId + workspaceRoot）供路径工具归一化 identity；LLM 不可覆盖
    const disposition = resolveOperation(sideEffectGuard, toolDef, args, toolContext, effect);
    if (disposition.kind === 'replay') {
      lifecycle.transition('replayed');
      observer.log(
        `[Side-Effect Skip] ${toolName} 操作已成功执行过（同一 canonical operation key），回放结果，不重复执行副作用`,
      );
      emit({
        type: 'side_effect_skip',
        tool: toolName,
        key: operationIdentity(toolDef, args, toolContext),
        replayed: true,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: disposition.result });
      return;
    }
    if (disposition.kind === 'uncertain') {
      lifecycle.transition('uncertain');
      const uncertainMsg =
        `工具 ${toolName} 该操作（canonical key=${operationIdentity(toolDef, args, toolContext)}）` +
        `此前已开始执行但结果不确定（executing/uncertain），Runtime 不会再次自动执行以防重复副作用。` +
        `请勿再次使用相同参数调用；请修正参数、换其他方法或向用户说明。`;
      observer.log(`[Side-Effect Uncertain] ${uncertainMsg}`);
      emit({
        type: 'side_effect_uncertain',
        tool: toolName,
        key: operationIdentity(toolDef, args, toolContext),
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: uncertainMsg });
      return;
    }
  }

  // 防死循环：相同 tool + 相同参数已失败超过重试次数 → 禁止再次调用
  if (isBlocked(scratchpad, toolName, input, MAX_RETRY)) {
    lifecycle.transition('blocked');
    const blockMsg = `工具 ${toolName} 参数 "${input}" 已产生无效结果或失败超过重试次数，禁止再次调用相同参数。请修正参数、换其他方法或向用户说明原因。`;
    observer.log(`[Blocked] ${blockMsg}`);

    // State: 记录被禁状态（不推进步骤）
    updateState(state, {
      currentStep: 'tool_blocked',
      currentError: '重复无效/失败被禁止调用',
      lastToolError: {
        tool: toolName,
        input,
        error: '重复无效/失败被禁止调用',
        retries: MAX_RETRY + 1,
      },
    });
    observeState('summary');

    // 将禁止消息返回 LLM，由其重新决策
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: blockMsg,
    });
    return;
  }

  // State: 调用工具前（总调用次数 +1，记录待执行动作）
  updateState(state, {
    currentStep: `tool_call:${toolName}`,
    toolCalls: state.toolCalls + 1,
    pendingAction: { tool: toolName, input },
  });
  observeState('summary');

  observer.log(`[Tool 调用] ${toolName}(${call.function.arguments})`);

  // Scratchpad: 记录计划执行的下一步（未完成，不进 completedSteps）
  setNextStep(scratchpad, { tool: toolName, input });

  // Trace: 工具调用前（v2.0 审计：记录本次调用时的全局网络模式）
  // 网络工具的调用一律记录 network 字段；非网络工具恒为 "on"（不受开关影响）。
  emit({ type: 'tool_call', tool: toolName, args, network: getNetworkMode() });

  // 工具执行 + 重试（最多 MAX_RETRY 次）；重试耗尽进入失败恢复
  // v1.3.1 修复：non_idempotent（高风险副作用）禁止自动 Retry ——
  // execute 一旦开始执行，throw 时无法判定副作用是否已发生；盲目重跑会导致同一副作用重复执行。
  // 首次失败直接进入 Recovery，由 LLM 决策。read / idempotent 保持原重试行为。
  // v1.3.2：non_idempotent 开始执行前先持久化 executing 状态；
  //   persist(executing) 失败 → 禁止 execute，作为 Runtime 错误处理（防止无保护的副作用执行）。
  if (effect === 'non_idempotent') {
    lifecycle.transition('intent_persisting');
    const opKey = operationIdentity(toolDef, args, toolContext);
    sideEffectGuard.begin(opKey);
    try {
      save();
    } catch (persistErr) {
      lifecycle.transition('failed');
      const persistMsg = `[Side-Effect Persist Failed] 无法持久化 operation executing 状态（${opKey}），禁止执行 non_idempotent 工具: ${(persistErr as Error).message}`;
      observer.log(persistMsg);
      throw new Error(persistMsg);
    }
    lifecycle.transition('intent_persisted');
  }
  const effectiveRetries = effect === 'non_idempotent' ? 0 : MAX_RETRY;
  // v2.3 工具级超时（docs/plans/long-task-timeout-plan.md 步骤 3）：每次调用一个派生
  // deadline。Tool 声明 / 全局策略的预算内未 settle → 以 TimeoutAbortError 中止
  // 本次调用并返回结构化 TOOL_TIMEOUT；用户取消经由父信号仍以标准 AbortError
  // 传播（语义与 v1.6 取消路径一致）。execute settle 即释放 timer 与上游监听。
  const deadlineMs = resolveToolTimeoutMs(toolDef, toolContext);
  const deadline = createDeadline(
    signal,
    deadlineMs,
    () => new TimeoutAbortError('tool', `Tool "${toolName}" exceeded its ${deadlineMs}ms budget`),
  );
  for (let attempt = 1; attempt <= effectiveRetries + 1; attempt++) {
    try {
      lifecycle.transition('executing');
      const start = performance.now();
      // ToolContext 由 Runtime 注入：runId/workspaceRoot 均不可见、不可通过 args 覆盖
      const rawResult = await execute(toolName, args, {
        ...toolContext,
        // 本次调用的 deadline 信号：工具需监听并尽快终止；
        // runSignal 保留原始 Run 取消信号（后台作业等长生命周期用途）。
        signal: deadline.signal,
        runSignal: toolContext.runSignal ?? signal,
        // 前台 shell 增量输出（仅 shell 工具消费；其他工具忽略）。Runtime-only：
        // 不进 LLM Schema，也不作为工具返回值。
        onShellOutput: onToolOutput,
        onSandboxEvent: (event: ToolSandboxEvent) => {
          if (event.type === 'shell_sandbox_started') {
            emit({
              type: 'shell_sandbox_started',
              platform: event.platform,
              // enforcement 仅 windows-acl 携带；macOS 事件形状保持不变。
              ...(event.enforcement !== undefined ? { enforcement: event.enforcement } : {}),
            });
          } else {
            emit({
              type: 'shell_sandbox_denied',
              platform: event.platform,
              reason: event.reason,
            });
          }
        },
      }).finally(() => deadline.dispose());
      const durationMs = Math.round((performance.now() - start) * 100) / 100;

      // 多模态结果归一：文本部分走 validation/guard/状态；图片引用
      // （工作区相对路径）直接挂到 tool 消息与 trace，下轮物化进模型。
      const normalized = normalizeToolResult(rawResult);
      const attachedImages: ToolImage[] | undefined = normalized.images;

      // ---- v1.2 Tool Result Validation：执行成功 ≠ 结果有效（validateResult 必须看到完整 raw）----
      const vr = validateToolResult(toolName, rawResult);

      // ---- v1.3.3 Tool Output Guard：validation 之后，任何进入 Runtime 状态 / LLM Context 的内容一律受限 ----
      const guarded = guardToolOutput(normalized.text);
      if (guarded.truncated) {
        emit({
          type: 'tool_output_truncated',
          tool: toolName,
          originalBytes: guarded.originalBytes,
          returnedBytes: guarded.returnedBytes,
        });
      }
      const result = guarded.content; // 后续所有使用处（trace/scratchpad/messages/recovery）均为受限结果
      observer.log(`[Tool 返回] ${result}`);

      // v1.3 Side-Effect Safety：非幂等 execute 成功后记录操作身份（记录受限结果，防回放大内容）
      if (toolDef) markExecuted(sideEffectGuard, toolDef, args, result, toolContext, effect);

      // State: 工具执行成功（execute 维度，先于结果有效性判定）
      updateState(state, {
        successfulToolCalls: state.successfulToolCalls + 1,
        currentStep: 'tool_result',
        pendingAction: undefined,
        currentError: undefined,
      });
      observeState('summary');

      if (!vr.valid) {
        // 结果无效：不进 completedSteps、不计入失败，单独计入 invalidToolResults
        updateState(state, {
          invalidToolResults: state.invalidToolResults + 1,
          currentStep: 'tool_result_invalid',
          currentError: `结果无效: ${vr.reason ?? ''}`,
        });
        observeState('summary');

        // Trace: 结果无效事件（区别于 tool_result / tool_error）
        emit({
          type: 'tool_result_invalid',
          tool: toolName,
          result,
          reason: vr.reason ?? '结果无效',
        });

        // Scratchpad: 记录无效结果（不进 completedSteps）
        recordInvalid(scratchpad, {
          tool: toolName,
          input,
          result,
          reason: vr.reason ?? '结果无效',
        });
        observeScratchpad();

        // 将"执行成功但结果无效"作为恢复消息回传 LLM，由其业务决策
        const recoveryMsg =
          `工具 ${toolName} 执行成功，但返回结果不可用于后续任务。\n` +
          `工具：${toolName}\n` +
          `结果：${typeof result === 'string' ? result : JSON.stringify(result)}\n` +
          `原因：${vr.reason ?? '结果无效'}\n` +
          `请根据当前任务决定：1) 是否重新调用工具（如更换参数）；2) 是否换其他方法；` +
          `3) 是否停止依赖该结果的后续步骤；4) 是否向用户说明无法继续。`;
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: recoveryMsg,
        });
        // Checkpoint: 结果无效时保存
        save();
        lifecycle.transition('invalid_result');
        return; // 工具本身未抛错，无需重试
      }

      // Trace: 工具结果（含耗时，仅结果有效时记录 tool_result）
      emit({
        type: 'tool_result',
        tool: toolName,
        result,
        durationMs,
        ...(attachedImages ? { images: attachedImages } : {}),
        network: getNetworkMode(),
      });

      // Scratchpad: 工具成功 → 当前步骤移入 completedSteps，清空 nextStep，并解禁该参数
      completeStep(scratchpad, result);
      clearFailure(scratchpad, toolName, input);
      observeScratchpad();
      emit({
        type: 'scratchpad_update',
        currentStep: scratchpad.nextStep
          ? `${scratchpad.nextStep.tool}(${scratchpad.nextStep.input})`
          : '(等待 LLM 决策)',
        completedSteps: scratchpad.completedSteps.length,
        lastResult: scratchpad.lastResult,
      });

      // 4. 将工具结果返回给 LLM（文本 + 图片路径引用；base64 下轮物化）
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
        ...(attachedImages ? { images: attachedImages } : {}),
      });
      // Checkpoint: 工具成功后保存
      save();
      lifecycle.transition('succeeded');
      return; // 成功，跳出重试
    } catch (err) {
      // v2.0 Network Capability Check 拒绝：网络工具在网络关闭时被 policy 拦截。
      // 语义 = 拒绝执行（非执行失败）：
      // - 不进入 failedSteps / 不创建 side-effect uncertain（工具根本没有执行）
      // - 不重试（网络开关是全局配置，重试无意义）
      // - 审计：tool_error 事件带 network:"denied"，明确记录拒绝
      // - 将明确错误返回 LLM，由其决定换方法或请用户开启网络
      if (err instanceof NetworkDeniedError) {
        lifecycle.transition('denied');
        const deniedMsg = err.message;
        observer.log(`[Network Denied] ${toolName}: ${deniedMsg}`);
        // 审计（拒绝也进 Trace；网络字段清晰标识被拦）
        emit({
          type: 'tool_error',
          tool: toolName,
          error: deniedMsg,
          attempt,
          exhausted: true,
          network: 'denied',
        });
        updateState(state, {
          currentStep: 'tool_error',
          currentError: deniedMsg,
          lastToolError: { tool: toolName, input, error: deniedMsg, retries: attempt },
        });
        observeState('summary');
        save();
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: deniedMsg,
        });
        return; // 政策性拒绝，不重试
      }

      // v2.3 工具级超时：deadline 在预算内到点（execute 仍挂在途）。
      // 与用户取消严格区分：不进 AbortError 终态，而是结构化 TOOL_TIMEOUT
      // 回传模型（不重试——同参数重试通常只是再烧一轮预算）。
      if (deadline.signal.aborted && deadline.signal.reason instanceof TimeoutAbortError) {
        if (effect === 'non_idempotent') {
          sideEffectGuard.markUncertain(operationIdentity(toolDef, args, toolContext));
          lifecycle.transition('uncertain');
        } else {
          lifecycle.transition('timed_out');
        }
        const timeoutMsg =
          `TOOL_TIMEOUT: 工具 ${toolName} 在 ${deadlineMs}ms 预算内未完成，Runtime 已停止等待。` +
          `这不是业务失败：若该操作需要更长时间（长构建/大数据处理），请改用后台执行（shell background=true 或 shellJob），` +
          `或拆分任务后重试；不建议用相同参数立即重试。`;
        observer.log(`[Tool 超时] ${toolName} 超过 ${deadlineMs}ms 预算，返回 TOOL_TIMEOUT`);
        emit({
          type: 'tool_error',
          tool: toolName,
          error: timeoutMsg,
          attempt,
          exhausted: true,
          network: getNetworkMode(),
          timeout: 'tool',
        });
        updateState(state, {
          currentStep: 'tool_timeout',
          currentError: timeoutMsg,
          lastToolError: { tool: toolName, input, error: timeoutMsg, retries: attempt },
        });
        observeState('summary');
        save();
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: timeoutMsg,
        });
        return; // 本 call 处理完毕（不重试），外层循环继续 → LLM 重新决策
      }

      let msg = (err as Error).message;
      observer.log(`[Tool 错误] ${toolName}: ${msg}`);

      // Missing executable is a preparation opportunity, not a reason to
      // widen the Shell sandbox or to retry the same non-idempotent call.
      // The Host may pause here for explicit approval and run a fixed,
      // allowlisted macOS installer outside the Shell sandbox.
      if (err instanceof RequiredRuntimeToolUnavailableError) {
        lifecycle.transition('dependency_preparation');
        const plan = getToolchainPreparationPlan(err.toolName);
        if (plan !== undefined && ctx.toolchainPreparationPort) {
          try {
            const preparation = await ctx.toolchainPreparationPort.request(
              {
                runId,
                toolName: plan.toolName,
                packageName: plan.packageName,
                source: plan.source,
                timestamp: new Date().toISOString(),
              },
              signal,
            );
            if (preparation.prepared) {
              // v1.6 工具链闭环：Host 随准备结果带回刷新后的能力快照 →
              // 刷新 Harness 模型视图，下一轮即感知新工具。原命令不自动重试
              // （Side-Effect Safety：uncertain 保守拦截），由用户显式重试。
              if (preparation.capabilities) {
                contextHarness.refreshToolchain?.(preparation.capabilities);
              }
              msg +=
                ' Dependency preparation completed and the Runtime toolchain view has been refreshed. The failed Shell operation was not retried automatically (side-effect safety); inform the user that they can retry the command.';
            } else if (preparation.message) {
              msg += ` ${preparation.message}`;
            }
          } catch {
            // A broken preparation/approval adapter must remain a normal
            // tool failure and must never crash the Runtime loop.
            msg += ' Dependency preparation could not be started.';
          }
        }
      }

      // v1.3.2：non_idempotent execute throw → 操作转为 uncertain（副作用可能已发生），
      // 之后的相同 canonical key 请求将被阻断（resolveOperation 命中 uncertain），不再重复执行。
      if (effect === 'non_idempotent') {
        sideEffectGuard.markUncertain(operationIdentity(toolDef, args, toolContext));
      }

      // True cancellation（v1.6）：abort 是终态 —— 不重试、不写恢复消息、
      // 不记 failedSteps（uncertain 才是中止时唯一的真实语义）。
      // checkpoint 保留现场后向上抛出，由 Host 落 stopped。
      if (isAbortError(err)) {
        lifecycle.transition(effect === 'non_idempotent' ? 'uncertain' : 'aborted');
        save();
        throw err;
      }

      // Scratchpad: 记录失败（不推进 completedSteps，不推进 nextStep）
      recordFailure(scratchpad, { tool: toolName, input, error: msg });

      // v1.8 Error Classification：只有瞬时错误才重试。确定性错误（文件不
      // 存在、offset 越界、参数非法、策略拒绝）重试必然得到同样结果——
      // 那只会烧掉模型轮次并让同一错误进入上下文三次。
      const classification = classifyToolError(err);
      const willRetry = classification.retryable && attempt <= effectiveRetries;

      // Trace: 工具错误事件（v2.0 审计：记录网络模式；网络拒绝为 "denied"）
      emit({
        type: 'tool_error',
        tool: toolName,
        error: msg,
        attempt,
        exhausted: !willRetry,
        network: getNetworkMode(),
      });

      // State: 错误状态（当前错误 + 失败历史 lastToolError，不推进步骤）
      updateState(state, {
        currentStep: 'tool_error',
        currentError: msg,
        lastToolError: { tool: toolName, input, error: msg, retries: attempt },
      });
      observeState('summary');
      // Checkpoint: 工具失败后保存
      save();

      if (!willRetry) {
        lifecycle.transition(effect === 'non_idempotent' ? 'uncertain' : 'failed');
        // 失败恢复：将错误（含"为什么不再重试"）作为消息返回 LLM，由其决策
        const exhaustedByRetries = attempt > effectiveRetries;
        const failureNote = exhaustedByRetries
          ? `重试 ${effectiveRetries} 次仍失败`
          : `该错误为确定性失败（${classification.reason}），未重试`;
        observer.log(`[恢复] 工具 ${toolName} ${failureNote}，将错误返回 LLM 由其决策`);
        updateState(state, {
          failedToolCalls: state.failedToolCalls + 1,
        });
        emit({
          type: 'recovery_decision',
          tool: toolName,
          decision: `工具 ${toolName} ${failureNote}，已将错误返回 LLM，由其决定：修正参数重新调用 / 换其他方法 / 直接向用户说明失败原因`,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `工具 ${toolName} 参数 "${input}" 执行失败（${failureNote}）：${msg}。禁止再次使用相同参数调用，请修正参数或换其他方法。`,
        });
        return; // 跳出重试，外层循环继续 → LLM 重新决策
      }
      lifecycle.transition('retry_wait');
      observer.log(
        `[重试 ${attempt}/${effectiveRetries}] 工具 ${toolName} 失败（${classification.reason}），正在重试...`,
      );
    }
  }
}
