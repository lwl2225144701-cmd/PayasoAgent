// 模块: 重复调用观察策略（Harness 层纯函数）。
//
// 为什么单独存在：Agent 的「执行不收敛」最常见的机械形态是**同工具同参数反复调用**
// （同一路径反复读、同一条命令反复跑）。Runtime 已有 `isBlocked` 防死循环，但它只覆盖
// 「已失败/已无效」的调用；本策略覆盖**全部处置**——执行成功、失败、被策略拒绝、
// 被 side-effect 回放、结果不确定、参数校验失败都计数。没有它，模型可以用「换个写法」
// 绕过失败封锁，或在成功路径上无限轮询。
//
// 分层契约（不可越界）：
//   - 本模块**只提示、不阻断**。阈值 3/5/8 触发分级提醒，由 Harness 注入下一轮模型
//     视图；它不取消安全检查、不阻断合法轮询或验证（轮询/等待类任务本身是合法的）。
//   - 调用身份 = 工具名 + **深度排序后**的 JSON 参数（消除字段顺序差异），与
//     `side-effect.ts` 的 canonical operation key 是两套身份：后者按工具的
//     `resolveOperationKey` 归一化路径，前者按「模型看到的参数」原样比较。
//   - 提醒文本只携带**脱敏后有界**的参数预览：敏感键名（任意嵌套深度）一律掩码，
//     命令/正文等自由文本只保留长度与摘要，长字符串同样只留摘要——预览是模型
//     上下文、trace 事件与 checkpoint 共用的同一份结果，三处口径一致。
//
// 参考实现：DSH `packages/guard/repeat-tool-reminder`（拒绝调用同样计数、提醒附加
// 至上下文）；本实现按 Payaso 的分层改写为纯策略 + Harness 状态。

import { createHash } from 'node:crypto';

/** 一次工具调用的处置结果（统一观察口径，覆盖 process-manager 的全部出口）。 */
export type ToolInvocationDisposition =
  /** 真实执行并返回了（有效）结果。 */
  | 'executed'
  /** 策略/审批拒绝：工具未执行。 */
  | 'denied'
  /** 执行失败（含重试耗尽）。 */
  | 'failed'
  /** side-effect 回放：未执行，结果来自首次成功。 */
  | 'replayed'
  /** 结果不确定（executing/uncertain）：未执行。 */
  | 'uncertain'
  /** 参数/schema 校验失败：工具未执行。 */
  | 'invalid'
  /** 工具已执行且返回，但结果无效（与 invalid 区分：副作用可能已发生）。 */
  | 'invalid_result';

export interface ToolInvocationObservation {
  tool: string;
  /** 原始参数对象（内部做规范化与脱敏，不直接外泄）。 */
  args: unknown;
  disposition: ToolInvocationDisposition;
  /**
   * 本次 tool_call 的内部执行尝试次数（0 = 未进入执行；1 = 一次过；>1 = 自动重试）。
   * 与重复计数严格分开：count 数「模型发起了几次相同调用」，attempts 数
   * 「Runtime 内部执行了几次」——一次调用内部重试三次，重复计数仍为一次。
   */
  attempts?: number;
}

/** 分级阈值：达到即排队一次对应级别的提醒（一次性，不重复打扰）。 */
export interface RepeatCallPolicy {
  warnAt: number;
  escalateAt: number;
  /** 最强级别；仍然只提醒，不阻断。 */
  blockAt: number;
}

export const DEFAULT_REPEAT_CALL_POLICY: Readonly<RepeatCallPolicy> = {
  warnAt: 3,
  escalateAt: 5,
  blockAt: 8,
};

export type RepeatCallLevel = 0 | 1 | 2 | 3;

export interface RepeatCallState {
  /** 规范化调用键的摘要（sha256 前 16 位；不存参数原文，避免泄露与 checkpoint 膨胀）。 */
  key: string;
  /** 连续相同调用的次数（含本次）。 */
  count: number;
  /** 已投递到的提醒级别。 */
  level: RepeatCallLevel;
  lastDisposition: ToolInvocationDisposition;
  /** 最近一次调用的内部执行尝试次数（与 count 分工见 ToolInvocationObservation.attempts）。 */
  lastAttempts: number;
  /** 脱敏后的有界参数预览（仅用于提醒文本与事件审计）。 */
  preview: string;
}

export interface RepeatCallReminder {
  tool: string;
  count: number;
  level: RepeatCallLevel;
  /** 触发提醒的这一次调用内部执行了几次（0 = 未执行，如被拒绝/回放）。 */
  attempts: number;
  /** 脱敏后的有界参数预览。 */
  preview: string;
}

const PREVIEW_MAX_CHARS = 200;
/** 单值原文上限：超过即只保留摘要（路径/短参数仍是排查重复所需的关键信息）。 */
const VERBATIM_VALUE_MAX_CHARS = 64;
/** 嵌套深度与条目数上限：预览只用于识别「哪一次重复」，不需要完整结构。 */
const PREVIEW_MAX_DEPTH = 4;
const PREVIEW_MAX_ENTRIES = 12;
const SECRET_KEY_PATTERN = /pass|secret|token|key|auth|credential|cookie|signature/i;
/**
 * 自由文本字段：命令、正文、查询、代码等。这类值的第一要务是**不原文外泄**
 * （可能内嵌凭证、密钥、用户数据），第二才是可识别——因此一律只保留长度与摘要。
 */
