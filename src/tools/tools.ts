// 模块 2: 工具注册与执行
// 契约（安全边界）：
// - LLM 永远不能控制 runId/workspaceRoot：两者不出现在任何 Tool Schema 中，由 Runtime 注入。
// - 工具只接收"相对路径"参数；文件类工具必须相对 context.workspaceRoot 解析真实路径。
// - 模型决定"做什么"，Runtime 决定"在哪里执行"。

import type { ToolSchema } from "../llm/llm.js";

// Runtime 注入的工具上下文（LLM 不可见、不可传入）
export interface ToolContext {
  runId: string; // 当前 Agent Run 的 runId，只能来自 Agent Runtime State
  workspaceRoot: string; // Host/Runtime 授权并 canonicalize 的真实工作根，LLM 不可见不可覆盖
  // True cancellation (v1.6)：Run 的 AbortSignal；长任务工具（shell 及未来 browser/computer）
  // 必须监听并尽快终止，读类/原子文件工具可忽略。与 runId 一样由 Runtime 注入，LLM 不可见。
  signal?: AbortSignal;
  // Runtime-only observation hook; never included in an LLM Tool Schema.
  onSandboxEvent?: (event: ToolSandboxEvent) => void;
}

export type ToolSandboxEvent =
  | { type: "shell_sandbox_started"; platform: "macos" }
  | { type: "shell_sandbox_denied"; platform: "macos"; reason: "workspace_policy" };

// v1.3 契约收紧：Tool 副作用类别声明
// - read: 纯读取，无副作用
// - idempotent: 可安全重复执行（同参数 → 等价结果）
// - non_idempotent: 高风险副作用，重复执行可能产生不同结果/不可逆影响
export type ToolEffect = "read" | "idempotent" | "non_idempotent";

export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON Schema（严禁包含 runId 等 Runtime 内部字段）
  // v1.3 契约收紧：声明副作用类别（必填）
  effect: ToolEffect;
  // v1.3 契约收紧：显式定义"什么叫同一个操作"（canonical operation key）。
  // non_idempotent 必填（注册期强制校验），禁止回退到 JSON.stringify(args) 猜测；
  // read / idempotent 可省略，回退到 JSON.stringify(args)。
  // v1.5 融合身份机制：getOperationKey 可选接收 ToolContext（运行时注入，含 runId/workspaceRoot），
  //   路径类工具用它做路径归一化（canonicalPathKey），使 ./work/a.txt 与 work/a.txt 归一为同一 key 且不暴露宿主绝对路径。
  getOperationKey?: (args: Record<string, unknown>, context?: ToolContext) => string;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
  // v1.2: 可选的业务结果有效性校验。无此字段则默认结果有效。
  // execute 负责"能不能执行成功"；validateResult 负责"结果能不能继续被 Agent 使用"。
  validateResult?: (result: unknown) => boolean | { valid: boolean; reason?: string };
}

// ---- 工具注册表 ----
const registry = new Map<string, Tool>();

export function register(tool: Tool): void {
  // v1.3 契约收紧：non_idempotent（高风险副作用）必须显式声明"什么叫同一个操作"。
  // 不能依赖默认 JSON.stringify(args) 猜测操作身份 → 注册期直接失败（fail-fast）。
  if (
    tool.effect === "non_idempotent" &&
    typeof tool.getOperationKey !== "function"
  ) {
    throw new Error(
      `Tool "${tool.name}" 声明为 non_idempotent（高风险副作用）但未实现 getOperationKey，注册失败。` +
        `non_idempotent 必须显式定义 canonical operation key，禁止回退到 JSON.stringify(args)。`
    );
  }
  registry.set(tool.name, tool);
}

// 按名称取工具定义（供 Runtime 读取 effect / getOperationKey 等契约字段）
export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

