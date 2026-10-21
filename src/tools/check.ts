// Module: Check Tool — 可信检查的工具入口（计划 §5.1）。
//
// 这一层只负责**参数契约**：Schema、profile 互斥校验、解释器承载拒绝、超时沿用
// Shell 策略、能力声明与结果摘要。真正"跑进程 + 采日志 + 出结论"在 check-runner.ts。
//
// 为什么把解释器承载单独拦掉（§5.1 第 6 条）：
// check 的价值在于结论可以追溯到"实际执行程序"的退出协议与它的完整输出。一旦
// 允许 `program=bash, args=["-c","npm test"]`，脚本又重新变成模型可控的自由文本，
// 管道/分号/重定向再次参与语义 —— 检查对象被包装掉，协议退化回 shell。需要脚本
// 时请回到 shell 工具，它的结果不自动升级为本协议的可信检查。
//
// 副作用与网络（§5.1 末段）：effect=non_idempotent（跑测试可能写文件、起服务、
// 花钱），网络能力与 Shell 完全一致（capabilities.network=true，跟随全局
// network.mode），授权/超时/取消/副作用流程一律沿用，不因为名字叫"检查"就假设无副作用。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EXECUTION_EVIDENCE_VERSION, isWorkspaceRelativePath } from '../execution-evidence.js';
import { toolTimeoutPolicy } from '../runtime/tool-invocation/process-manager.js';
import { createShellScratch, type ShellScratch } from '../sandbox/shell-scratch.js';
import { resolveShellTimeout, shellTimeoutPolicy } from '../sandbox/shell-timeout.js';
import {
  resolveToolOutputBudget,
  sliceTextToBudget,
  utf8ByteLength,
  utf8Head,
} from '../tool-output-budget.js';
import {
  type BiomeBaselineComparison,
  type BiomeBaselineDeps,
  biomeFacts,
  biomeInputFingerprint,
  describeBiomeComparison,
  runBiomeBaseline,
} from './check-baseline.js';
import {
  CHECK_TOOL_NAME,
  type CheckRunnerDeps,
  type CheckRunOutcome,
  runCheckProcess,
} from './check-runner.js';
import { canonicalPathKey, resolveAuthorizedPath } from './filesystem.js';
import {
  register,
  type Tool,
  type ToolContext,
  type ToolEffect,
  type ToolResult,
} from './tools.js';

/** 工具名单一来源在 check-runner（工具名同时决定日志发布的前缀）。 */
export { CHECK_TOOL_NAME };

/** 首版 profile：biome-lint 的分支由批次 D 实现（本批次显式返回"未实现"）。 */
export type CheckProfile = 'process' | 'biome-lint';

export const CHECK_PROFILES: readonly CheckProfile[] = ['process', 'biome-lint'];

/** 单条 check 的容量上限（与执行证据协议同一来源，见 src/execution-evidence.ts）。 */
export const MAX_CHECK_PATHS = 64;
export const MAX_CHECK_ARGS = 256;

/**
 * 承载脚本的解释器：出现在 program 位置即拒绝。命令名按基名 + 去扩展名比较
 * （`bash`、`/bin/sh`、`powershell.exe`、`PWSH` 都命中）。`node` 不在其中：
 * 计划明确支持"通过 node 显式运行的 JS 入口"。
 */
const INTERPRETER_CARRIERS = new Set([
  'sh',
  'bash',
  'zsh',
  'ksh',
  'dash',
  'ash',
  'fish',
  'csh',
  'tcsh',
  'cmd',
  'command',
  'powershell',
  'pwsh',
]);

/** 批处理文件不是原生进程（§5.1：Windows 的 .cmd/.bat 不作为原生进程执行）。 */
const SCRIPT_ONLY_EXECUTABLES = /\.(cmd|bat|com)$/i;

export interface CheckParameterIssue {
  code:
    | 'invalid_profile'
    | 'missing_argument'
    | 'mutually_exclusive'
    | 'unknown_argument'
    | 'invalid_type'
    | 'interpreter_carrier'
    | 'unsupported_executable'
    | 'unsupported_path'
    | 'unsupported_file_type'
    | 'too_many_items';
  message: string;
}

