// 模块: AgentContext —— runAgent 的一次执行装配。
//
// 为什么单独存在：runAgent 主循环里「装配」（State / Harness / Scratchpad /
// Trace / Checkpoint / SideEffectGuard / messages 与观测闭包）与「迭代控制」
// 是两类职责。装配有明确的构造顺序（toolContext → harness → planPort 装饰 →
// messages → 闭包），独立成模块后装配规则有唯一 owner，主循环只消费 context。

import { type AgentContextHarness, DefaultContextHarness } from '../harness/context-harness.js';
import type { ContextHarnessState } from '../harness/context-state.js';
import { countCompleted } from '../harness/plan.js';
import type { ChatMessage, MessageImage, ModelConfig } from '../llm/llm.js';
import { getNetworkMode } from '../network-mode.js';
import type { ToolchainPreparationPort } from '../sandbox/toolchain-preparation.js';
import { formatToolCallError, type ToolCallError, type ToolContext } from '../tools/tools.js';
import type { ApprovalPort } from './approval-port.js';
import { resolveApprovalPort } from './approval-port.js';
import type { CheckpointSnapshot, CheckpointWriter } from './checkpoint-port.js';
import type { AgentExecutionContext } from './contracts.js';
import { protectRuntimeObserver, type RuntimeObserver } from './observer-port.js';
import { createScratchpad, type Scratchpad } from './scratchpad.js';
import { createSideEffectGuard, type SideEffectGuard } from './side-effect.js';
import { type AgentState, createState, updateState } from './state.js';
import {
  addEvent,
  createTrace,
  type Trace,
  type TraceEvent,
  type TraceEventInput,
} from './trace.js';

export interface AgentContextDeps {
  runId: string;
  // Background Job 的 Session 级所有权：工具上下文携带 sessionId 供作业注册表
  // 按会话建索引（不随 Run 结束销毁）。缺省（CLI/旧测试）回退 runId 派生键。
  sessionId?: string;
  task: string;
  workspaceRoot: string;
  permissionMode: AgentExecutionContext['permissionMode'];
  toolchain: AgentExecutionContext['toolchain'];
  visionEnabled: boolean;
  resume?: CheckpointSnapshot;
  opts: {
    executionContext: AgentExecutionContext;
    checkpointWriter: CheckpointWriter;
    observer: RuntimeObserver;
    conversationHistory?: ChatMessage[];
    attachments?: MessageImage[];
    onTrace?: (ev: TraceEvent) => void;
    modelConfig?: ModelConfig;
    contextHarness?: AgentContextHarness;
    previousHarnessState?: ContextHarnessState;
    approvalPort?: ApprovalPort;
    toolchainPreparationPort?: ToolchainPreparationPort;
    // 原始 Run 取消信号（工具级 deadline 由其派生；工具上下文同时直传原信号）。
    signal?: AbortSignal;
  };
}

export interface AgentContext {
  toolContext: ToolContext;
  state: AgentState;
  trace: Trace;
  scratchpad: Scratchpad;
  sideEffectGuard: SideEffectGuard;
  messages: ChatMessage[];
  contextHarness: AgentContextHarness;
  modelContext: AgentContextHarness['modelContext'];
  observer: RuntimeObserver;
  /** resume 时从上一轮重试（该轮可能未完成）；否则从 0 开始 */
  startIter: number;
  emit: (input: TraceEventInput) => TraceEvent;
  save: (status?: string) => void;
  observeState: (detail: 'summary' | 'full') => void;
  observeScratchpad: () => void;
  observeTrace: () => void;
  pushToolCallError: (toolCallId: string, toolName: string, error: ToolCallError) => void;
}

