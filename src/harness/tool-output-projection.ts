// 工具输出投影（P2-C · docs/plans/context-management-plan.md）：
// 把「已经变老」的工具结果做**确定性降级**，只保留首尾一小段。
//
// 为什么需要：实测一次 run 的上下文里 tool 消息占 60.7%（433 条），是 30 万
// token 的主体——不是几个巨无霸，而是几百条碎块累积（中位数仅 ~1KB）。这些
// 结果模型早就消费完了，结论落在 assistant 消息与摘要里，原文留在 canonical
// transcript 中可追溯。
//
// 为什么用「投影」而不是「摘要」：这是成本阶梯上免费的那一级。它零 LLM 调用、
// 纯确定性、可重放；压缩触发线用的是投影**之后**的估算，所以投影省下的量够多
// 时，后面那一步昂贵的摘要根本不会发生。
//
// 契约：
// - 只动 `tool` 消息的 `content`；`role` / `tool_call_id` 原样保留，不破坏
//   工具调用配对结构（配对拆散会让模型看到一个悬空的调用）。
// - **只会变小**：原文不超过投影后长度时原样返回，绝不因为加标记而变大。
// - 只动模型视图：canonical transcript / checkpoint 一个字节都不改。
// - 未变更的消息保持**同一个对象引用**（前缀缓存与内存都受益）。

import type { ChatMessage } from '../llm/llm.js';
import { TOOL_OUTPUT_MARKER, utf8ByteLength, utf8Head, utf8Tail } from '../tool-output-budget.js';

export interface ProjectionPolicy {
  enabled: boolean;
  /** 最近这么多轮（以 user 消息为轮边界）内的工具结果保持全文。 */
  keepRecentTurns: number;
  /** 无论如何都保持全文的最近工具结果条数（防止连续 user 提醒把轮边界推近末尾）。 */
  keepRecentToolResults: number;
  /** 投影后保留的头部字节。 */
  headBytes: number;
  /** 投影后保留的尾部字节。 */
  tailBytes: number;
}

export const DEFAULT_PROJECTION_POLICY: ProjectionPolicy = {
  enabled: true,
  keepRecentTurns: 2,
  keepRecentToolResults: 20,
  // 投影后约 160 + 标记 + 224 ≈ 400 字节/条：够模型认出"这里曾经有过什么结果"，
  // 又不至于几百条累积成几十万 token。
  headBytes: 160,
  // 尾部特意留够：P1 的 spill 提示是**拼在结果末尾**的（"[中间被省略的内容已
  // 完整落盘，可用 read 读回：<路径>]"，约 110 字节）。尾部太短会把路径截成
  // 半截——那比没有更糟（模型会去读一个不存在的路径）。留 224 保证整条提示
  // 连同路径完整活下来，于是"投影后有损、但被 spill 过的仍可完整恢复"。
  tailBytes: 224,
};

export interface ProjectionResult {
  messages: ChatMessage[];
  projectedCount: number;
  savedBytes: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** 从环境变量解析投影策略（PAYASO_PROJECT_OLD_TOOL_OUTPUTS=0 可整体关闭）。 */
export function resolveProjectionPolicy(
  env: Record<string, string | undefined> = process.env,
): ProjectionPolicy {
  const enabledRaw = env.PAYASO_PROJECT_OLD_TOOL_OUTPUTS?.trim();
  return {
    enabled: enabledRaw === undefined || enabledRaw === '' ? true : enabledRaw !== '0',
    keepRecentTurns: positiveInt(
      env.PAYASO_PROJECT_KEEP_TURNS,
      DEFAULT_PROJECTION_POLICY.keepRecentTurns,
    ),
    keepRecentToolResults: positiveInt(
      env.PAYASO_PROJECT_KEEP_TOOL_RESULTS,
      DEFAULT_PROJECTION_POLICY.keepRecentToolResults,
    ),
    headBytes: positiveInt(env.PAYASO_PROJECT_HEAD_BYTES, DEFAULT_PROJECTION_POLICY.headBytes),
    tailBytes: positiveInt(env.PAYASO_PROJECT_TAIL_BYTES, DEFAULT_PROJECTION_POLICY.tailBytes),
  };
}

/**
 * 找出"投影边界"：索引 < boundary 的消息属于老旧历史；0 表示不投影。
 *
 * 两个约束各自给出"最早仍需保留全文的下标"，取更早的那个（= 保留更多）：
 *   - 约束一：最近 keepRecentTurns 轮的起点（以 user 消息为轮边界）；
 *   - 约束二：最近 keepRecentToolResults 条工具结果中最早那条。
 * 某侧不构成约束（数量不足）时由另一侧决定；两侧都不构成 → 不投影。
 * 约束二是必要的兜底：连续的 user 提醒（空回合/进度提醒）会把轮边界推到很靠近
 * 末尾，只靠约束一会把仍然新鲜的工具结果也投影掉。
 */
function projectionBoundary(messages: ChatMessage[], policy: ProjectionPolicy): number {
  // 约束一：往回数到第 keepRecentTurns 条 user 消息，它就是最早需保留那轮的起点。
  let turnBoundary = 0;
  let turns = 0;
  if (policy.keepRecentTurns > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue;
      turns++;
      if (turns === policy.keepRecentTurns) {
        turnBoundary = i;
        break;
      }
    }
  }
  // 约束二：往回数到第 keepRecentToolResults 条工具结果，它本身仍要保留。
  let toolBoundary = 0;
  let tools = 0;
  if (policy.keepRecentToolResults > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'tool') continue;
      tools++;
      if (tools === policy.keepRecentToolResults) {
        toolBoundary = i;
        break;
      }
    }
  }
  if (turnBoundary === 0) return toolBoundary;
  if (toolBoundary === 0) return turnBoundary;
  return Math.min(turnBoundary, toolBoundary);
}

/**
 * 对模型视图做旧工具结果投影。纯函数：不改入参，未变更的消息保持同一引用。
 */
export function projectStaleToolOutputs(
  messages: ChatMessage[],
  policy: ProjectionPolicy = DEFAULT_PROJECTION_POLICY,
): ProjectionResult {
  if (!policy.enabled) return { messages, projectedCount: 0, savedBytes: 0 };
  const boundary = projectionBoundary(messages, policy);
  if (boundary <= 0) return { messages, projectedCount: 0, savedBytes: 0 };

  const projectedLength = policy.headBytes + utf8ByteLength(TOOL_OUTPUT_MARKER) + policy.tailBytes;
  let projectedCount = 0;
  let savedBytes = 0;
  const out = messages.slice();

  for (let i = 0; i < boundary; i++) {
    const message = messages[i];
    if (message.role !== 'tool') continue;
    const content = message.content;
    if (!content) continue;
    const originalBytes = utf8ByteLength(content);
    // 只会变小：原文不比投影后长就原样保留（绝不因为加标记而变大）。
    if (originalBytes <= projectedLength) continue;
    const degraded = `${utf8Head(content, policy.headBytes)}${TOOL_OUTPUT_MARKER}${utf8Tail(content, policy.tailBytes)}`;
    out[i] = { ...message, content: degraded };
    projectedCount++;
    savedBytes += originalBytes - utf8ByteLength(degraded);
  }

  if (projectedCount === 0) return { messages, projectedCount: 0, savedBytes: 0 };
  return { messages: out, projectedCount, savedBytes };
}
