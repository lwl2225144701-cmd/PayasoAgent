// 模块: Runtime 工具（searchText / createDir / moveFile / deleteFile / shell）
// 安全契约与 filesystem.ts 一致：
// - LLM 只传工作区内相对路径；真实路径由 ToolContext.workspaceRoot + 双重路径校验
// - 全部显式声明 effect（副作用语义必须明确）
// - shell 以当前 context.workspaceRoot 为 cwd；文件系统边界由 macOS OS Sandbox 强制执行
// v1.5 融合身份机制：路径类工具用 canonicalPathKey 做操作 identity 归一化（不暴露宿主绝对路径）。

import fs from "node:fs";
import path from "node:path";
import { register, type ToolContext } from "./tools.js";
import { MacOSSandbox, probeSandboxAvailability, type MacOSSandboxResult } from "../sandbox/macos-sandbox.js";
import { canonicalPathKey, assertWritableZone, resolveAuthorizedPath } from "./filesystem.js";
import { storedPermissionMode } from "../permission-mode.js";

// 与 filesystem.ts 保持一致的最大限幅
const MAX_TEXT_BYTES = 1024 * 1024; // 1MB
// v1.5: 归一化相对路径为稳定的 operation key（复用 filesystem.canonicalPathKey）
function normPathKey(context: ToolContext, rel: string): string | null {
  return canonicalPathKey(context, rel);
}

// ---- ① searchText ----
// effect: read —— 纯查询。重点压测：大量匹配 / 超大文本 / 输出过大撑爆 Context
register({
  name: "searchText",
  description:
    "在文本文件中查找子串（UTF-8，单文件≤1MB）。Read Only/Workspace Write 下仅限 Workspace；Full access 可用绝对路径。",
  effect: "read",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const pattern = String(args.pattern ?? "");
    const key = context ? normPathKey(context, rel) : null;
    const pathPart = key !== null ? key : JSON.stringify(rel);
    return `path:${pathPart}:pattern:${pattern}`;
  },
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内相对文件路径，如 work/log.txt" },
      pattern: { type: "string", description: "要查找的文本子串（非正则）" },
    },
    required: ["path", "pattern"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    const pattern = String(args.pattern ?? "");
    if (!rel) throw new Error("缺少参数 path");
    if (!pattern) throw new Error("缺少参数 pattern");
    const real = resolveAuthorizedPath(context, rel);

    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`文件不存在: ${rel}`);
    }
    if (st.isDirectory()) throw new Error(`是目录，无法搜索: ${rel}`);
    if (st.size > MAX_TEXT_BYTES) {
      return `[sandbox-tool-invalid] 文件过大，无法搜索（限制 ${MAX_TEXT_BYTES} 字节）: ${rel}`;
    }
    const buf = fs.readFileSync(real);

    const isBinary = () => {
      const sample = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
      let ctrl = 0;
      for (const b of sample) {
        if (b === 0x00) return true;
        if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) ctrl++;
      }
      return ctrl > sample.length / 10;
    };
    if (isBinary()) {
      return `[sandbox-tool-invalid] 二进制文件，不支持文本搜索: ${rel}`;
    }

    const text = buf.toString("utf8");
    const lines = text.split("\n");
    let count = 0;
    let firstLine = -1;
    let lastLine = -1;
    const previews: string[] = [];
    for (let li = 0; li < lines.length; li++) {
      if (lines[li].includes(pattern)) {
        count++;
        if (firstLine < 0) firstLine = li + 1;
        lastLine = li + 1;
        if (previews.length < 20) previews.push(`${li + 1}: ${lines[li].slice(0, 80)}`);
      }
    }
    // 结果长度受限：只回前 20 个匹配 + 统计，避免把大文件全文灌回 Context
    if (count === 0) return `未在 ${rel} 中找到 "${pattern}"（共${lines.length}行）`;
    const previewBlock =
      previews.length > 0 ? `\n匹配（前${previews.length}条）:\n${previews.join("\n")}` : "";
    return `在 ${rel} 中找到 ${count} 处 "${pattern}"（首行${firstLine}，末行${lastLine}，共${lines.length}行）${previewBlock}`;
  },
  validateResult: (result) => {
    if (typeof result === "string" && result.startsWith("[sandbox-tool-invalid]")) {
      return { valid: false, reason: "文件过大或二进制，无法搜索" };
    }
    return true;
  },
});

