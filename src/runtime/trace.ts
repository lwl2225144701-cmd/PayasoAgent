// Trace 模块 — 记录 Agent 每一步执行过程（LLM 调用 / 工具调用 / 最终答案 / 错误）

// 工具结果附带的图片引用（工作区相对路径 + MIME），与 tools.js 的 ToolImage 同构。
// trace 只存路径引用，不存 base64（事件持久化进 checkpoint，须保持轻量）。
import type { TokenUsage } from '../llm/token-usage.js';

export interface TraceImage {
  mimeType: string;
  path: string;
}

// ---- 事件类型定义 ----
// 完整事件（存储在 trace.events 中，step/timestamp 由 addEvent 自动填充）
export type TraceEvent =
  | {
      type: 'llm_call';
      step: number;
      timestamp: string;
      messageCount: number; // 调用时输入消息数量
      iteration: number; // 当前迭代次数
      response: string; // LLM 返回内容
      reasoning?: string; // 部分推理模型单独返回的思考内容
      hasToolCalls: boolean; // 是否产生 tool_call
      usage?: TokenUsage;
    }
  | {
      // LLM 调用已发出、尚未收到任何流式增量。大上下文 prefill 下这段等待可达
      // 数十秒 —— 有了它前端才能在「工具轮结束 → 首个 delta」之间给出实时反馈，
      // 否则 UI 完全静默，观感即「执行者执行着没输出」。
      type: 'llm_call_started';
      step: number;
      timestamp: string;
      iteration: number; // 当前迭代（从 1 开始）
      messageCount: number; // 输入消息条数
      estimatedInputTokens?: number; // 上下文估算输入 tokens（前端可提示 prefill 规模）
    }
  | {
      // LLM HTTP 请求真正发出（piFetch 内 globalThis.fetch 调用前）。
      // 与 llm_call_started 的间隔 = Host 侧上下文整理耗时（toPiContext /
      // 图片物化 / Provider 模型组装）；与首个 assistant/reasoning_delta 的
      // 间隔 = 纯 Provider 首包/网络耗时（prefill / 排队 / TLS）。
      // 用于把 run-stats 的 ttftMs 分解为两段，定位 16–18s 首 token 延迟。
      type: 'llm_request_sent';
      step: number;
      timestamp: string;
      iteration: number; // 当前迭代（从 1 开始）
      attempt: number; // 第几次尝试（从 1 开始；重试时每轮请求都发一次）
    }
  | {
      type: 'tool_call';
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      args: unknown; // 工具参数
      // v2.0 审计：本次调用时的全局网络模式（on/off/ask）。网络工具与非网络工具都记录，
      // 拒绝场景由 tool_error 的 network:"denied" 标识。
      network?: 'on' | 'off' | 'ask';
    }
  | {
      // v1.6：模型生成的 tool_call 未通过 invocation 校验（malformed JSON / 非对象 / 未知工具）。
      // 可恢复的 invocation error —— 工具不执行、不创建 side-effect，结构化错误回传模型修正。
      type: 'tool_call_invalid';
      step: number;
      timestamp: string;
      toolCallId: string;
      tool: string;
      code: string; // ToolCallErrorCode（从 tools.js 类型导入，保持字符串字面量供 docs-contract 提取）
    }
  | {
      type: 'tool_result';
      step: number;
      timestamp: string;
      tool: string;
      result: string; // 执行结果（文本部分；图片以路径引用携带）
      durationMs: number; // 执行耗时
      // 视觉读图：工具返回的图片引用（工作区相对路径），前端可据此预览
      images?: TraceImage[];
      // v2.0 审计：执行时的全局网络模式
      network?: 'on' | 'off' | 'ask';
    }
  | {
      type: 'tool_result_invalid';
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      result: unknown; // 返回结果（无效）
      reason: string; // 无效原因
    }
  | {
      type: 'final_answer';
      step: number;
      timestamp: string;
      content: string; // 最终答案
      totalSteps: number; // 总执行步骤数（LLM 迭代轮数）
    }
  | {
      type: 'tool_error';
      step: number;
      timestamp: string;
      tool: string; // 失败的工具名
      error: string; // 错误信息
      attempt: number; // 第几次尝试（从 1 开始）
      exhausted: boolean; // 是否已达到重试上限
      // v2.0 审计：执行时的全局网络模式；网络拒绝 = "denied"（工具未执行）
      network?: 'on' | 'off' | 'ask' | 'denied';
    }
  | {
      type: 'context_trim';
      step: number;
      timestamp: string;
      beforeMessages: number; // 裁剪前消息条数
      afterMessages: number; // 裁剪后消息条数
    }
  | {
      type: 'context_usage';
      step: number;
      timestamp: string;
      // v1.6 紧急兜底：本轮触发了当前任务轮内的紧急裁剪（视图必然有界）
      emergencyTrim?: boolean;
      model: string;
      modelSource: 'run' | 'env';
      configSource: 'settings' | 'env' | 'model_registry' | 'fallback';
      contextWindowTokens: number;
      maxOutputTokens: number;
      safetyTokens: number;
      inputBudgetTokens: number;
      messageTokens: number;
      systemTokens?: number;
      toolSchemaTokens: number;
      scratchpadTokens: number;
      // v2.2 Plan：计划投影注入 system 的估算 token（旧事件无此字段）。
      planTokens?: number;
      estimatedInputTokens: number;
      // 上次 provider 实际上报的 prompt 侧真实用量（未缓存输入 + cache 流量），
      // 用于环形/压力的真实锚点；无上报（如首轮）时缺省走估算。
      pressureTokens?: number;
      usageRatio: number;
      trimmedMessages: number;
      overBudget: boolean;
    }
  | {
      type: 'context_compaction';
      step: number;
      timestamp: string;
      summarizedMessages: number;
      totalSummarizedMessages: number;
      summaryTokens: number;
    }
  | {
      type: 'recovery_decision';
      step: number;
      timestamp: string;
      tool: string; // 触发恢复的工具名
      decision: string; // 恢复决策描述（交还 LLM 决策）
    }
  | {
      // v1.8 空回合不变量：模型既无工具调用也无可见内容，已按 Harness 策略
      // 追加恢复提示并重试（次数用尽则 Run 落 failed，不再静默完成）。
      type: 'empty_turn_recovered';
      step: number;
      timestamp: string;
      attempt: number; // 第几次恢复
      maxAttempts: number; // 策略允许的恢复次数上限
    }
  | {
      // Finalization guard：非空但明显未完成的文本回合，按 Harness 策略恢复或失败。
      type: 'finalization_guard';
      step: number;
      timestamp: string;
      reason: string;
      attempt: number;
      maxAttempts: number;
      disposition: 'retry' | 'fail';
    }
  | {
      type: 'side_effect_skip';
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      key: string; // canonical operation key（operationIdentity）
      replayed: boolean; // 是否回放首次成功结果（恒为 true）
    }
  | {
      type: 'side_effect_uncertain';
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      key: string; // canonical operation key（operationIdentity）
    }
  | {
      type: 'tool_output_truncated';
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      originalBytes: number; // 原始 UTF-8 字节数
      returnedBytes: number; // 截断后 UTF-8 字节数
    }
  | {
      type: 'shell_sandbox_started';
      step: number;
      timestamp: string;
      platform: 'macos';
    }
  | {
      type: 'shell_sandbox_denied';
      step: number;
      timestamp: string;
      platform: 'macos';
      reason: 'workspace_policy';
    }
  | {
      type: 'scratchpad_update';
      step: number;
      timestamp: string;
      currentStep: string; // 当前/最近执行步骤
      completedSteps: number; // 已完成步骤数
      lastResult: string; // 最近一次工具结果
    }
  | {
      // v2.2 Plan：Agent 自述的任务清单发生真实变更（Harness 持有状态，Runtime 发事件）。
      // 携带**全量**清单：前端"取 revision 最大的一条"即可重建，SSE 重连/快照回放天然收敛。
      type: 'plan_update';
      step: number;
      timestamp: string;
      revision: number; // 单调递增；同 revision 不重复发
      items: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>;
      completed: number;
      total: number;
    }
  | {
      type: 'error';
      step: number;
      timestamp: string;
      message: string;
    };

