// 模块: 只读 Sandbox 文件工具（listDir / readFile）
// 安全契约：LLM 只传工作区内相对路径；真实路径由 Runtime 注入的 ToolContext.runId +
// SandboxManager.resolvePath / assertInsideWorkspace 解析与校验。
// 核心原则：模型决定读取什么，Runtime 决定在哪里读取。
// 阶段目标：Agent 获得"看得到，但改不了"的工作区能力（无 writeFile/deleteFile/shell）。

import fs from "node:fs";
import { register, type ToolContext } from "./tools.js";
import { resolvePath, assertInsideWorkspace } from "../sandbox/sandbox-manager.js";

// 最大读取限制：超过则返回 invalid result，不把大文件塞进 Context
export const MAX_READ_BYTES = 1024 * 1024; // 1MB

// 拒绝路径的统一脱敏消息：只回显相对路径，不泄露宿主机绝对路径
function rejectPath(rel: string): never {
  throw new Error(
    `路径被拒绝（仅允许工作区内相对路径，禁止穿越/绝对路径/symlink 逃逸）: ${rel}`
  );
}

// 解析 + 双重校验（resolvePath 字符串级 + assertInsideWorkspace 真实路径级）
// 任何逃逸（.. / 绝对路径 / symlink 指向外部）→ BLOCKED（tool_error）
function guardPath(context: ToolContext, rel: string): string {
  try {
    const real = resolvePath(context.runId, rel);
    assertInsideWorkspace(context.runId, real);
    return real;
  } catch {
    rejectPath(rel);
  }
}

// 简单二进制检测：NUL 字节或大量不可打印控制字符（UTF-8 多字节 >0x7F 不误判）
function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  let control = 0;
  for (const b of sample) {
    if (b === 0x00) return true; // NUL 字节 → 明确二进制
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++;
  }
  return control > sample.length / 10;
}

// ---- listDir ----
register({
  name: "listDir",
  description:
    "列出沙箱工作区内目录的条目（名称与类型 file/directory），不递归。path 为工作区内相对路径，如 work",
  // 只读目录枚举，无副作用
  effect: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内相对目录路径，如 work 或 input" },
    },
    required: ["path"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    if (!rel) throw new Error("缺少参数 path");
    const real = guardPath(context, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`目录不存在: ${rel}`);
    }
    if (!st.isDirectory()) throw new Error(`不是目录（路径指向文件）: ${rel}`);
    const entries = fs
      .readdirSync(real, { withFileTypes: true })
      .map((e) => {
        // 不跟随 symlink：仅列出条目本身（访问该条目时由 guardPath 拦截逃逸）
        const type = e.isDirectory() ? "directory" : e.isFile() ? "file" : "other";
        return { name: e.name, type };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) return `目录 ${rel} 为空`;
    return (
      `目录 ${rel} 内容（${entries.length} 项）:\n` +
      entries.map((e) => `  [${e.type}] ${e.name}`).join("\n")
    );
  },
});

// ---- readFile ----
register({
  name: "readFile",
  description:
    "读取沙箱工作区内文本文件内容（UTF-8，最大 1MB，不支持二进制）。path 为工作区内相对路径，如 input/demo.txt",
  // 只读文件读取，无副作用
  effect: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内相对文件路径，如 input/demo.txt" },
    },
    required: ["path"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    if (!rel) throw new Error("缺少参数 path");
    const real = guardPath(context, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`文件不存在: ${rel}`);
    }
    if (st.isDirectory()) throw new Error(`是目录，无法读取: ${rel}`);
    // 超大文件：明确返回"文件过大"，由 validateResult 判 invalid，不进 completedSteps、不塞进 Context
    if (st.size > MAX_READ_BYTES) {
      return `[sandbox-tool-invalid] 文件过大，当前只读工具无法读取（限制 ${MAX_READ_BYTES} 字节）: ${rel}`;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(real);
    } catch {
      throw new Error(`读取失败（文件不可读或为目录）: ${rel}`);
    }
    // 二进制：返回无效结果，不直接喂给 LLM
    if (isProbablyBinary(buf)) {
      return `[sandbox-tool-invalid] 二进制文件，当前只读工具不支持读取: ${rel}`;
    }
    return buf.toString("utf8");
  },
  // 超大/二进制 → 工具执行成功但结果不可用 → tool_result_invalid
  validateResult: (result) => {
    if (typeof result === "string" && result.startsWith("[sandbox-tool-invalid]")) {
      return { valid: false, reason: "文件过大或二进制，结果不可用" };
    }
    return true;
  },
});
