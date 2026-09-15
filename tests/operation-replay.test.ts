import { checkpointPath } from '../src/persistence/file-checkpoint-store.js';
// 套件: Operation Replay（确定性）— 验证 executing/uncertain 持久化下，Recovery 后相同 canonical key 不再被再次执行
// 场景 1: tool_call#1 副作用后 throw → uncertain → Recovery → scripted LLM 再次请求相同 key → 必须被阻断（不 execute）
// 场景 2: checkpoint 保存 executing 失败 → 禁止 execute（execute 次数 = 0）
// 不修改 src/；不新增 in-flight / transaction / rollback；只验证当前真实行为。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../src/bootstrap/runtime-bootstrap.js';
import { register } from '../src/tools/tools.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-opreplay-'));
process.env.SANDBOX_ROOT = TEST_ROOT;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MODEL = 'test-model';

// ---- 真实副作用日志（crashTool 每次 execute 都会写入，是"副作用真实发生"的唯一证据）----
const sideEffectJournal: string[] = [];

// crashTool: non_idempotent；getOperationKey 固定返回同一 canonical key；
// execute 先产生副作用（写入 journal）再 throw，模拟"副作用已发生但 execute 未成功返回"
register({
  name: 'crashTool',
  description: '测试用：写入日志后立刻抛异常，模拟执行中途崩溃',
  effect: 'non_idempotent',
  parameters: {
    type: 'object',
    properties: { content: { type: 'string' } },
    required: ['content'],
  },
  getOperationKey: () => 'crash:boom', // 固定 canonical key（无视参数）
  execute: async (args) => {
    sideEffectJournal.push(`WROTE:${args.content}`);
    throw new Error('crash after effect（副作用已发生但 execute 未成功返回）');
  },
});

// ---- 本地 scripted LLM server（确定性：不依赖真实 LLM 是否愿意重复调用）----
// 序列（按调用顺序）：
//   llmCalls 1 → crashTool(content=boom)          （场景1 第一次）
//   llmCalls 2 → crashTool(content=boom)          （场景1 Recovery 后再次相同 key）
//   llmCalls 3 → final                            （场景1 结束）
//   llmCalls 4 → crashTool(content=boom)          （场景2 触发 persist 检查）
//   llmCalls 5+ → final
let llmCalls = 0;
const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += String(c)));
  req.on('end', () => {
    llmCalls++;
    const isCrashCall = llmCalls === 1 || llmCalls === 2 || llmCalls === 4;
    const message: Record<string, unknown> = isCrashCall
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('crashTool', { content: 'boom' }, `call-${llmCalls}`)],
        }
      : { role: 'assistant', content: '最终答案：任务结束（确定性脚本）' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});

// 捕获 agent 输出到 logs，供执行链还原
function captureRun(
  task: string,
  runId: string,
): Promise<{ answer: string; error: string; logs: string[] }> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(' '));
  };
  return runAgentRef(task, runId, logs, origLog);
}

// 动态导入后的 runAgent 引用
let runAgentRef: (
  task: string,
  runId: string,
  logs: string[],
  origLog: typeof console.log,
) => Promise<{ answer: string; error: string; logs: string[] }>;

