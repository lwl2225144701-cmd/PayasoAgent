// 模块: Sandbox 文件工具（只读 ls / read + 受控写入 write + 精确编辑 edit）
// 安全契约：LLM 只传工作区内相对路径；真实路径由 Runtime 注入的 ToolContext.workspaceRoot +
// resolveWorkspacePath / assertInsideRoot 解析与校验。
// 核心原则：模型决定读取什么，Runtime 决定在哪里执行。
// v1.5 融合身份机制：路径类工具用 canonicalPathKey 做操作 identity 归一化（不暴露宿主绝对路径）。
// v1.7：readFile→read / writeFile→write / listDir→ls 重命名，保留 hidden 别名兼容；
//       新增 edit 工具（oldText/newText 精确替换，禁止重叠，保留换行风格）。

import fs from "node:fs";
import path from "node:path";
import { register, registerAlias, type ToolContext } from "./tools.js";
import {
  resolveWorkspacePath,
  assertInsideRoot,
  getRunWorkspaceRoot,
} from "../sandbox/sandbox-manager.js";
import { storedPermissionMode } from "../permission-mode.js";

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
function canonicalHostPath(workspaceRoot: string, input: string): string {
  const candidate = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(workspaceRoot, input);
  // Resolve every existing ancestor so paths traversing directory symlinks are
  // canonical even when the final file does not exist yet.
  let existing = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return path.join(real, ...suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw err;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function resolveAuthorizedPath(context: ToolContext, rel: string): string {
  if (storedPermissionMode(context.permissionMode) === "full-access") {
    try {
      return canonicalHostPath(context.workspaceRoot, rel);
    } catch {
      rejectPath(rel);
    }
  }
  try {
    const real = resolveWorkspacePath(context.workspaceRoot, rel);
    assertInsideRoot(context.workspaceRoot, real);
    return real;
  } catch {
    rejectPath(rel);
  }
}

// v1.5: 归一化相对路径为稳定的 operation key（用于 getOperationKey）。
// 内部先做 resolvePath 安全解析，再剥离工作区根前缀，返回以 "/" 分隔的相对路径。
// 这样 ./work/a.txt 与 work/a.txt（含 ./ 多余段）归一化为同一 key，且不暴露宿主绝对路径。
// 若路径非法（穿越/绝对），返回 null，由调用方回退保守处理。
export function canonicalPathKey(context: ToolContext, rel: string): string | null {
  try {
    const real = resolveAuthorizedPath(context, rel);
    if (storedPermissionMode(context.permissionMode) === "full-access") {
      return `host:${real.split(path.sep).join("/")}`;
    }
    const relKey = path.relative(context.workspaceRoot, real);
    // 统一分隔符为 "/"（跨平台稳定）；剥离头部 "./"
    const norm = relKey.split(path.sep).join("/").replace(/^\.\//, "");
    return norm === "" ? "/" : norm;
  } catch {
    return null;
  }
}

// 简单二进制检测：NUL 字节或大量不可打印控制字符（UTF-8 多字节 >0x7F 不误判）
export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  let control = 0;
  for (const b of sample) {
    if (b === 0x00) return true; // NUL 字节 → 明确二进制
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++;
  }
  return control > sample.length / 10;
}

// ---- 原子写入辅助（供 write / edit 复用）----
function atomicWriteContent(real: string, content: string, rel: string): string {
  const tmp = path.join(
    path.dirname(real),
    `.${path.basename(real)}.payaso-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, real);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
    throw new Error(`写入失败: ${rel}`);
  }
  return `写入成功: ${rel}`;
}

// ---- 可写区权限（write / edit / moveFile / deleteFile 共用）----
export const MAX_WRITE_BYTES = 1024 * 1024; // 1MB

// 可写顶层目录白名单（权限规则：input/ 只读，仅 work/ 与 output/ 可写）
const WRITABLE_TOP_LEVEL = new Set(["work", "output"]);

// 权限规则的字符串级首段校验：禁止写入 input/，也禁止任何非白名单顶层目录
export function assertWritableZone(rel: string, context: ToolContext): void {
  const permissionMode = storedPermissionMode(context.permissionMode);
  if (permissionMode === "read-only") {
    throw new Error("操作被拒绝：当前 Run 为 Read Only，禁止修改文件系统");
  }
  if (permissionMode === "full-access") return;
  // Legacy no-Workspace mode keeps input/ read-only and work/output writable.
  // An explicitly authorized real Workspace is writable throughout its root.
  const legacyRoot = path.resolve(getRunWorkspaceRoot(context.runId));
  const activeRoot = path.resolve(context.workspaceRoot);
  if (activeRoot !== legacyRoot) return;
  const first = String(rel).split(/[\\/]+/)[0];
  if (!first || !WRITABLE_TOP_LEVEL.has(first)) {
    throw new Error(
      `路径被拒绝（仅允许写入工作区内 work/ 与 output/ 目录，禁止写入 input/）: ${rel}`
    );
  }
}

// ---- ① ls（原 listDir）----
register({
  name: "ls",
  description:
    "列出目录条目（名称与类型 file/directory），不递归。Read Only/Workspace Write 下 path 必须是 Workspace 相对路径；Full access 下也可使用绝对路径。",
  effect: "read",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
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
    const real = resolveAuthorizedPath(context, rel);
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
registerAlias("ls", "listDir");

// ---- ② read（原 readFile，预留图片接口）----
register({
  name: "read",
  description:
    "读取文本文件内容（UTF-8，最大 1MB，不支持二进制）。Read Only/Workspace Write 下仅限 Workspace；Full access 下可使用绝对路径。接口预留未来图片读取能力。",
  effect: "read",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内相对文件路径，如 input/demo.txt" },
      mode: { type: "string", enum: ["text"], description: "读取模式（预留扩展：当前仅支持 text）" },
    },
    required: ["path"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    if (!rel) throw new Error("缺少参数 path");
    const real = resolveAuthorizedPath(context, rel);
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
    // 图片读取预留：当前仅返回文本；mode=image 在后续版本实现
    const mode = String(args.mode ?? "text");
    if (mode !== "text") {
      return `[sandbox-tool-invalid] 读取模式 "${mode}" 尚未实现（预留接口）: ${rel}`;
    }
    return buf.toString("utf8");
  },
  validateResult: (result) => {
    if (typeof result === "string" && result.startsWith("[sandbox-tool-invalid]")) {
      return { valid: false, reason: "文件过大或二进制，结果不可用" };
    }
    return true;
  },
});
registerAlias("read", "readFile");

// ---- ③ write（原 writeFile，自动创建父目录）----
register({
  name: "write",
  description:
    "写入文本文件（UTF-8，单次≤1MB，原子写入）。Read Only 禁止；Workspace Write 仅限 Workspace；Full access 可用绝对路径。父目录不存在时自动创建。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "当前 Workspace 内相对文件路径，如 src/note.txt 或 work-test.txt" },
      content: { type: "string", description: "要写入的 UTF-8 文本内容" },
    },
    required: ["path", "content"],
  },
  effect: "idempotent",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    const content = String(args.content ?? "");
    // 用长度+简单校验和区分不同内容（不嵌入全文，避免 key 过大）
    let sum = 0;
    for (let i = 0; i < content.length; i++) sum = (sum + content.charCodeAt(i)) % 1_000_000;
    const pathPart = key !== null ? key : JSON.stringify(rel);
    return `path:${pathPart}:contentLen:${Buffer.byteLength(content, "utf8")}:sum:${sum}`;
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    const content = args.content;
    if (!rel) throw new Error("缺少参数 path");
    if (typeof content !== "string") throw new Error("content 必须是字符串（仅支持 UTF-8 文本）");

    // 权限规则①：仅允许写入 work/ 与 output/，禁止 input/ 及其他目录
    assertWritableZone(rel, context);

    // 单次写入限制：超限直接拒绝，不产生文件（同 read 的"结果不可用"模式，避免无谓重试）
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return `[sandbox-tool-invalid] 内容过大，超过单次写入限制 ${MAX_WRITE_BYTES} 字节，未写入: ${rel}`;
    }

    // 权限规则②：resolvePath（字符串级：禁止 ../、绝对路径）+ assertInsideWorkspace（真实路径级：symlink 逃逸）双重校验
    const real = resolveAuthorizedPath(context, rel);

    // 自动创建父目录
    const dir = path.dirname(real);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 目标存在且为目录 → 拒绝；目标不存在或为普通文件 → 允许（覆盖写入）
    try {
      const tst = fs.lstatSync(real);
      if (tst.isDirectory()) throw new Error(`是目录，无法作为文件写入: ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // ENOENT：目标不存在，允许新建
    }

    return atomicWriteContent(real, content, rel);
  },
  validateResult: (result) => {
    if (typeof result === "string" && result.startsWith("[sandbox-tool-invalid]")) {
      return { valid: false, reason: "内容过大，未写入" };
    }
    return true;
  },
});
registerAlias("write", "writeFile");

