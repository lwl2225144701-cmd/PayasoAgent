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

export async function execute(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) return `Error: tool "${name}" not found`;
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

// ---- 示例工具: calculator ----
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
      return "Error: 表达式包含非法字符";
    }
    try {
      const result = Function(`"use strict"; return (${expr})`)();
      return `计算结果: ${expr} = ${result}`;
    } catch {
      return "Error: 表达式无法计算";
    }
  },
});