let exitCode = 0;
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  // 固定真实端口后再动态 import runAgent，确保 llm.js 顶层读到的 BASE_URL 是最终值
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  const mod = await import('../src/runtime/agent.js');

  runAgentRef = async (task, runId, logs, origLog) => {
    let answer = '';
    let error = '';
    try {
      answer = await mod.runAgent(task, undefined, {
        executionContext: createAgentExecutionContext({ runId }),
        ...createDefaultRuntimeServices(),
      });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      console.log = origLog;
    }
    return { answer, error, logs };
  };

  // ================= 场景 1：Recovery 后相同 key 被 uncertain 阻断 =================
  console.log('='.repeat(70));
  console.log('场景 1 — Recovery 后相同 canonical key 不得再次 execute');
  console.log('='.repeat(70));

  const r1 = await captureRun('请调用 crashTool 处理 content=boom，并报告结果。', 'op-replay');

  const toolCalls1 = r1.logs.filter((l) => l.includes('[Tool 调用] crashTool')).length;
  const skips1 = r1.logs.filter((l) => l.includes('[Side-Effect Skip]')).length;
  const uncertainHits1 = r1.logs.filter((l) => l.includes('[Side-Effect Uncertain]')).length;
  const recoveries1 = r1.logs.filter((l) => l.includes('[恢复]')).length;
  const blocked1 = r1.logs.filter((l) => l.includes('[Blocked]')).length;
  const errs1 = r1.logs.filter((l) => l.includes('[Tool 错误] crashTool')).length;

  console.log(`scripted LLM 调用数       : ${llmCalls}（场景1 用 3 次）`);
  console.log(`[Tool 调用] crashTool     : ${toolCalls1}`);
  console.log(`[Side-Effect Skip]       : ${skips1}`);
  console.log(`[Side-Effect Uncertain]  : ${uncertainHits1}`);
  console.log(`[Tool 错误] crashTool     : ${errs1}`);
  console.log(`[恢复]                    : ${recoveries1}`);
  console.log(`[Blocked]                 : ${blocked1}`);
  console.log(`sideEffectExecutions（journal 长度）: ${sideEffectJournal.length}`);

  console.log('\n--- 每步 operation 状态（由日志序列还原）---');
  for (const l of r1.logs) {
    if (
      l.includes('[LLM 决策]') ||
      l.includes('[Tool 调用]') ||
      l.includes('[Side-Effect Skip]') ||
      l.includes('[Side-Effect Uncertain]') ||
      l.includes('[Tool 错误]') ||
      l.includes('[恢复]') ||
      l.includes('[Blocked]') ||
      l.includes('runAgent 异常')
    ) {
      console.log(`  ${l}`);
    }
  }

  try {
    assert.equal(
      sideEffectJournal.length,
      1,
      '期望副作用仅执行 1 次（第二次同 key 被 uncertain 阻断）',
    );
    assert.equal(
      uncertainHits1,
      1,
      '期望 1 次 [Side-Effect Uncertain]（第二次命中 executing/uncertain）',
    );
    assert.equal(toolCalls1, 1, '期望仅 1 次真实 execute');
    assert.equal(skips1, 0, '期望 0 次回放（uncertain 不伪造成功）');
    assert.equal(blocked1, 0, '期望 0 次 Blocked（阻断由 uncertain 完成）');
    console.log(
      '\n验收：第二次相同 canonical key 命中 uncertain/in-flight → 不进入 execute，sideEffectExecutions=1 ✓',
    );
  } catch (e) {
    console.log(`\n[FAIL] ${(e as Error).message}`);
    exitCode = 1;
  }

  // ================= 场景 2：checkpoint 保存 executing 失败 → 禁止 execute =================
  console.log(`\n${'='.repeat(70)}`);
  console.log('场景 2 — persist(executing) 失败 → 禁止 execute');
  console.log('='.repeat(70));

  const persistFailRunId = 'op-replay-persist-fail';
  // 预创建目录使 saveCheckpoint 写文件必然失败（EISDIR）
  fs.mkdirSync(checkpointPath(persistFailRunId), {
    recursive: true,
  });

  const journalBefore2 = sideEffectJournal.length;
  const r2 = await captureRun('请调用 crashTool 处理 content=boom，并报告结果。', persistFailRunId);

  const persistFailed = r2.logs.some((l) => l.includes('[Side-Effect Persist Failed]'));
  // [Tool 调用] 打印在 persist 之前（调用前标志），不能代表 execute；以"无 [Tool 错误] / 无副作用"判定未执行
  const execErr2 = r2.logs.filter((l) => l.includes('[Tool 错误] crashTool')).length;

  console.log(`[Side-Effect Persist Failed] 出现: ${persistFailed}`);
  console.log(`[Tool 错误] crashTool（场景2）: ${execErr2}`);
  console.log(`runAgent 报错               : ${r2.error.slice(0, 110)}`);
  console.log(`场景2 副作用执行次数         : ${sideEffectJournal.length - journalBefore2}`);

  try {
    assert.equal(persistFailed, true, '期望 persist(executing) 失败被识别');
    assert.equal(execErr2, 0, '期望场景2 未进入 execute（无 Tool 错误）');
    assert.equal(
      sideEffectJournal.length,
      journalBefore2,
      '期望场景2 无副作用发生（execute 次数=0）',
    );
    console.log('\n验收：persist(executing) 失败 → 禁止 execute，Tool execute 次数 = 0 ✓');
  } catch (e) {
    console.log(`\n[FAIL] ${(e as Error).message}`);
    exitCode = 1;
  }
} finally {
  server.close();
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

process.exit(exitCode);