export type NormalizedCheck =
  | {
      ok: true;
      profile: 'process';
      cwd: string;
      program: string;
      programIsRelative: boolean;
      args: string[];
      timeoutMs: number;
      reuse: boolean;
    }
  | {
      ok: true;
      profile: 'biome-lint';
      cwd: string;
      paths: string[];
      baseline?: 'HEAD';
      timeoutMs: number;
      reuse: boolean;
    }
  | { ok: false; issues: CheckParameterIssue[] };

const CHECK_ARGUMENT_NAMES = [
  'profile',
  'cwd',
  'program',
  'args',
  'paths',
  'baseline',
  'timeoutMs',
  'reuse',
] as const;

function carrierKey(program: string): string {
  const base = program.split(/[\\/]/).filter(Boolean).pop() ?? program;
  return base.toLowerCase().replace(/\.(exe|sh|bash|zsh|cmd|bat|com)$/, '');
}

/**
 * 相对输入归一化：`./src` 与 `src` 是同一个位置（仅显示/身份层面统一，
 * 安全校验仍按原规则做 —— 归一化后的值继续禁止绝对路径与 .. 逃逸）。
 */
function normalizeRelativeInput(value: string): string {
  const trimmed = value.trim();
  const stripped = trimmed.replace(/^\.\//, '');
  return stripped === '' ? '.' : stripped;
}

function isWorkspaceRelativeInput(value: string): boolean {
  const normalized = normalizeRelativeInput(value);
  return normalized === '.' || isWorkspaceRelativePath(normalized);
}

/** 只用于错误文案：不把参数原文无限塞进消息里。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 参数契约校验（纯函数，测试直接断言）。
 * 互斥规则固定为：`profile=process` 必填 program/args、禁 paths/baseline；
 * `profile=biome-lint` 必填 paths（首版仅 CSS）、禁 program/args。
 */
export function normalizeCheckArgs(raw: Record<string, unknown>): NormalizedCheck {
  const issues: CheckParameterIssue[] = [];
  const push = (code: CheckParameterIssue['code'], message: string): void => {
    if (issues.length < 8) issues.push({ code, message });
  };

  const profile = raw.profile;
  if (typeof profile !== 'string' || !(CHECK_PROFILES as readonly string[]).includes(profile)) {
    return {
      ok: false,
      issues: [
        {
          code: 'invalid_profile',
          message: `profile 必须是 ${CHECK_PROFILES.join(' | ')} 之一（当前: ${safeJson(profile)}）。`,
        },
      ],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!(CHECK_ARGUMENT_NAMES as readonly string[]).includes(key)) {
      push(
        'unknown_argument',
        `未知参数 "${key}"。check 只接受：${CHECK_ARGUMENT_NAMES.join(', ')}。`,
      );
    }
  }

  const cwd = raw.cwd === undefined ? '.' : raw.cwd;
  if (typeof cwd !== 'string' || !isWorkspaceRelativeInput(cwd)) {
    push(
      'unsupported_path',
      `cwd 必须是工作区内相对路径（禁止宿主绝对路径与 .. 逃逸），当前: ${safeJson(raw.cwd)}。`,
    );
  }

  const reuse = raw.reuse === undefined ? true : raw.reuse;
  if (typeof reuse !== 'boolean') {
    push('invalid_type', 'reuse 必须是布尔值。');
  }

  if (raw.timeoutMs !== undefined) {
    const requested = typeof raw.timeoutMs === 'number' ? raw.timeoutMs : Number(raw.timeoutMs);
    if (!Number.isFinite(requested) || requested <= 0) {
      push('invalid_type', 'timeoutMs 必须是正数毫秒（沿用 Shell 超时策略并被收敛到上下限之间）。');
    }
  }
  const timeoutMs = resolveShellTimeout(raw.timeoutMs, shellTimeoutPolicy());

  if (profile === 'process') {
    if (raw.paths !== undefined) {
      push('mutually_exclusive', 'profile=process 不接受 paths（paths 只属于 biome-lint）。');
    }
    if (raw.baseline !== undefined) {
      push('mutually_exclusive', 'profile=process 不接受 baseline（baseline 只属于 biome-lint）。');
    }
    const program = raw.program;
    if (typeof program !== 'string' || program.trim() === '') {
      push('missing_argument', 'profile=process 必须提供 program（可执行名称或工作区相对路径）。');
    }
    if (raw.args === undefined || !Array.isArray(raw.args)) {
      push(
        'missing_argument',
        'profile=process 必须提供 args 字符串数组（每项作为字面参数传入，即使为空数组也用 [])。',
      );
    } else if (!raw.args.every((item) => typeof item === 'string')) {
      push('invalid_type', 'args 的每一项都必须是字符串（字面 argv，不做任何拼接或转义）。');
    } else if (raw.args.length > MAX_CHECK_ARGS) {
      push('too_many_items', `args 最多 ${MAX_CHECK_ARGS} 项。`);
    }
    if (issues.length) return { ok: false, issues };

    const programText = normalizeRelativeInput(program as string);
    // 解释器判定先于绝对路径判定：`/bin/sh` 既越界又是承载，"回到 shell 工具"
    // 是更可操作的指引；其余宿主绝对路径仍由下一条规则拒绝。
    if (INTERPRETER_CARRIERS.has(carrierKey(programText))) {
      push('interpreter_carrier', interpreterRefusalMessage(programText));
      return { ok: false, issues };
    }
    if (path.isAbsolute(programText) || programText.startsWith('~')) {
      push(
        'unsupported_path',
        `program 必须是可执行名称或工作区相对路径，不接受宿主绝对路径: ${programText}。`,
      );
      return { ok: false, issues };
    }
    if (SCRIPT_ONLY_EXECUTABLES.test(programText)) {
      push(
        'unsupported_executable',
        `"${programText}" 是批处理脚本而不是原生进程，check 不通过解释器承载它。` +
          `请调用实际的原生程序，或改用 shell 工具执行脚本。`,
      );
      return { ok: false, issues };
    }
    // 空字符串 argv（如 [""]）原样传给子进程：字面承诺保持字面，不做清洗。
    const args = raw.args as string[];
    return {
      ok: true,
      profile: 'process',
      cwd: normalizeRelativeInput(cwd as string),
      program: programText,
      programIsRelative: programText.includes('/') || programText.includes('\\'),
      args,
      timeoutMs,
      reuse: reuse as boolean,
    };
  }

  // profile === 'biome-lint'
  if (raw.program !== undefined) {
    push('mutually_exclusive', 'profile=biome-lint 不接受 program（参数由适配器构造）。');
  }
  if (raw.args !== undefined) {
    push('mutually_exclusive', 'profile=biome-lint 不接受 args（参数由适配器构造）。');
  }
  if (raw.paths === undefined || !Array.isArray(raw.paths)) {
    push('missing_argument', 'profile=biome-lint 必须提供 paths（工作区相对 CSS 文件数组）。');
  } else if (!raw.paths.every((item) => typeof item === 'string')) {
    push('invalid_type', 'paths 的每一项都必须是字符串。');
  } else if (raw.paths.length === 0) {
    push('missing_argument', 'paths 不能为空数组。');
  } else if (raw.paths.length > MAX_CHECK_PATHS) {
    push('too_many_items', `paths 最多 ${MAX_CHECK_PATHS} 项。`);
  } else {
    for (const rawPath of raw.paths as string[]) {
      const item = normalizeRelativeInput(rawPath);
      if (!isWorkspaceRelativeInput(rawPath)) {
        push('unsupported_path', `paths 必须是工作区内相对路径（禁止绝对/穿越）: ${item}。`);
        continue;
      }
      // 首版只支持 CSS：不静默扩大范围，明确说明边界（批次 D 再接更多文件类型）。
      if (!/\.css$/i.test(item)) {
        push('unsupported_file_type', `biome-lint 首版只支持 .css 文件，当前: ${item}。`);
      }
    }
  }
  if (raw.baseline !== undefined && raw.baseline !== 'HEAD') {
    push('invalid_type', "baseline 只支持 'HEAD'（执行开始时解析为固定 SHA）。");
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    profile: 'biome-lint',
    cwd: normalizeRelativeInput(cwd as string),
    paths: raw.paths as string[],
    ...(raw.baseline === 'HEAD' ? { baseline: 'HEAD' as const } : {}),
    timeoutMs,
    reuse: reuse as boolean,
  };
}

function interpreterRefusalMessage(program: string): string {
  return (
    `check 拒绝以命令解释器承载脚本（program="${program}"）：` +
    'program/args 必须是原生程序 + 字面参数数组，否则检查对象又被包装成模型可控的脚本，' +
    '管道/分号/重定向重新参与语义，结论就无法追溯到实际执行程序。\n' +
    '请改成下面两种之一：\n' +
    '1) 直接给出实际程序，例如 ' +
    '{"profile":"process","program":"node","args":["--import","tsx","tests/example.test.ts"]}；' +
    '2) 确实需要脚本能力（管道、分号、重定向、多命令组合）时回到 shell 工具——' +
    '它的结果不自动升级为本协议的可信检查。'
  );
}

/** check 的 LLM 可见 Schema（不含任何 Runtime 内部字段）。 */
export const checkToolParameters = {
  type: 'object',
  properties: {
    profile: {
      type: 'string',
      enum: [...CHECK_PROFILES],
      description:
        '检查类型：process=以原生程序 + 字面参数数组跑一次进程；biome-lint=首版仅支持工作区内 .css 文件的 Biome 检查（自动解析工作区已安装工具，baseline=HEAD 时在隔离视图中比较，不改动真实工作区）。',
    },
    cwd: {
      type: 'string',
      description: '工作区内相对执行目录，默认 "."。禁止宿主绝对路径与 .. 逃逸。',
    },
    program: {
      type: 'string',
      description:
        'profile=process 必填：可执行名称或工作区相对可执行文件路径。不接受 sh/bash/zsh/cmd/powershell/pwsh 等解释器承载脚本。',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description:
        'profile=process 必填：字面参数数组，每项原样传给子进程（| ; $ 引号都不被解释）；无参数时传 []。',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'profile=biome-lint 必填：工作区相对 .css 文件列表；process 不接受此参数。',
    },
    baseline: {
      type: 'string',
      enum: ['HEAD'],
      description: "仅 biome-lint 支持，首版只接受 'HEAD'；process 不接受此参数。",
    },
    timeoutMs: {
      type: 'number',
      description:
        '可选：本次检查的超时毫秒数，沿用 shell 的超时策略与上下限（超出范围会被收敛）。',
    },
    reuse: {
      type: 'boolean',
      description:
        '可选，默认 true。本批次没有事实存储，process 总是实际执行；结果永不来自缓存记录。',
    },
  },
  required: ['profile'],
} as const;

/**
 * 过渡版 canonical operation key（注册守卫要求 non_idempotent 必须显式声明身份）。
 *
 * 规范化内容：profile + program + 字面 args + cwd +（biome-lint 的）排序去重 paths + baseline。
 * 刻意不含 timeoutMs/reuse：换超时或换复用意图是同一次检查，不是另一个操作。
 * 路径用 canonicalPathKey 归一化（`./src` 与 `src` 同键），且不暴露宿主绝对路径。
 *
 * 批次 C 升级点（计划 §6.3）：由 Runtime 注入 invocationId 作为执行身份，
 * 从而区分"同一次调用的重放/恢复"与"同参数的新检查"；届时本函数只作为
 * 身份里的"检查对象"组成部分，不再是唯一身份来源。
 */
export function checkSpecDigest(args: Record<string, unknown>, context?: ToolContext): string {
  const normalized = normalizeCheckArgs(args);
  if (!normalized.ok) {
    // 参数不合法时身份不可猜：回退到规范化的原始 JSON（调用会同样在 execute 处失败）。
    return `check:v0:invalid:${digest(safeJson(args))}`;
  }
  const cwdKey =
    normalized.cwd === '.' ? '/' : (contextKey(context, normalized.cwd) ?? normalized.cwd);
  const parts: string[] = [`check:v1:profile:${normalized.profile}`, `cwd:${cwdKey}`];
  if (normalized.profile === 'process') {
    const programKey = normalized.programIsRelative
      ? (contextKey(context, normalized.program) ?? normalized.program)
      : `name:${normalized.program.toLowerCase()}`;
    parts.push(`program:${programKey}`, `args:${digest(JSON.stringify(normalized.args))}`);
  } else {
    const paths = [...new Set(normalized.paths)].sort();
    parts.push(
      `paths:${digest(JSON.stringify(paths.map((item) => contextKey(context, item) ?? item)))}`,
      `baseline:${normalized.baseline ?? 'none'}`,
    );
  }
  return parts.join(':');
}

/**
 * 执行身份（批次 C 升级，计划 §6.3）：
 * - 有 Runtime 注入的 invocationId 时，身份就是该次调用（resume 重放命中同一次执行；
 *   同参数的新调用是另一个身份，不会被旧副作用回放掩盖）；
 * - 没有注入身份时（旧调用路径/测试）退化为检查对象摘要，保持向后兼容。
 */
export function checkOperationKey(args: Record<string, unknown>, context?: ToolContext): string {
  const invocationId = context?.invocationId;
  if (typeof invocationId === 'string' && invocationId !== '') {
    return `check:v2:invocation:${invocationId}`;
  }
  return checkSpecDigest(args, context);
}

function contextKey(context: ToolContext | undefined, rel: string): string | null {
  if (!context) return null;
  return canonicalPathKey(context, rel);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

/** 副作用类别：检查进程可能写快照、起服务、花钱，一律 non_idempotent（§5.1）。 */
export const checkToolEffect: ToolEffect = 'non_idempotent';

/**
 * 模型可见文本：统一走 src/tool-output-budget.ts（不复制截断常量）。
 * 结构 = 单行 JSON 摘要 + stdout 有界切片 + stderr 有界切片 + 完整日志引用提示。
 * 摘要里的 `args` 是字面 argv 的回显，过长时先截摘要，保证正文永远够得着预算。
 */
export function describeCheckOutcome(
  outcome: CheckRunOutcome,
  summary: Record<string, unknown>,
): string {
  const budget = resolveToolOutputBudget();
  const headCap = Math.max(512, Math.floor(budget.maxBytes * 0.5));
  const rawHeader = `${JSON.stringify(summary)}\n`;
  const header =
    utf8ByteLength(rawHeader) <= headCap
      ? rawHeader
      : `${utf8Head(rawHeader, headCap)}\n[参数摘要过长，已截断]\n`;
  const refs: string[] = [];
  if (outcome.stdoutRef) refs.push(`stdout=${outcome.stdoutRef}`);
  if (outcome.stderrRef) refs.push(`stderr=${outcome.stderrRef}`);
  const notice = refs.length
    ? `\n[完整日志已发布，可用 read 读回：${refs.join('  ')}]`
    : '\n[本次没有需要发布的日志内容]';
  const available = Math.max(
    256,
    budget.maxBytes - utf8ByteLength(header) - utf8ByteLength(notice) - 96,
  );
  const body: string[] = [header];
  if (outcome.stdoutText.length || outcome.stderrText.length) {
    if (outcome.stdoutText.length) {
      const stdoutBudget = Math.floor(available * 0.72);
      const stdout = sliceTextToBudget(outcome.stdoutText, {
        maxBytes: stdoutBudget,
        headBytes: Math.floor(stdoutBudget * 0.62),
        tailBytes: Math.floor(stdoutBudget * 0.24),
      });
      body.push(`--- stdout (collected ${outcome.stdoutBytes} bytes) ---\n`, stdout.content, '\n');
    }
    if (outcome.stderrText.length) {
      const stderrBudget = Math.floor(available * 0.24);
      const stderr = sliceTextToBudget(outcome.stderrText, {
        maxBytes: stderrBudget,
        headBytes: Math.floor(stderrBudget * 0.62),
        tailBytes: Math.floor(stderrBudget * 0.24),
      });
      body.push(`--- stderr (collected ${outcome.stderrBytes} bytes) ---\n`, stderr.content, '\n');
    }
  } else {
    body.push('[进程无输出]\n');
  }
  body.push(notice);
  const text = body.join('');
  if (utf8ByteLength(text) <= budget.maxBytes) return text;
  return sliceTextToBudget(text).content;
}

/**
 * check 工具实现（未注册进默认工具集：批次 B 不暴露给真实模型，见 §11.1）。
 * 注册入口建议：`src/tools/runtime-tools.ts` 末尾 `registerCheckTool()`（由
 * bootstrap 的统一注册路径调用），或后续批次在 bootstrap 层显式装配。
 */
export const checkTool: Tool = {
  name: CHECK_TOOL_NAME,
  description:
    '以原生程序 + 字面参数数组执行一次可信检查（profile=process），或运行首版仅 CSS 的 Biome 检查（profile=biome-lint；baseline=HEAD 时给出 introduced/resolved，不 checkout/stash 真实工作区）。' +
    '不接受 sh/bash/zsh/cmd/powershell/pwsh 等解释器承载脚本，也不接受宿主绝对路径：需要管道/分号/重定向时改用 shell 工具。' +
    'process 的 passed 只代表进程退出协议通过（exit 0、未超时），不代表测试覆盖完整或用户任务已验收。' +
    '例如 {"profile":"process","program":"npx","args":["tsc","--noEmit"]}。' +
    '验证命令优先直接交给 check，保留真实退出码；shell 中 command | tail 后的 $? 是 tail 的状态。' +
    `完整 stdout/stderr 单独发布为可 read 读回的日志；模型可见文本受统一输出预算约束。超时沿用 shell 策略。`,
  effect: checkToolEffect,
  evidenceKind: 'check',
  getEvidenceFingerprint: (args, context) => {
    const normalized = normalizeCheckArgs(args);
    if (
      !normalized.ok ||
      normalized.profile !== 'biome-lint' ||
      normalized.baseline ||
      normalized.cwd !== '.'
    )
      return null;
    return biomeInputFingerprint(context, normalized.paths, normalized.timeoutMs);
  },
  // 网络能力与 Shell 一致：跟随全局 network.mode（off 时整次调用被统一拒绝）。
  capabilities: { network: true },
  // 工具级 deadline 必须晚于命令级超时，否则 [check-timeout] 会被外层 TOOL_TIMEOUT 吞掉。
  timeoutMs: () => Math.max(toolTimeoutPolicy().maxMs, shellTimeoutPolicy().maxMs + 30_000),
  getOperationKey: checkOperationKey,
  parameters: checkToolParameters,
  // 批次 B：不进 LLM Schema（§11.1"接入期间工具暂不暴露给真实模型"）。
  hidden: true,
  execute: async (args, context) => executeCheck(args, context),
};

/** 注册入口（批次 C/D 接线时调用；本批次默认不注册，模型看不到该工具）。 */
export function registerCheckTool(tool: Tool = checkTool): void {
  register({ ...tool, hidden: tool.hidden ?? false });
}

/** biome-lint 视图用的受管 scratch（生命周期归本次调用）。 */
function createScratchForViews(context: ToolContext, deps: CheckRunnerDeps): ShellScratch {
  const create = deps.createScratch ?? ((scope: string) => createShellScratch(scope));
  return create(`${context.runId}-biome-view`);
}

/** 执行一次 check：返回对象型 ToolResult（文本 + facts），字符串通路不受影响。 */
export async function executeCheck(
  rawArgs: Record<string, unknown>,
  context: ToolContext,
  deps: CheckRunnerDeps = {},
): Promise<ToolResult> {
  const biomeDeps: BiomeBaselineDeps = deps;
  const normalized = normalizeCheckArgs(rawArgs);
  if (!normalized.ok) {
    throw new Error(
      `[check-invalid-arguments]\n${normalized.issues.map((issue) => `- ${issue.message}`).join('\n')}`,
    );
  }

  if (normalized.profile === 'biome-lint') {
    // 批次 D：固定适配器构造 argv（lint --reporter=json <files>），
    // baseline=HEAD 时在一个调用内完成"HEAD 固定 SHA → 双隔离视图 → 多重集合比较"。
    const scratch = createScratchForViews(context, biomeDeps);
    try {
      const result = await runBiomeBaseline({
        context,
        workspaceRoot: context.workspaceRoot,
        paths: normalized.paths,
        timeoutMs: normalized.timeoutMs,
        baseline: normalized.baseline === 'HEAD',
        deps: { ...biomeDeps, scratchRoot: scratch.path },
      });
      if (!result.install.ok) {
        // 工具没装/版本不支持/入口越界：明确 unsupported，不跑任何程序。
        const unsupported = {
          tool: CHECK_TOOL_NAME,
          version: 1,
          profile: 'biome-lint',
          conclusion: 'inconclusive',
          comparison: 'unknown',
          reason: result.install.reason,
          paths: normalized.paths,
          baseline: normalized.baseline ?? null,
          diagnostics: null,
          reportComplete: false,
          reusable: false,
          note: '未执行任何程序；请先在工作区安装受支持的 Biome，或改用 profile=process。',
        };
        return {
          content: `${JSON.stringify(unsupported)}\n`,
          facts: {
            version: EXECUTION_EVIDENCE_VERSION,
            check: {
              profile: 'biome-lint',
              conclusion: 'inconclusive',
              diagnostics: null,
              reportComplete: false,
            },
          },
        };
      }
      // install.ok 时比较结果是完整的（unknown 只是结论，不是缺字段）。
      const comparison = result as BiomeBaselineComparison;
      return {
        content: describeBiomeComparison({
          paths: normalized.paths,
          comparison,
          install: result.install,
        }),
        facts: biomeFacts(comparison.current),
      };
    } finally {
      scratch.dispose();
    }
  }

  const cwdAbs = resolveAuthorizedPath(context, normalized.cwd);
  try {
    if (!fs.statSync(cwdAbs).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`check cwd 必须存在且是目录: ${normalized.cwd}`);
  }

  let program = normalized.program;
  if (normalized.programIsRelative) {
    // 工作区相对可执行文件：沿用同一套授权解析（禁止穿越/绝对/symlink 逃逸）。
    program = resolveAuthorizedPath(context, normalized.program);
    let isFile = false;
    try {
      isFile = fs.statSync(program).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new Error(`工作区内程序不存在或不是文件: ${normalized.program}`);
  }

  const outcome = await runCheckProcess(
    {
      program,
      args: normalized.args,
      cwd: cwdAbs,
      cwdDisplay: normalized.cwd,
      timeoutMs: normalized.timeoutMs,
    },
    context,
    deps,
  );

  const summary = {
    tool: CHECK_TOOL_NAME,
    version: 1,
    profile: normalized.profile,
    cwd: normalized.cwd,
    program: normalized.program,
    args: normalized.args,
    conclusion: outcome.conclusion,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    logsComplete: outcome.logsComplete,
    reportComplete: outcome.reportComplete,
    reasons: outcome.reasons,
    executor: outcome.executor,
    stdoutBytes: outcome.stdoutBytes,
    stderrBytes: outcome.stderrBytes,
    stdoutRef: outcome.stdoutRef ?? null,
    stderrRef: outcome.stderrRef ?? null,
    diagnosticsCount: outcome.diagnostics === null ? null : outcome.diagnostics.length,
    reusable: outcome.reusable,
    processRuns: outcome.processRuns,
    timeoutMs: normalized.timeoutMs,
  };

  return {
    content: describeCheckOutcome(outcome, summary),
    ...(outcome.facts ? { facts: outcome.facts } : {}),
  };
}