const FREE_TEXT_KEYS = new Set([
  'command',
  'cmd',
  'script',
  'content',
  'text',
  'body',
  'query',
  'pattern',
  'prompt',
  'code',
  'sql',
  'regex',
  'replacement',
  'patch',
  'diff',
  'stdin',
  'message',
]);

/** 深度排序后的稳定 JSON（字段顺序差异不构成不同身份）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 调用键摘要：sha256 前 16 位。 */
export function repeatCallKey(tool: string, args: unknown): string {
  const canonical = `${tool}::${stableStringify(args)}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** 自由文本/超长字符串的统一表示：长度 + 摘要。可识别、不可还原、长度有界。 */
function textSummary(value: string): string {
  return `<text ${value.length}chars sha256:${digest(value)}>`;
}

/** 值级脱敏：敏感键名（任意深度）掩码；自由文本与超长字符串只留摘要；其余原样。 */
function maskValue(key: string, value: unknown, depth: number): string {
  if (SECRET_KEY_PATTERN.test(key)) return '***';
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') {
    if (FREE_TEXT_KEYS.has(key) || value.length > VERBATIM_VALUE_MAX_CHARS) {
      return textSummary(value);
    }
    return value;
  }
  if (typeof value !== 'object') return String(value);
  return renderNested(value, depth + 1);
}

/** 对象条目渲染：key=maskedValue，条目数有界。 */
function renderEntries(value: Record<string, unknown>, depth: number): string {
  const entries = Object.entries(value);
  const shown = entries.slice(0, PREVIEW_MAX_ENTRIES);
  const omitted = entries.length - shown.length;
  const body = shown.map(([k, v]) => `${k}=${maskValue(k, v, depth)}`).join(', ');
  const suffix = omitted > 0 ? `, …+${omitted}` : '';
  return `${body}${suffix}`;
}

/** 嵌套对象/数组的递归渲染（深度与条目数双重有界，超限截断为 …）。 */
function renderNested(value: object, depth: number): string {
  if (depth > PREVIEW_MAX_DEPTH) return '…';
  if (!Array.isArray(value)) return `{${renderEntries(value as Record<string, unknown>, depth)}}`;
  const entries = (value as unknown[]).map((item, index): [string, unknown] => [
    String(index),
    item,
  ]);
  const shown = entries.slice(0, PREVIEW_MAX_ENTRIES);
  const omitted = entries.length - shown.length;
  const body = shown.map(([k, v]) => maskValue(k, v, depth)).join(', ');
  const suffix = omitted > 0 ? `, …+${omitted}` : '';
  return `[${body}${suffix}]`;
}

/**
 * 脱敏后有界的参数预览：键名 + 掩码/摘要后的值。
 * 这是模型上下文、trace 事件与 checkpoint 共用的**同一份**结果（在
 * advanceRepeatCall 里计算一次，分别存入 state.preview 与 reminder.preview）。
 */
export function sanitizeArgsPreview(tool: string, args: unknown): string {
  // 顶层参数对象不加花括号（read(path=src/a.ts) 比 read({path=src/a.ts}) 可读）；
  // 嵌套层级保留括号，避免多层结构糊成一片。
  const body =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? renderEntries(args as Record<string, unknown>, 0)
      : args !== null && typeof args === 'object'
        ? renderNested(args, 0)
        : maskValue('', args, 0);
  const text = `${tool}(${body})`;
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…` : text;
}

export function normalizeRepeatCallState(value: unknown): RepeatCallState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<RepeatCallState>;
  if (typeof candidate.key !== 'string' || !candidate.key) return undefined;
  const count =
    Number.isSafeInteger(candidate.count) && (candidate.count as number) >= 1
      ? (candidate.count as number)
      : 1;
  const level: RepeatCallLevel =
    candidate.level === 1 || candidate.level === 2 || candidate.level === 3 ? candidate.level : 0;
  const dispositions: ToolInvocationDisposition[] = [
    'executed',
    'denied',
    'failed',
    'replayed',
    'uncertain',
    'invalid',
    'invalid_result',
  ];
  const lastDisposition = dispositions.includes(
    candidate.lastDisposition as ToolInvocationDisposition,
  )
    ? (candidate.lastDisposition as ToolInvocationDisposition)
    : 'executed';
  const lastAttempts =
    Number.isSafeInteger(candidate.lastAttempts) && (candidate.lastAttempts as number) >= 0
      ? (candidate.lastAttempts as number)
      : 0;
  const preview = typeof candidate.preview === 'string' ? candidate.preview.slice(0, 512) : '';
  return { key: candidate.key, count, level, lastDisposition, lastAttempts, preview };
}