// 执行工具；工具不存在或执行抛错时向上抛出（由调用方捕获重试）
// context 由 Runtime 注入（含 runId），工具的路径类参数必须以相对路径表达
export async function execute(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool "${name}" not found`);
  return tool.execute(args, context);
}

// 导出为 OpenAI tools 参数格式
export function getSchemas(): ToolSchema[] {
  return [...registry.values()].map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// v1.2: 运行 Tool 的 validateResult（若存在）；无声明默认结果有效。
// 返回 { valid, reason? }，供 Agent Loop 区分"执行成功"与"结果有效"两个维度。
export function validateToolResult(
  name: string,
  result: unknown
): { valid: boolean; reason?: string } {
  const tool = registry.get(name);
  if (!tool || !tool.validateResult) return { valid: true };
  const r = tool.validateResult(result);
  if (typeof r === "boolean") return { valid: r };
  return r;
}

// v1.3 契约收紧：解析一次工具调用的 canonical operation key（"什么叫同一个操作"）。
// - 显式 getOperationKey → 使用它（canonical key，权威身份；context 可选透传给路径归一化工具）
// - read / idempotent     → 允许回退 JSON.stringify(args)
// - non_idempotent        → 禁止回退；无 getOperationKey 直接抛错（注册期已拦截，此处防御兜底）
export function resolveOperationKey(
  tool: Tool,
  args: Record<string, unknown>,
  context?: ToolContext
): string {
  if (tool.getOperationKey) return tool.getOperationKey(args, context);
  if (tool.effect !== "non_idempotent") return JSON.stringify(args);
  throw new Error(
    `Tool "${tool.name}" 为 non_idempotent 但未实现 getOperationKey，禁止回退到 JSON.stringify(args)`
  );
}

// ---- 工具: calculator ----
// 失败时直接抛异常（由 agent 捕获并重试），不再返回 Error 字符串
register({
  name: "calculator",
  description: "计算数学表达式，支持加减乘除和括号",
  // 纯函数：同表达式 → 同结果，重复执行安全
  effect: "idempotent",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "数学表达式，如 15 * 37" },
    },
    required: ["expression"],
  },
  execute: async (args, _context) => {
    const expr = String(args.expression || "");
    // 安全检查：仅允许数字与运算符
    if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
      throw new Error("表达式包含非法字符");
    }
    try {
      const result = Function(`"use strict"; return (${expr})`)();
      return `计算结果: ${expr} = ${result}`;
    } catch {
      throw new Error("表达式无法计算");
    }
  },
  // v1.2: 结果有效性校验（NaN / Infinity / -Infinity 视为无效结果，但 execute 本身成功）
  validateResult: (result) => {
    const m = String(result).match(/= (.+)$/);
    const val = m ? m[1].trim() : String(result);
    if (val === "NaN" || val === "Infinity" || val === "-Infinity") {
      return { valid: false, reason: `计算结果无效: ${val}` };
    }
    return true;
  },
});

// ---- 工具: getWeather（mock 数据）----
// 固定城市温度表；未收录城市抛异常（模拟数据源失败，走 Recovery）
const WEATHER_MOCK: Record<string, { temp: number; cond: string }> = {
  深圳: { temp: 28, cond: "晴" },
  北京: { temp: 15, cond: "多云" },
  上海: { temp: 22, cond: "小雨" },
};

register({
  name: "getWeather",
  description: "查询指定城市的当前天气（温度与天气状况），仅支持已收录城市",
  // 只读查询 mock 数据，无副作用
  effect: "read",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称，如 深圳" },
    },
    required: ["city"],
  },
  execute: async (args, _context) => {
    const city = String(args.city || "").trim();
    if (!city) throw new Error("缺少城市参数 city");
    const w = WEATHER_MOCK[city];
    if (!w) throw new Error("城市不存在或天气数据获取失败");
    // v1.2 验证场景：数据源返回 temperature=null（Tool 执行成功，但业务结果无效）
    // 由 validateResult 判定为 invalid，不抛异常、不进 completedSteps
    if (process.env.INVALID_WEATHER === "1") {
      return JSON.stringify({ city, temperature: null });
    }
    return `天气: ${city} ${w.temp}°C, ${w.cond}`;
  },
  // v1.2: 校验返回温度是否为有效数值（null/undefined/非数字 视为无效）
  validateResult: (result) => {
    try {
      const json = JSON.parse(String(result));
      if (json && (json.temperature === null || json.temperature === undefined)) {
        return { valid: false, reason: "temperature 缺失或为空" };
      }
      if (typeof json.temperature !== "number" || !isFinite(json.temperature)) {
        return { valid: false, reason: "temperature 不是有效数值" };
      }
      return true;
    } catch {
      // 非 JSON 文本（如 "天气: 深圳 28°C, 晴"）：从文本提取温度
      const m = String(result).match(/(\d+(?:\.\d+)?)°C/);
      if (!m) return { valid: false, reason: "无法解析温度" };
      return true;
    }
  },
});