// ---- ② createDir ----
// effect: idempotent —— 已存在则幂等返回成功；只创建相对路径（父级需已存在）
register({
  name: "createDir",
  description:
    "创建单个目录。Read Only 禁止；Workspace Write 仅限 Workspace；Full access 可用绝对路径。父目录必须已存在。",
  effect: "idempotent",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? normPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "当前 Workspace 内相对目录路径，如 src/generated" },
    },
    required: ["path"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    if (!rel) throw new Error("缺少参数 path");
    assertWritableZone(rel, context);
    const real = resolveAuthorizedPath(context, rel);

    // 父目录必须已存在
    const parent = path.dirname(real);
    try {
      if (!fs.lstatSync(parent).isDirectory()) throw new Error("父路径不是目录");
    } catch (err) {
      if (real === parent) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`父目录不存在，不自动创建: ${rel}`);
      }
      throw err;
    }
    // 目标已存在且是目录 → 幂等；已存在且是文件 → 拒绝
    try {
      const st = fs.lstatSync(real);
      if (st.isDirectory()) return `目录已存在(幂等): ${rel}`;
      throw new Error(`目标已存在但不是目录，无法创建: ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !(err as Error).message.includes("目标已存在")) {
        throw err;
      }
    }
    fs.mkdirSync(real);
    return `创建目录成功: ${rel}`;
  },
});

// ---- ③ moveFile ----
// effect: non_idempotent —— 移动破坏源，重复执行会因源不存在而失败
register({
  name: "moveFile",
  description:
    "移动文件。Read Only 禁止；Workspace Write 的 source/target 仅限 Workspace；Full access 可用绝对路径。会破坏源位置。",
  effect: "non_idempotent",
  getOperationKey: (args, context) => {
    const src = String(args.source ?? "").trim();
    const dst = String(args.target ?? "").trim();
    const sk = context ? normPathKey(context, src) : null;
    const dk = context ? normPathKey(context, dst) : null;
    return `src:${sk ?? JSON.stringify(src)}:dst:${dk ?? JSON.stringify(dst)}`;
  },
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "源相对路径，如 work/a.txt" },
      target: { type: "string", description: "目标相对路径，如 work/sub/b.txt" },
    },
    required: ["source", "target"],
  },
  execute: async (args, context) => {
    const src = String(args.source ?? "").trim();
    const dst = String(args.target ?? "").trim();
    if (!src) throw new Error("缺少参数 source");
    if (!dst) throw new Error("缺少参数 target");
    assertWritableZone(src, context);
    assertWritableZone(dst, context);
    const realSrc = resolveAuthorizedPath(context, src);
    const realDst = resolveAuthorizedPath(context, dst);

    try {
      if (!fs.lstatSync(realSrc).isFile()) throw new Error("源不是普通文件");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`源文件不存在: ${src}`);
      }
      throw err;
    }
    // 目标已存在 → 拒绝（避免静默覆盖；让副作用分类语义清晰）
    try {
      fs.lstatSync(realDst);
      throw new Error(`目标已存在，拒绝覆盖（如需覆盖请先删除目标）: ${dst}`);
    } catch (err) {
      if (!(err as Error).message.includes("目标已存在")) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      } else {
        throw err;
      }
    }
    fs.renameSync(realSrc, realDst);
    return `移动成功: ${src} → ${dst}`;
  },
});

// ---- ④ deleteFile ----
// effect: idempotent —— 删除不存在的文件幂等返回（第二次当"已不存在"）
register({
  name: "deleteFile",
  description:
    "删除文件（不递归删除目录）。Read Only 禁止；Workspace Write 仅限 Workspace；Full access 可用绝对路径。",
  effect: "idempotent",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? normPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内相对文件路径，如 work/a.txt" },
    },
    required: ["path"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    if (!rel) throw new Error("缺少参数 path");
    assertWritableZone(rel, context);
    const real = resolveAuthorizedPath(context, rel);

    try {
      const st = fs.lstatSync(real);
      if (st.isDirectory()) throw new Error(`是目录，请勿用 deleteFile 删除目录: ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return `文件不存在(幂等): ${rel}`;
      }
      throw err;
    }
    fs.rmSync(real, { force: true });
    return `删除成功: ${rel}`;
  },
});

