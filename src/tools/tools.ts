// 模块 2: 工具注册与执行

import type { ToolSchema } from "../llm/llm.js";

export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<string>;
  // v1.2: 可选的业务结果有效性校验。无此字段则默认结果有效。
  // execute 负责"能不能执行成功"；validateResult 负责"结果能不能继续被 Agent 使用"。
  validateResult?: (result: unknown) => boolean | { valid: boolean; reason?: string };
}

// ---- 工具注册表 ----
const registry = new Map<string, Tool>();

export function register(tool: Tool): void {
  registry.set(tool.name, tool);
}

// 执行工具；工具不存在或执行抛错时向上抛出（由调用方捕获重试）
export async function execute(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool "${name}" not found`);
  return tool.execute(args);
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

// ---- 工具: calculator ----
// 失败时直接抛异常（由 agent 捕获并重试），不再返回 Error 字符串
register({
  name: "calculator",
  description: "计算数学表达式，支持加减乘除和括号",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "数学表达式，如 15 * 37" },
    },
    required: ["expression"],
  },
  execute: async (args) => {
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
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称，如 深圳" },
    },
    required: ["city"],
  },
  execute: async (args) => {
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
