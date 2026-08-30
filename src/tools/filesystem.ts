// 模块: Sandbox 文件工具（只读 listDir / readFile + 受控写入 writeFile）
// 安全契约：LLM 只传工作区内相对路径；真实路径由 Runtime 注入的 ToolContext.workspaceRoot +
// resolveWorkspacePath / assertInsideRoot 解析与校验。
// 核心原则：模型决定读取什么，Runtime 决定在哪里读取。
// v1.5 融合身份机制：路径类工具用 canonicalPathKey 做 operation key 归一化（不暴露宿主绝对路径）。

import fs from "node:fs";
import path from "node:path";
import { register, type ToolContext } from "./tools.js";
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
    "列出目录条目（名称与类型 file/directory），不递归。Read Only/Workspace Write 下 path 必须是 Workspace 相对路径；Full access 下也可使用绝对路径。",
  // 只读目录枚举，无副作用
  effect: "read",
  // 路径类工具：归一化相对路径为操作 key（./ 与根段 → 同一 key，不暴露宿主绝对路径）
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

// ---- readFile ----
register({
  name: "readFile",
  description:
    "读取文本文件内容（UTF-8，最大 1MB，不支持二进制）。Read Only/Workspace Write 下仅限 Workspace；Full access 下可使用绝对路径。",
  // 只读文件读取，无副作用
  effect: "read",
  // 路径类工具：归一化相对路径为操作 key
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
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

// ---- 可写区权限（writeFile / createDir / moveFile / deleteFile 共用）----
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

// ---- writeFile ----
// effect: idempotent —— 覆盖写文件重复执行结果等价（同一 path+content 内核不变），可安全重试 / 重放。
// identity: 同一 path 归一化后归一于同一 key；不同 content → 不同 operation（避免不同内容被误判为重放）。
register({
  name: "writeFile",
  description:
    "写入文本文件（UTF-8，单次≤1MB，原子写入）。Read Only 禁止；Workspace Write 仅限 Workspace 相对路径；Full access 可用绝对路径。父目录必须已存在。",
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

    // 单次写入限制：超限直接拒绝，不产生文件（同 readFile 的"结果不可用"模式，避免无谓重试）
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return `[sandbox-tool-invalid] 内容过大，超过单次写入限制 ${MAX_WRITE_BYTES} 字节，未写入: ${rel}`;
    }

    // 权限规则②：resolvePath（字符串级：禁止 ../、绝对路径）+ assertInsideWorkspace（真实路径级：symlink 逃逸）双重校验
    const real = resolveAuthorizedPath(context, rel);

    // 父目录必须已存在（暂不自动创建任意目录）
    let dirSt: fs.Stats;
    try {
      dirSt = fs.lstatSync(path.dirname(real));
    } catch {
      throw new Error(`父目录不存在，无法写入（暂不支持自动创建目录）: ${rel}`);
    }
    if (!dirSt.isDirectory()) {
      throw new Error(`父路径不是目录，无法写入: ${rel}`);
    }

    // 目标存在且为目录 → 拒绝；目标不存在或为普通文件 → 允许（覆盖写入）
    try {
      const tst = fs.lstatSync(real);
      if (tst.isDirectory()) throw new Error(`是目录，无法作为文件写入: ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // ENOENT：目标不存在，允许新建
    }

    // 原子写入：同目录临时文件 → rename（覆盖已有文件也是原子替换，避免进程中断产生半文件）
    const tmp = path.join(
      path.dirname(real),
      `.${path.basename(real)}.payaso-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
    );
    try {
      fs.writeFileSync(tmp, content, "utf8");
      fs.renameSync(tmp, real);
    } catch (err) {
      // 清理残留临时文件；错误仅回显相对路径，不泄露宿主机绝对路径
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 忽略清理失败 */
      }
      throw new Error(`写入失败: ${rel}`);
    }

    return `写入成功: ${rel}`;
  },
  // 内容超限 → 工具"执行"完成但未产生有效写入 → tool_result_invalid
  validateResult: (result) => {
    if (typeof result === "string" && result.startsWith("[sandbox-tool-invalid]")) {
      return { valid: false, reason: "内容过大，未写入" };
    }
    return true;
  },
});