// ---- ⑤ shell ----
// effect: non_idempotent —— 命令副作用无法可靠静态判断，最保守声明。
// 静态命令过滤不是安全边界；真正边界由 macOS sandbox-exec 强制执行。
register({
  name: "shell",
  description:
    "执行一条 shell 命令（macOS OS Sandbox，cwd=Workspace，非交互，timeout 10s，输出限64KB）。文件访问服从当前 Read Only/Workspace Write/Full access 权限；所有模式及子进程均禁止网络。",
  effect: "non_idempotent",
  getOperationKey: (args) => `cmd:${String(args.command ?? "").trim()}`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要在当前 Workspace 根目录执行的 shell 命令" },
    },
    required: ["command"],
  },
  execute: async (args, context) => {
    const cmd = String(args.command ?? "").trim();
    if (!cmd) throw new Error("缺少参数 command");

    // Fail-closed gate: never run an unsandboxed shell. sandbox-exec is
    // deprecated; on some macOS releases (e.g. macOS 26) it cannot apply any
    // profile ("Operation not permitted"). When the primitive is unavailable
    // the shell tool refuses, so containment is never silently dropped.
    if (!(await probeSandboxAvailability())) {
      throw new Error(
        "Shell tool unavailable: macOS OS sandbox (sandbox-exec) cannot be applied on this system " +
        "(sandbox_apply: Operation not permitted). Refusing to run an unsandboxed shell to preserve " +
        "filesystem containment."
      );
    }

    const workspaceRoot = context.workspaceRoot;
    const permissionMode = storedPermissionMode(context.permissionMode);
    const workDir = workspaceRoot;
    // HOME/TMPDIR must stay under the same authorized root. Use an ephemeral
    // per-call directory so npm/tsx caches never become project artifacts.
    const runtimeDir = permissionMode === "read-only"
      ? null
      : fs.mkdtempSync(path.join(workspaceRoot, ".payaso-shell-"));
    const home = runtimeDir ?? workspaceRoot;
    const tmpdir = runtimeDir ?? workspaceRoot;

    let result: MacOSSandboxResult;
    try {
      const sandbox = MacOSSandbox.forWorkspace(workspaceRoot, permissionMode);
      result = await sandbox.run(cmd, {
        cwd: workDir,
        home,
        tmpdir,
        signal: context.signal,
        onEvent: (event) => {
          if (event === "started") {
            context.onSandboxEvent?.({ type: "shell_sandbox_started", platform: "macos" });
          } else {
            context.onSandboxEvent?.({
              type: "shell_sandbox_denied",
              platform: "macos",
              reason: "workspace_policy",
            });
          }
        },
      });
    } finally {
      if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
    }

    if (result.denied) {
      // Do not expose stderr or host paths to the LLM/context.
      throw new Error("Shell operation denied by workspace sandbox.");
    }

    const head = result.timedOut
      ? "[shell-timeout] 命令超时(10000ms)或强制终止\n"
      : `[shell-exit-${result.exitCode ?? -1}]\n`;
    return (head + result.stdout + result.stderr).trim();
  },
});