// ---- ④ edit（精确替换，oldText/newText）----
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildEditPatch(
  rel: string,
  original: string,
  edited: string,
  ranges: Array<{ index: number; oldText: string; newText: string }>
): string {
  const lines = (s: string) => s.split("\n");
  const out: string[] = [
    `编辑成功: ${rel} (${ranges.length} 处修改)`,
    `--- ${rel}`,
    `+++ ${rel}`,
  ];
  for (const r of ranges) {
    const startLine = original.slice(0, r.index).split("\n").length;
    const oldLines = lines(r.oldText);
    const newLines = lines(r.newText);
    out.push(`@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`);
    for (const l of oldLines) out.push(`-${l}`);
    for (const l of newLines) out.push(`+${l}`);
  }
  return out.join("\n");
}

register({
  name: "edit",
  description:
    "在文件中精确替换文本（oldText→newText），支持多次编辑。oldText 必须恰好匹配一次，多次匹配或找不到均拒绝；edits 不能重叠。自动保留原文件换行风格（LF/CRLF）。",
  effect: "non_idempotent",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    const edits = JSON.stringify(args.edits ?? []);
    return `path:${key ?? JSON.stringify(rel)}:edits:${edits}`;
  },
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "当前 Workspace 内相对文件路径" },
      edits: {
        type: "array",
        description: "精确替换列表，按顺序执行",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "要被替换的原文（必须唯一匹配）" },
            newText: { type: "string", description: "替换后的新文本" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    if (!rel) throw new Error("缺少参数 path");

    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) throw new Error("edits 不能为空");
    for (const e of edits) {
      if (typeof e.oldText !== "string" || typeof e.newText !== "string") {
        throw new Error("edits 中每一项必须包含 oldText 和 newText（字符串）");
      }
      if (e.oldText.length === 0) throw new Error("oldText 不能为空");
    }

    assertWritableZone(rel, context);
    const real = resolveAuthorizedPath(context, rel);

    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`文件不存在: ${rel}`);
    }
    if (st.isDirectory()) throw new Error(`是目录，无法编辑: ${rel}`);
    if (st.size > MAX_READ_BYTES) {
      return `[sandbox-tool-invalid] 文件过大，无法编辑（限制 ${MAX_READ_BYTES} 字节）: ${rel}`;
    }

    let content: string;
    try {
      content = fs.readFileSync(real, "utf8");
    } catch {
      throw new Error(`读取失败: ${rel}`);
    }

    const hasCRLF = content.includes("\r\n");
    const normalized = hasCRLF ? content.replace(/\r\n/g, "\n") : content;

    // 在原始归一化内容中定位每一次 oldText，确保恰好出现一次
    const ranges: Array<{ index: number; oldText: string; newText: string }> = [];
    for (const e of edits) {
      const idx = normalized.indexOf(e.oldText);
      if (idx === -1) {
        throw new Error(`oldText 未找到: ${JSON.stringify(e.oldText.slice(0, 80))}`);
      }
      ranges.push({ index: idx, oldText: e.oldText, newText: e.newText });
    }

    // 严格检查：每个 oldText 在内容中必须恰好出现一次
    for (const e of edits) {
      const count = (normalized.match(new RegExp(escapeRegex(e.oldText), "g")) || []).length;
      if (count !== 1) {
        throw new Error(`oldText 出现 ${count} 次（必须恰好 1 次），拒绝编辑: ${JSON.stringify(e.oldText.slice(0, 80))}`);
      }
    }

    // 检查重叠
    ranges.sort((a, b) => a.index - b.index);
    for (let i = 1; i < ranges.length; i++) {
      const prev = ranges[i - 1];
      const curr = ranges[i];
      if (prev.index + prev.oldText.length > curr.index) {
        throw new Error("edits 存在重叠修改，拒绝执行");
      }
    }

    // 逆序应用（避免索引偏移）
    let result = normalized;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const { index, oldText, newText } = ranges[i];
      result = result.slice(0, index) + newText + result.slice(index + oldText.length);
    }

    if (hasCRLF) {
      result = result.replace(/\n/g, "\r\n");
    }

    if (result === content) {
      return `无修改: ${rel}`;
    }

    const patch = buildEditPatch(rel, normalized, result, ranges);
    atomicWriteContent(real, result, rel);
    return patch;
  },
  validateResult: (result) => {
    if (typeof result === "string" && result.startsWith("[sandbox-tool-invalid]")) {
      return { valid: false, reason: "文件过大，无法编辑" };
    }
    return true;
  },
});