export function createAgentContext(deps: AgentContextDeps): AgentContext {
  const {
    runId,
    sessionId,
    task,
    workspaceRoot,
    permissionMode,
    toolchain,
    visionEnabled,
    resume,
  } = deps;
  const opts = deps.opts;

  // 视觉能力随模型配置固化：read 等读图工具据此决定返回图片块还是文本占位。
  // 先装配 Runtime 已就绪的部分；planPort 需要等 Harness 创建后再接（见下）。
  const toolContext: ToolContext = {
    runId,
    sessionId,
    workspaceRoot,
    permissionMode,
    writeScope: opts.executionContext.writeScope,
    networkMode: getNetworkMode(),
    approvalPort: resolveApprovalPort(opts.approvalPort),
    toolchain,
    vision: visionEnabled,
    // 原始 Run 取消信号：后台作业等长生命周期用途（用户停止仍传播取消）。
    runSignal: opts.signal,
  };
  const observer = protectRuntimeObserver(opts.observer);

  // State: 新建或从 checkpoint 恢复
  const state = resume ? resume.state : createState(task, runId);
  const trace = createTrace(runId, opts.onTrace);
  const emit = (input: TraceEventInput): TraceEvent => {
    const event = addEvent(trace, input);
    observer.traceEvent(structuredClone(event));
    return event;
  };
  const observeState = (detail: 'summary' | 'full'): void => {
    observer.state(structuredClone(state), detail);
  };
  const observeScratchpad = (): void => {
    observer.scratchpad(structuredClone(scratchpad));
  };
  const observeTrace = (): void => {
    observer.trace({ run_id: trace.run_id, events: structuredClone(trace.events) });
  };
  // Context Harness：决定模型看到的指令、历史视图、Scratchpad 视图与预算。
  // Runtime 只持有完整 transcript，并消费 prepareTurn() 的临时模型视图。
  const contextHarness: AgentContextHarness =
    opts.contextHarness ??
    new DefaultContextHarness({
      permissionMode,
      modelConfig: opts.modelConfig,
      toolchain,
    });
  contextHarness.restoreState(resume?.harnessState ?? opts.previousHarnessState);
  // v2.2 Plan：计划状态由 Harness 持有（随 harnessState 进 checkpoint）。Runtime 只把
  // 写入口装饰成"语义 → plan_update 事件"：Harness 不碰 trace，工具只见文本。
  const planPort = contextHarness.planPort?.();
  if (planPort) {
    toolContext.planPort = {
      apply: (items) => {
        const applied = planPort.apply(items);
        if (applied.changed) {
          emit({
            type: 'plan_update',
            revision: applied.plan.revision,
            items: applied.plan.items,
            completed: countCompleted(applied.plan),
            total: applied.plan.items.length,
          });
          // 不在这里额外 save()：工具成功后紧接着就有一次 checkpoint（含 harnessState）。
        }
        return applied.resultText;
      },
    };
  }
  const scratchpad = resume ? resume.scratchpad : createScratchpad(task);
  // v1.3 Side-Effect Safety：记录已成功执行的 non_idempotent 操作；resume 时从 checkpoint 恢复
  const sideEffectGuard = createSideEffectGuard(resume?.sideEffects ?? []);
  const messages: ChatMessage[] = resume
    ? resume.messages
    : contextHarness.createTranscript(task, opts.conversationHistory, opts.attachments);
  // 恢复时从上一轮重试（该轮可能未完成）；否则从 0 开始
  const startIter = resume ? Math.max(0, resume.iteration - 1) : 0;

  // Checkpoint 保存（tool_result / tool_error / 完成 / 失败时调用）
  const save = (status?: string) => {
    const file = opts.checkpointWriter.save({
      runId,
      task: state.task,
      status: status ?? state.status,
      iteration: state.iteration,
      scratchpad,
      messages,
      state,
      workspaceRoot,
      permissionMode,
      sideEffects: sideEffectGuard.snapshot(),
      harnessState: contextHarness.snapshotState(),
    });
    observer.log(`[Checkpoint] saved → ${file}`);
  };

  if (resume) {
    observer.log(
      `[恢复] 从 checkpoint 继续: runId=${resume.runId} 已完成 ${scratchpad.completedSteps.length} 步, 重跑迭代 ${startIter + 1}`,
    );
  }

  // v1.6 Tool Call Pipeline：invocation error（malformed JSON / 非 object 参数 /
  // 未知工具）→ 标准化 tool error result（保留 tool_call_id 关联）+ trace +
  // checkpoint。工具不执行、不创建 side-effect operation，由模型下一轮自行修正。
  const pushToolCallError = (toolCallId: string, toolName: string, error: ToolCallError): void => {
    updateState(state, {
      currentStep: 'tool_call_invalid',
      currentError: `${error.code}: ${error.message}`,
    });
    observeState('summary');
    emit({
      type: 'tool_call_invalid',
      toolCallId,
      tool: toolName,
      code: error.code,
    });
    observer.log(`[Tool Call Invalid] ${toolName}: ${error.code}`);
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: formatToolCallError(error),
    });
    save();
  };

  return {
    toolContext,
    state,
    trace,
    scratchpad,
    sideEffectGuard,
    messages,
    contextHarness,
    modelContext: contextHarness.modelContext,
    observer,
    startIter,
    emit,
    save,
    observeState,
    observeScratchpad,
    observeTrace,
    pushToolCallError,
  };
}
