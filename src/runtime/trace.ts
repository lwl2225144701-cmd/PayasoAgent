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
      hasToolCalls: boolean; // 是否产生 tool_call
    }
  | {
      type: "tool_call";
      step: number;
      timestamp: string;
      tool: string; // 工具名称
      args: unknown; // 工具参数
    }
  | {
      type: "tool_result";
      step: number;
      timestamp: string;
      tool: string;
      result: string; // 执行结果
      durationMs: number; // 执行耗时
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
    }
  | {
      type: "context_trim";
      step: number;
      timestamp: string;
      beforeMessages: number; // 裁剪前消息条数
      afterMessages: number; // 裁剪后消息条数
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
      hasToolCalls: boolean;
    }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
    }
  | {
      type: "tool_result";
      tool: string;
      result: string;
      durationMs: number;
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
    }
  | {
      type: "context_trim";
      beforeMessages: number;
      afterMessages: number;
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
}

// ---- 创建 Trace（runId 由外部统一生成，保证 State/Trace/Checkpoint 一致）----
export function createTrace(runId: string): Trace {
  return { run_id: runId, events: [] };
}

// ---- 追加事件（自动编号 step、打时间戳），返回事件便于实时打印 ----
export function addEvent(trace: Trace, ev: TraceEventInput): TraceEvent {
  const event = {
    ...ev,
    step: trace.events.length + 1,
    timestamp: new Date().toISOString(),
  } as TraceEvent; // union spread 后 TS 无法精确推断，此处断言
  trace.events.push(event);
  return event;
}

// ---- 实时打印单条事件（每步输出）----
export function printEvent(ev: TraceEvent): void {
  console.log(`[Trace] ${JSON.stringify(ev)}`);
}

// ---- 打印 Trace ----
export function printTrace(trace: Trace): void {
  console.log("\n=== Trace 执行轨迹 ===");
  console.log(JSON.stringify(trace, null, 2));
}