// 事件输入（无需 step/timestamp，由 addEvent 补全）
export type TraceEventInput =
  | {
      type: 'llm_call';
      messageCount: number;
      iteration: number;
      response: string;
      reasoning?: string;
      hasToolCalls: boolean;
      usage?: TokenUsage;
    }
  | {
      type: 'llm_call_started';
      iteration: number;
      messageCount: number;
      estimatedInputTokens?: number;
    }
  | {
      type: 'llm_request_sent';
      iteration: number;
      attempt: number;
    }
  | {
      type: 'tool_call';
      tool: string;
      args: unknown;
      network?: 'on' | 'off' | 'ask';
    }
  | {
      type: 'tool_call_invalid';
      toolCallId: string;
      tool: string;
      code: string;
    }
  | {
      type: 'tool_result';
      tool: string;
      result: string;
      durationMs: number;
      images?: TraceImage[];
      network?: 'on' | 'off' | 'ask';
    }
  | {
      type: 'tool_result_invalid';
      tool: string;
      result: unknown;
      reason: string;
    }
  | {
      type: 'final_answer';
      content: string;
      totalSteps: number;
    }
  | {
      type: 'tool_error';
      tool: string;
      error: string;
      attempt: number;
      exhausted: boolean;
      network?: 'on' | 'off' | 'ask' | 'denied';
    }
  | {
      type: 'context_trim';
      beforeMessages: number;
      afterMessages: number;
    }
  | {
      type: 'context_usage';
      model: string;
      modelSource: 'run' | 'env';
      configSource: 'settings' | 'env' | 'model_registry' | 'fallback';
      emergencyTrim?: boolean;
      contextWindowTokens: number;
      maxOutputTokens: number;
      safetyTokens: number;
      inputBudgetTokens: number;
      messageTokens: number;
      systemTokens?: number;
      toolSchemaTokens: number;
      scratchpadTokens: number;
      // v2.2 Plan：计划投影注入 system 的估算 token（旧事件无此字段）。
      planTokens?: number;
      estimatedInputTokens: number;
      // 上次 provider 实际上报的 prompt 侧真实用量（未缓存输入 + cache 流量），
      // 用于环形/压力的真实锚点；无上报（如首轮）时缺省走估算。
      pressureTokens?: number;
      usageRatio: number;
      trimmedMessages: number;
      overBudget: boolean;
    }
  | {
      type: 'context_compaction';
      summarizedMessages: number;
      totalSummarizedMessages: number;
      summaryTokens: number;
    }
  | {
      type: 'recovery_decision';
      tool: string;
      decision: string;
    }
  | {
      type: 'empty_turn_recovered';
      attempt: number;
      maxAttempts: number;
    }
  | {
      type: 'finalization_guard';
      reason: string;
      attempt: number;
      maxAttempts: number;
      disposition: 'retry' | 'fail';
    }
  | {
      type: 'side_effect_skip';
      tool: string;
      key: string;
      replayed: boolean;
    }
  | {
      type: 'side_effect_uncertain';
      tool: string;
      key: string;
    }
  | {
      type: 'tool_output_truncated';
      tool: string;
      originalBytes: number;
      returnedBytes: number;
    }
  | {
      type: 'shell_sandbox_started';
      platform: 'macos';
    }
  | {
      type: 'shell_sandbox_denied';
      platform: 'macos';
      reason: 'workspace_policy';
    }
  | {
      type: 'scratchpad_update';
      currentStep: string;
      completedSteps: number;
      lastResult: string;
    }
  | {
      type: 'plan_update';
      revision: number;
      items: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }>;
      completed: number;
      total: number;
    }
  | {
      type: 'error';
      message: string;
    };

export interface Trace {
  run_id: string;
  events: TraceEvent[];
  // 可选观测回调（Host API 通过 runAgent opts.onTrace 注入）；
  // 每次 addEvent 时触发，供 Host 把 Runtime Trace 实时推给浏览器。
  // 这是纯观测出口，不改变 Runtime 纪录语义（events 照常写入）。
  onEvent?: (ev: TraceEvent) => void;
}

// ---- 创建 Trace（runId 由外部统一生成，保证 State/Trace/Checkpoint 一致）----
// onEvent: 可选订阅，addEvent 后同步触发（供 Host/SSE 使用）
export function createTrace(runId: string, onEvent?: (ev: TraceEvent) => void): Trace {
  return { run_id: runId, events: [], onEvent };
}

// ---- 追加事件（自动编号 step、打时间戳），返回事件便于实时打印 ----
export function addEvent(trace: Trace, ev: TraceEventInput): TraceEvent {
  const event = {
    ...ev,
    step: trace.events.length + 1,
    timestamp: new Date().toISOString(),
  } as TraceEvent; // union spread 后 TS 无法精确推断，此处断言
  trace.events.push(event);
  trace.onEvent?.(event);
  return event;
}
