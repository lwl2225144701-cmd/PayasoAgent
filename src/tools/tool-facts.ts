// 模块: Tool facts 构造器（计划 §8.1）
//
// 为什么单独一层：facts 必须由**工具实现**产生（它才知道实际返回了哪几行、
// 真实写入了什么），Runtime 只做校验与有界存储，Harness 只读投影。这里提供
// 纯构造辅助，不做判定：写入指纹、读取范围与完整性都由调用方给出。
//
// 诚实边界（首版）：
// - 读取版本 ≤1MiB 用内容哈希（content），更大的退化为 size+mtime（stat）；
//   弱版本只用于进度启发，不用于验证复用。
// - grep 只记录"规范化查询 + 结果摘要"，且 complete=false（默认忽略依赖目录、
//   受输出预算/扫描上限约束，不能据此宣称整个范围已查清）。
// - ls 非递归，同样 complete=false。
// - 无变化（写入前后 hash 相同）不产生 MutationFact（"无修改"不算进展）。

import { createHash } from 'node:crypto';
import {
  EXECUTION_EVIDENCE_VERSION,
  type MutationFact,
  type ReadFact,
  type ReadRange,
  type ToolFacts,
} from '../execution-evidence.js';

/** 32 位十六进制摘要：足以区分版本/内容，且不会把长哈希塞进证据存储。 */
export function factDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export interface ReadFactInput {
  kind: 'file' | 'grep' | 'ls';
  /** 工作区相对逻辑路径（绝不传宿主绝对路径）。 */
  path: string;
  versionKind: 'content' | 'stat';
  version: string;
  /** grep/ls 的规范化查询摘要。 */
  queryHash?: string;
  /** 实际返回的连续行范围（不是请求范围）。 */
  returnedRanges?: ReadRange[];
  /** 实际返回给模型的内容（本工具负责截断后的真实文本）。 */
  returnedText: string;
  complete: boolean;
}

export function readFacts(input: ReadFactInput): ToolFacts {
  const fact: ReadFact = {
    kind: input.kind,
    path: input.path,
    versionKind: input.versionKind,
    version: input.version,
    ...(input.queryHash ? { queryHash: input.queryHash } : {}),
    returnedRanges: input.returnedRanges ?? [],
    returnedHash: factDigest(input.returnedText),
    complete: input.complete,
  };
  return { version: EXECUTION_EVIDENCE_VERSION, reads: [fact] };
}

export interface MutationFactInput {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
}

/** 只在 hash 真的变化时调用；返回 null = 没有真实修改（不产生事实）。 */
export function mutationFacts(input: MutationFactInput): ToolFacts | null {
  if (input.afterHash !== null && input.afterHash === input.beforeHash) return null;
  const fact: MutationFact = {
    path: input.path,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
  };
  return { version: EXECUTION_EVIDENCE_VERSION, mutations: [fact] };
}
