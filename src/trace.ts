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
      type: "final_answer";
      step: number;
      timestamp: string;
      content: string; // 最终答案
      totalSteps: number; // 总执行步骤数（LLM 迭代轮数）
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
      type: "final_answer";
      content: string;
      totalSteps: number;
    }
  | {
      type: "error";
      message: string;
    };

export interface Trace {
  run_id: string;
  events: TraceEvent[];
}

// ---- 创建 Trace ----
export function createTrace(): Trace {
  return { run_id: crypto.randomUUID(), events: [] };
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
