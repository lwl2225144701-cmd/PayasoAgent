// Trace 模块 — 记录 Agent 每一步执行过程（LLM 调用 / 工具调用 / 最终答案 / 错误）

// ---- 事件类型定义 ----
// 完整事件（存储在 trace.events 中，step/timestamp 由 addEvent 自动填充）
export type TraceEvent =
  | {
      type: "llm_call";
      step: number;
      timestamp: string;
      messageCount: number; // 调用时输入消息数量
      iteration: number; // 当前迭代次数
      response: string; // LLM 返回内容
      reasoning?: string; // 部分推理模型单独返回的思考内容
      hasToolCalls: boolean; // 是否产生 tool_call
    }
  | {
      type: "tool_call";
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      args: unknown; // 工具参数
      // v2.0 审计：本次调用时的全局网络模式（on/off/ask）。网络工具与非网络工具都记录，
      // 拒绝场景由 tool_error 的 network:"denied" 标识。
      network?: "on" | "off" | "ask";
    }
  | {
      // v1.6：模型生成的 tool_call 未通过 invocation 校验（malformed JSON / 非对象 / 未知工具）。
      // 可恢复的 invocation error —— 工具不执行、不创建 side-effect，结构化错误回传模型修正。
      type: "tool_call_invalid";
      step: number;
      timestamp: string;
      toolCallId: string;
      tool: string;
      code: string; // ToolCallErrorCode（从 tools.js 类型导入，保持字符串字面量供 docs-contract 提取）
    }
  | {
      type: "tool_result";
      step: number;
      timestamp: string;
      tool: string;
      result: string; // 执行结果
      durationMs: number; // 执行耗时
      // v2.0 审计：执行时的全局网络模式
      network?: "on" | "off" | "ask";
    }
  | {
      type: "tool_result_invalid";
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      result: unknown; // 返回结果（无效）
      reason: string; // 无效原因
    }
  | {
      type: "final_answer";
      step: number;
      timestamp: string;
      content: string; // 最终答案
      totalSteps: number; // 总执行步骤数（LLM 迭代轮数）
    }
  | {
      type: "tool_error";
      step: number;
      timestamp: string;
      tool: string; // 失败的工具名
      error: string; // 错误信息
      attempt: number; // 第几次尝试（从 1 开始）
      exhausted: boolean; // 是否已达到重试上限
      // v2.0 审计：执行时的全局网络模式；网络拒绝 = "denied"（工具未执行）
      network?: "on" | "off" | "ask" | "denied";
    }
  | {
      type: "context_trim";
      step: number;
      timestamp: string;
      beforeMessages: number; // 裁剪前消息条数
      afterMessages: number; // 裁剪后消息条数
    }
  | {
      type: "context_usage";
      step: number;
      timestamp: string;
      model: string;
      configSource: "run_model" | "env" | "model_registry" | "fallback";
      contextWindowTokens: number;
      maxOutputTokens: number;
      safetyTokens: number;
      inputBudgetTokens: number;
      messageTokens: number;
      toolSchemaTokens: number;
      scratchpadTokens: number;
      estimatedInputTokens: number;
      usageRatio: number;
      trimmedMessages: number;
      overBudget: boolean;
    }
  | {
      type: "context_compaction";
      step: number;
      timestamp: string;
      summarizedMessages: number;
      totalSummarizedMessages: number;
      summaryTokens: number;
    }
  | {
      type: "recovery_decision";
      step: number;
      timestamp: string;
      tool: string; // 触发恢复的工具名
      decision: string; // 恢复决策描述（交还 LLM 决策）
    }
  | {
      type: "side_effect_skip";
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      key: string; // canonical operation key（operationIdentity）
      replayed: boolean; // 是否回放首次成功结果（恒为 true）
    }
  | {
      type: "side_effect_uncertain";
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      key: string; // canonical operation key（operationIdentity）
    }
  | {
      type: "tool_output_truncated";
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      originalBytes: number; // 原始 UTF-8 字节数
      returnedBytes: number; // 截断后 UTF-8 字节数
    }
  | {
      type: "shell_sandbox_started";
      step: number;
      timestamp: string;
      platform: "macos";
    }
  | {
      type: "shell_sandbox_denied";
      step: number;
      timestamp: string;
      platform: "macos";
      reason: "workspace_policy";
    }
  | {
      type: "scratchpad_update";
      step: number;
      timestamp: string;
      currentStep: string; // 当前/最近执行步骤
      completedSteps: number; // 已完成步骤数
      lastResult: string; // 最近一次工具结果
    }
  | {
      type: "error";
      step: number;
      timestamp: string;
      message: string;
    };

// 事件输入（无需 step/timestamp，由 addEvent 补全）
export type TraceEventInput =
  | {
      type: "llm_call";
      messageCount: number;
      iteration: number;
      response: string;
      reasoning?: string;
      hasToolCalls: boolean;
    }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      network?: "on" | "off" | "ask";
    }
  | {
      type: "tool_call_invalid";
      toolCallId: string;
      tool: string;
      code: string;
    }
  | {
      type: "tool_result";
      tool: string;
      result: string;
      durationMs: number;
      network?: "on" | "off" | "ask";
    }
  | {
      type: "tool_result_invalid";
      tool: string;
      result: unknown;
      reason: string;
    }
  | {
      type: "final_answer";
      content: string;
      totalSteps: number;
    }
  | {
      type: "tool_error";
      tool: string;
      error: string;
      attempt: number;
      exhausted: boolean;
      network?: "on" | "off" | "ask" | "denied";
    }
  | {
      type: "context_trim";
      beforeMessages: number;
      afterMessages: number;
    }
  | {
      type: "context_usage";
      model: string;
      configSource: "run_model" | "env" | "model_registry" | "fallback";
      contextWindowTokens: number;
      maxOutputTokens: number;
      safetyTokens: number;
      inputBudgetTokens: number;
      messageTokens: number;
      toolSchemaTokens: number;
      scratchpadTokens: number;
      estimatedInputTokens: number;
      usageRatio: number;
      trimmedMessages: number;
      overBudget: boolean;
    }
  | {
      type: "context_compaction";
      summarizedMessages: number;
      totalSummarizedMessages: number;
      summaryTokens: number;
    }
  | {
      type: "recovery_decision";
      tool: string;
      decision: string;
    }
  | {
      type: "side_effect_skip";
      tool: string;
      key: string;
      replayed: boolean;
    }
  | {
      type: "side_effect_uncertain";
      tool: string;
      key: string;
    }
  | {
      type: "tool_output_truncated";
      tool: string;
      originalBytes: number;
      returnedBytes: number;
    }
  | {
      type: "shell_sandbox_started";
      platform: "macos";
    }
  | {
      type: "shell_sandbox_denied";
      platform: "macos";
      reason: "workspace_policy";
    }
  | {
      type: "scratchpad_update";
      currentStep: string;
      completedSteps: number;
      lastResult: string;
    }
  | {
      type: "error";
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
