// 模块: Runtime 工具（searchText / createDir / moveFile / deleteFile / shell）
// 安全契约与 filesystem.ts 一致：
// - LLM 只传工作区内相对路径；真实路径由 ToolContext.runId + resolvePath/assertInsideWorkspace 双重校验
// - 全部显式声明 effect（副作用语义必须明确）
// - shell 仅以当前 runId/work 为 cwd，拒绝宿主绝对路径，隐藏宿主环境变量，timeout + stdout/stderr 限幅
// v1.5 融合身份机制：路径类工具用 canonicalPathKey 做操作 identity 归一化（不暴露宿主绝对路径）。

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { register, type ToolContext } from "./tools.js";
import { resolvePath, assertInsideWorkspace, getSandboxRoot } from "../sandbox/sandbox-manager.js";
import { canonicalPathKey, assertWritableZone } from "./filesystem.js";

// 与 filesystem.ts 保持一致的最大限幅
const MAX_TEXT_BYTES = 1024 * 1024; // 1MB
// shell 单次输出限幅（stdout+stderr 合计）
const MAX_SHELL_OUTPUT = 64 * 1024; // 64KB
// shell 命令超时
const SHELL_TIMEOUT_MS = 10_000; // 10s

// 拒绝路径的统一脱敏消息（不泄露宿主机绝对路径）
function rejectPath(rel: string): never {
  throw new Error(
    `路径被拒绝（仅允许工作区内相对路径，禁止穿越/绝对路径/symlink 逃逸）: ${rel}`
  );
}

function guardPath(context: ToolContext, rel: string): string {
  try {
    const real = resolvePath(context.runId, rel);
    assertInsideWorkspace(context.runId, real);
    return real;
  } catch {
    rejectPath(rel);
  }
}

// v1.5: 归一化相对路径为稳定的 operation key（复用 filesystem.canonicalPathKey）
function normPathKey(context: ToolContext, rel: string): string | null {
  return canonicalPathKey(context, rel);
}

// ---- ① searchText ----
// effect: read —— 纯查询。重点压测：大量匹配 / 超大文本 / 输出过大撑爆 Context
register({
  name: "searchText",
  description:
    "在沙箱工作区内文本文件中查找子串（UTF-8，单文件≤1MB）。path 为工作区内相对文件路径，pattern 为要查找的文本。返回匹配上下文行数与位置；无匹配返回 0。",
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
    const real = guardPath(context, rel);

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
    "在沙箱工作区内创建单个目录（仅允许 work/ 或 output/ 下）。path 为工作区内相对目录路径；父目录必须已存在；已存在则幂等返回。",
  effect: "idempotent",
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? "").trim();
    const key = context ? normPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内相对目录路径，仅允许 work/ 或 output/ 开头，如 work/sub" },
    },
    required: ["path"],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? "").trim();
    if (!rel) throw new Error("缺少参数 path");
    assertWritableZone(rel);
    const real = guardPath(context, rel);

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
    "移动沙箱工作区内文件。source/target 均为工作区内相对路径，仅允许 work/ 或 output/ 下。会破坏源位置（非幂等）。",
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
    assertWritableZone(src);
    assertWritableZone(dst);
    const realSrc = guardPath(context, src);
    const realDst = guardPath(context, dst);

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
    "删除沙箱工作区内文件（仅允许 work/ 或 output/ 下，不递归删除目录）。path 为工作区内相对文件路径；文件不存在则幂等返回。",
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
    assertWritableZone(rel);
    const real = guardPath(context, rel);

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
// 注意：远端 register() 对 non_idempotent 强制要求 getOperationKey，此处用命令文本作为 canonical key。
// cwd = 当前 runId/work；禁止读取宿主绝对路径；隐藏宿主环境变量；timeout + 输出限幅
register({
  name: "shell",
  description:
    "在当前沙箱工作区的 work 目录下执行一条 shell 命令（非交互，单条，timeout 10s，输出限 64KB）。注意：命令副作用无法静态分类，重试/重放可能重复执行副作用。禁止访问工作区外路径。",
  effect: "non_idempotent",
  getOperationKey: (args) => `cmd:${String(args.command ?? "").trim()}`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要在 work 目录执行的 shell 命令（单条，禁止 cd 到工作区外）" },
    },
    required: ["command"],
  },
  execute: async (args, context) => {
    const cmd = String(args.command ?? "").trim();
    if (!cmd) throw new Error("缺少参数 command");
    // 禁止命令中显式访问工作区外绝对路径 / 穿越
    if (/\.\.[/\\]/.test(cmd) || /~\//.test(cmd) || /(^|[;|&])\s*cd\s+\.\./.test(cmd)) {
      throw new Error(`命令被拒绝（禁止工作区外路径 / cd 逃逸）: ${cmd.slice(0, 80)}`);
    }
    // cwd = 当前 runId/work（不存在则指向工作区根）
    const workDir = path.join(getSandboxRoot(), "workspaces", context.runId, "work");
    let cwd = workDir;
    try {
      if (!fs.lstatSync(workDir).isDirectory()) cwd = path.join(getSandboxRoot(), "workspaces", context.runId);
    } catch {
      cwd = path.join(getSandboxRoot(), "workspaces", context.runId);
    }

    // 用 execFile 的 shell 模式跑，隐藏宿主环境变量（仅保留 PATH=/usr/bin:/bin:/usr/sbin:/sbin）
    const result = await new Promise<string>((resolve) => {
      const child = execFile("/bin/sh", ["-c", cmd], {
        cwd,
        timeout: SHELL_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_SHELL_OUTPUT * 2,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      }, (err, so, se) => {
        const stdout = so ?? "";
        const stderr = se ?? "";
        const isTimeout = !!(err && (err as { killed?: boolean }).killed);
        const code = isTimeout
          ? null
          : (err && (err as { code?: number }).code != null ? (err as { code?: number }).code : (err ? -1 : 0));
        let head = isTimeout
          ? `[shell-timeout] 命令超时(${SHELL_TIMEOUT_MS}ms)或强制终止\n`
          : `[shell-exit-${code}]\n`;
        let body = (head + stdout + stderr).trim();
        const truncated = body.length > MAX_SHELL_OUTPUT;
        if (truncated) body = body.slice(0, MAX_SHELL_OUTPUT) + `\n...[输出已截断 ${body.length} 字符合计]`;
        resolve(body);
      });
      void child;
    });
    return result;
  },
});