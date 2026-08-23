// 模块 2: 工具注册与执行

import type { ToolSchema } from "./llm.js";

export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<string>;
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
    return `天气: ${city} ${w.temp}°C, ${w.cond}`;
  },
});
