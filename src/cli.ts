// 模块: CLI 入口 — 解析命令行参数，调用 Runtime 执行 Agent
// 用法:
//   npm start "任务"                 正常执行
//   npm start -- --resume <runId>    从 checkpoint 恢复执行

import { runAgent } from "./runtime/agent.js";
import { loadCheckpoint } from "./runtime/checkpoint.js";

const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;

if (resumeId) {
  const cp = loadCheckpoint(resumeId);
  if (!cp) {
    console.error(`[Error] checkpoint 不存在: .checkpoints/${resumeId}.json`);
    process.exit(1);
  }
  console.log(`任务: ${cp.task}（恢复执行）`);
  try {
    const answer = await runAgent(cp.task, cp);
    console.log(`\n最终答案: ${answer}`);
  } catch (err) {
    console.error(`\n[Error] ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  const task = args[0] || "帮我计算 15 * 37";
  console.log(`任务: ${task}`);
  try {
    const answer = await runAgent(task);
    console.log(`\n最终答案: ${answer}`);
  } catch (err) {
    console.error(`\n[Error] ${(err as Error).message}`);
    process.exit(1);
  }
}