/**
 * 归一化待投递的提醒（checkpoint 旧记录/手改数据全量防御）。
 * 与 normalizeRepeatCallState 的区别：这里的 count/level 是「已跨过阈值的事实」，
 * 必须原样保留（0 级提醒没有意义，直接判为无效返回 undefined）。
 */
export function normalizeRepeatCallReminder(value: unknown): RepeatCallReminder | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<RepeatCallReminder>;
  const tool = typeof candidate.tool === 'string' ? candidate.tool : '';
  const count =
    typeof candidate.count === 'number' &&
    Number.isSafeInteger(candidate.count) &&
    candidate.count >= 1
      ? candidate.count
      : 0;
  const level =
    candidate.level === 1 || candidate.level === 2 || candidate.level === 3 ? candidate.level : 0;
  if (!tool || !count || !level) return undefined;
  const attempts =
    typeof candidate.attempts === 'number' &&
    Number.isSafeInteger(candidate.attempts) &&
    candidate.attempts >= 0
      ? candidate.attempts
      : 0;
  return {
    tool,
    count,
    level,
    attempts,
    preview: typeof candidate.preview === 'string' ? candidate.preview.slice(0, 512) : '',
  };
}

function levelFor(count: number, policy: RepeatCallPolicy): RepeatCallLevel {
  if (count >= policy.blockAt) return 3;
  if (count >= policy.escalateAt) return 2;
  if (count >= policy.warnAt) return 1;
  return 0;
}

/** 观察一次调用：返回需要注入的提醒（跨过新阈值时），否则 undefined。 */
export function advanceRepeatCall(
  state: RepeatCallState | undefined,
  observation: ToolInvocationObservation,
  policy: RepeatCallPolicy,
): { state: RepeatCallState; reminder: RepeatCallReminder | undefined } {
  const key = repeatCallKey(observation.tool, observation.args);
  const preview = sanitizeArgsPreview(observation.tool, observation.args);
  const attempts =
    Number.isSafeInteger(observation.attempts) && (observation.attempts as number) >= 0
      ? (observation.attempts as number)
      : 0;
  // 不同调用（或首次）→ 重置连续性。
  if (!state || state.key !== key) {
    const next: RepeatCallState = {
      key,
      count: 1,
      level: 0,
      lastDisposition: observation.disposition,
      lastAttempts: attempts,
      preview,
    };
    return { state: next, reminder: undefined };
  }
  const count = Math.min(Number.MAX_SAFE_INTEGER, state.count + 1);
  const level = levelFor(count, policy);
  const next: RepeatCallState = {
    key,
    count,
    // 级别只升不降：同一身份连续调用时，已投递过的级别不重复投递。
    level: level > state.level ? level : state.level,
    lastDisposition: observation.disposition,
    lastAttempts: attempts,
    preview,
  };
  if (level > state.level) {
    return {
      state: next,
      reminder: {
        tool: observation.tool,
        count,
        level: next.level,
        attempts,
        preview,
      },
    };
  }
  return { state: next, reminder: undefined };
}

/** 注入模型的提醒文本（有界；只描述事实与下一步，不代模型下结论）。 */
export function renderRepeatCallReminder(reminder: RepeatCallReminder): string {
  const guidance =
    reminder.level >= 3
      ? 'This exact call has now been issued many times in a row. Stop repeating it: either verify the real outcome (state, remote, file) or report the blocker to the user.'
      : reminder.level >= 2
        ? 'Repeating the same call rarely produces new information. State what is still unresolved and change the approach or the arguments.'
        : 'The same call has been issued repeatedly. If the result is already known, use it instead of calling again.';
  return (
    `\n\n[Repeated call review]\n` +
    `Tool ${reminder.tool} has been called ${reminder.count} times in a row with identical arguments ` +
    `(${reminder.preview}).\n${guidance}\n` +
    'Legitimate polling is allowed: if the task is to wait for an external condition, keep polling but say so and report progress.'
  );
}

/** 环境变量开关：`PAYASO_REPEAT_CALL_REMINDER=off` 关闭（与 progress reminder 一致）。 */
export function resolveRepeatCallPolicy(
  env: Record<string, string | undefined> = process.env,
): RepeatCallPolicy | false {
  if (env.PAYASO_REPEAT_CALL_REMINDER === 'off') return false;
  const positiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
  };
  const policy: RepeatCallPolicy = {
    warnAt: positiveInt(env.PAYASO_REPEAT_WARN_AT, DEFAULT_REPEAT_CALL_POLICY.warnAt),
    escalateAt: positiveInt(env.PAYASO_REPEAT_ESCALATE_AT, DEFAULT_REPEAT_CALL_POLICY.escalateAt),
    blockAt: positiveInt(env.PAYASO_REPEAT_BLOCK_AT, DEFAULT_REPEAT_CALL_POLICY.blockAt),
  };
  if (!(policy.warnAt <= policy.escalateAt && policy.escalateAt <= policy.blockAt)) {
    throw new Error('Invalid repeat call policy: warnAt <= escalateAt <= blockAt required');
  }
  return policy;
}
