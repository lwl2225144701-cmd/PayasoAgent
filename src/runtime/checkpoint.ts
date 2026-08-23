// 模块: Checkpoint — 最小持久化（本地 JSON 文件），支持任务中断后 --resume 恢复
// 不引入数据库，不引入 Memory，只解决"中断后无法继续"的问题

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Scratchpad } from "./scratchpad.js";
import type { ChatMessage } from "../llm/llm.js";
import type { AgentState } from "./state.js";

// checkpoint 保存目录（项目根 .checkpoints/，已加入 .gitignore）
const CHECKPOINT_DIR = path.join(process.cwd(), ".checkpoints");

export interface Checkpoint {
  runId: string; // 运行 ID（与 State 的 runId 一致，作为恢复标识）
  task: string; // 用户任务
  status: string; // 保存时的状态（running / completed / failed）
  iteration: number; // 保存时的迭代次数
  scratchpad: Scratchpad; // 执行进度（completedSteps / failedSteps / nextStep）
  messages: ChatMessage[]; // 完整消息历史（恢复后继续发给 LLM）
  state: AgentState; // Agent State 快照（恢复 runId/task/统计字段）
  savedAt: string; // 保存时间
}

// checkpoint 文件路径：.checkpoints/{runId}.json
export function checkpointPath(runId: string): string {
  return path.join(CHECKPOINT_DIR, `${runId}.json`);
}

// 保存 checkpoint（目录不存在则创建）
export function saveCheckpoint(cp: Omit<Checkpoint, "savedAt">): string {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const full: Checkpoint = { ...cp, savedAt: new Date().toISOString() };
  const file = checkpointPath(cp.runId);
  writeFileSync(file, JSON.stringify(full, null, 2), "utf-8");
  return file;
}

// 读取 checkpoint；不存在或损坏返回 null
export function loadCheckpoint(runId: string): Checkpoint | null {
  const file = checkpointPath(runId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Checkpoint;
  } catch {
    return null;
  }
}

// 列出所有 checkpoint（返回 runId 列表，按修改时间倒序）
export function listCheckpoints(): string[] {
  if (!existsSync(CHECKPOINT_DIR)) return [];
  return readdirSync(CHECKPOINT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}
