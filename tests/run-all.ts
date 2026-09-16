// 模块: 统一测试集合入口 — 聚合所有确定性套件（无 LLM），统一统计 PASS/FAIL
// 用法: tsx tests/run-all.ts                        （或 npm run test:all）
//      PAYASO_TEST_CONCURRENCY=8 tsx tests/run-all.ts   （覆盖默认并发）
// 覆盖: 90 个无 LLM 套件，含 Runtime/bootstrap 边界、静态依赖边界、工具调用状态机、三档文件系统权限、macOS seatbelt 沙箱、跨平台 Shell 执行器（Windows ACL argv/失败契约）、Workspace 生命周期与软删除回收站、
//   Host 启停/路由、SQLite 持久化、前端输出清理、默认浏览器打开边界、LLM transport mock、
//   Run 模型绑定与 Context Budget、True Cancellation、Shell 网络隔离、Malformed Tool Call 恢复、
//   原子终态落盘、Side-Effect 生命周期/回放、Provider 设置与凭证迁移、工具链能力刷新与显式重试、docs contract、
//   Host Auth、Provider URL 校验、Keychain 契约、幂等关闭（v1.6 Release Closure 基线）、
//   v1.8 内核不变量（空回合 / 工具参数契约 / 错误分类 / 输出预算 / shell 执行环境）、
//   v1.9 P1 能力（grep 正则+ignore / glob / 项目指令发现链 / shell 只读命令免回放）、
//   v1.10 P2 与能力（原生适配器原始参数恢复 / scratchpad 瘦身 / 后台长任务通道）、
//   v2.2 Plan（Harness 持有的任务清单：全量替换状态机 / 有界投影注入 / 工具→plan_update→注入闭环）
// 说明:
//   1. 每个套件在独立子进程运行（各自设置 SANDBOX_ROOT / mkdtemp，避免环境变量互相污染）
//   2. 以子进程退出码判定套件通过与否（各套件内部已实现 失败 → 非 0 退出）
//   3. 有界并发调度（默认 min(6, CPU)，PAYASO_TEST_CONCURRENCY 可覆盖）：套件本来就互相隔离，
//      串行只是把启动开销逐条叠加；直接走 `node --import tsx` 也省掉每套件一次 npx 解析
//   4. 单个套件的完整输出成组写入 .payaso/logs/run-all-<时间戳>.log，失败详情随汇总再打一遍 ——
//      复查失败读日志即可，不必为了换一个 tail/grep 切片重跑整轮
//   5. 压测 stress.test.ts 与 Agent E2E（agent.test.ts）需 LLM、耗时，不纳入本集合，
//      保持独立 script：npm run test:stress / npm test
// 注: 本文件用顶层执行 + 手动 process.exit，与各套件自定义 runner 风格保持一致（不走 node:test）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sliceTextToBudget } from '../src/tool-output-budget.js';

const PROJECT_ROOT = process.cwd();
/** 单个套件在内存里最多保留的原始输出：异常刷屏的套件不该把 runner 撑爆。 */
const SUITE_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
/** 单个套件在日志里保留的输出上限：超出按 head+tail 切片（复用运行时同一套预算算法）。 */
const SUITE_LOG_MAX_BYTES = 256 * 1024;
/** 失败详情回显到终端的单套件上限：太小丢上下文，太大会把汇总本身挤出可见范围。 */
const FAILURE_EXCERPT_MAX_BYTES = 8 * 1024;
const LOG_DIR = path.resolve(PROJECT_ROOT, '.payaso', 'logs');
/** 本地只保留最近 N 份日志：跑测试很频繁，不能让工作区堆成日志垃圾场。 */
const LOG_KEEP = 10;
const NAME_WIDTH = 26;

const SUITES: { name: string; file: string }[] = [
  { name: 'runtime-boundary', file: 'tests/runtime-boundary.test.ts' },
  { name: 'architecture-boundaries', file: 'tests/architecture-boundaries.test.ts' },
  { name: 'tool-invocation-state-machine', file: 'tests/tool-invocation-state-machine.test.ts' },
  { name: 'runtime-loop', file: 'tests/runtime-loop.test.ts' },
  { name: 'host-timeout', file: 'tests/host-timeout.test.ts' },
  { name: 'tool-contract', file: 'tests/tool-contract.test.ts' },
  { name: 'filesystem-tools', file: 'tests/filesystem-tools.test.ts' },
  { name: 'text-attachments', file: 'tests/text-attachments.test.ts' },
  { name: 'attachment-store', file: 'tests/attachment-store.test.ts' },
  { name: 'attachment-normalize', file: 'tests/attachment-normalize.test.ts' },
  { name: 'frontend-image-prepare', file: 'tests/frontend-image-prepare.test.ts' },
  { name: 'platform-shell-host', file: 'tests/platform-shell-host.test.ts' },
  { name: 'sandbox-manager', file: 'tests/sandbox-manager.test.ts' },
  { name: 'toolchain-manager', file: 'tests/toolchain-manager.test.ts' },
  { name: 'toolchain-preparation', file: 'tests/toolchain-preparation.test.ts' },
  { name: 'runtime-capabilities', file: 'tests/runtime-capabilities.test.ts' },
  { name: 'operation-identity', file: 'tests/operation-identity.test.ts' },
  { name: 'operation-replay', file: 'tests/operation-replay.test.ts' },
  { name: 'output-guard', file: 'tests/output-guard.test.ts' },
  { name: 'runtime-tools', file: 'tests/runtime-tools.test.ts' },
  { name: 'frontend-format', file: 'tests/frontend-format.test.ts' },
  { name: 'frontend-streaming', file: 'tests/frontend-streaming.test.ts' },
  { name: 'streaming-markdown', file: 'tests/streaming-markdown.test.ts' },
  { name: 'run-reconcile', file: 'tests/run-reconcile.test.ts' },
  { name: 'run-events-snapshot', file: 'tests/run-events-snapshot.test.ts' },
  { name: 'default-browser', file: 'tests/default-browser.test.ts' },
  { name: 'permissions', file: 'tests/permissions.test.ts' },
  { name: 'os-sandbox', file: 'tests/os-sandbox.test.ts' },
  { name: 'workspace', file: 'tests/workspace.test.ts' },
  { name: 'context', file: 'tests/context.test.ts' },
  { name: 'context-budget', file: 'tests/context-budget.test.ts' },
  { name: 'context-compaction', file: 'tests/context-compaction.test.ts' },
  { name: 'persistence', file: 'tests/persistence.test.ts' },
  { name: 'llm', file: 'tests/llm.test.ts' },
  { name: 'model-binding', file: 'tests/model-binding.test.ts' },
  { name: 'cancellation', file: 'tests/cancellation.test.ts' },
  { name: 'shell-network', file: 'tests/shell-network.test.ts' },
  { name: 'network-control', file: 'tests/network-control.test.ts' },
  { name: 'approval', file: 'tests/approval.test.ts' },
  { name: 'tool-args', file: 'tests/tool-args.test.ts' },
  { name: 'finalize', file: 'tests/finalize.test.ts' },
  { name: 'docs-contract', file: 'tests/docs-contract.test.ts' },
  { name: 'side-effect', file: 'tests/side-effect.test.ts' },
  { name: 'workspace-trash', file: 'tests/workspace-trash.test.ts' },
  { name: 'settings', file: 'tests/settings.test.ts' },
  { name: 'host-auth', file: 'tests/host-auth.test.ts' },
  { name: 'provider-url', file: 'tests/provider-url.test.ts' },
  { name: 'encrypted-file-secret', file: 'tests/encrypted-file-secret.test.ts' },
  { name: 'keychain-command', file: 'tests/keychain-command.test.ts' },
  { name: 'shutdown', file: 'tests/shutdown.test.ts' },
  { name: 'toolchain-refresh', file: 'tests/toolchain-refresh.test.ts' },
  { name: 'prompt-commands', file: 'tests/prompt-commands.test.ts' },
  { name: 'frontend-toolchain-retry', file: 'tests/frontend-toolchain-retry.test.ts' },
  { name: 'frontend-context-gauge', file: 'tests/frontend-context-gauge.test.ts' },
  { name: 'frontend-enter-key', file: 'tests/frontend-enter-key.test.ts' },
  { name: 'frontend-sse-contract', file: 'tests/frontend-sse-contract.test.ts' },
  { name: 'frontend-run-events', file: 'tests/frontend-run-events.test.ts' },
  { name: 'frontend-last-session', file: 'tests/frontend-last-session.test.ts' },
  { name: 'frontend-portal-root', file: 'tests/frontend-portal-root.test.ts' },
  { name: 'workspace-expansion', file: 'tests/workspace-expansion.test.ts' },
  { name: 'frontend-plan-state', file: 'tests/frontend-plan-state.test.ts' },
  { name: 'frontend-thinking-level', file: 'tests/frontend-thinking-level.test.ts' },
  { name: 'frontend-i18n-coverage', file: 'tests/frontend-i18n-coverage.test.ts' },
  { name: 'pi-ai-provider', file: 'tests/pi-ai-provider.test.ts' },
  // v1.8 内核不变量（空回合 / 参数契约 / 错误分类 / 输出预算 / shell 执行环境）
  { name: 'tool-output-budget', file: 'tests/tool-output-budget.test.ts' },
  { name: 'shell-execution', file: 'tests/shell-execution.test.ts' },
  // 跨平台 Shell 沙箱（docs/cross-platform-sandbox-plan.md）：统一执行器平台矩阵
  // + Windows ACL argv/失败契约（gate 默认关，真机验证清单见该文档）
  { name: 'shell-executor', file: 'tests/shell-executor.test.ts' },
  { name: 'windows-acl-sandbox', file: 'tests/windows-acl-sandbox.test.ts' },
  { name: 'tool-argument-validation', file: 'tests/tool-argument-validation.test.ts' },
  { name: 'tool-error-classifier', file: 'tests/tool-error-classifier.test.ts' },
  { name: 'empty-turn', file: 'tests/empty-turn.test.ts' },
  // v1.9 P1 能力
  { name: 'workspace-scan', file: 'tests/workspace-scan.test.ts' },
  { name: 'workspace-instructions', file: 'tests/workspace-instructions.test.ts' },
  { name: 'shell-command-effect', file: 'tests/shell-command-effect.test.ts' },
  // v1.10 P2 / 能力建设
  { name: 'tool-call-arguments', file: 'tests/tool-call-arguments.test.ts' },
  { name: 'scratchpad-view', file: 'tests/scratchpad-view.test.ts' },
  { name: 'background-jobs', file: 'tests/background-jobs.test.ts' },
  // v2.3 长任务与分层超时（docs/long-task-timeout-plan.md）：统一超时原语 / 工具级
  // TOOL_TIMEOUT / 后台作业 Session 所有权与完成通知（LLM 看门狗用例并入 llm.test.ts）
  { name: 'timeout-primitives', file: 'tests/timeout-primitives.test.ts' },
  { name: 'tool-timeout', file: 'tests/tool-timeout.test.ts' },
  { name: 'job-notification', file: 'tests/job-notification.test.ts' },
  // 前端纯函数（无 DOM）：底部会话统计条的读数口径（v2.3 从顶栏挪到 composer 下方）
  { name: 'frontend-stats-bar', file: 'tests/frontend-stats-bar.test.ts' },
  // v2.2 Plan（Harness 持有的任务清单：状态机 / 投影注入 / 工具→事件闭环）
  { name: 'plan-state', file: 'tests/plan-state.test.ts' },
  { name: 'plan-view', file: 'tests/plan-view.test.ts' },
  { name: 'plan-loop', file: 'tests/plan-loop.test.ts' },
  // 补充登记：工具命令 / 编辑 / 搜索 / 模型选择 / 统计 / 会话命令 / token 计量（确定性，无 LLM）
  { name: 'builtin-commands', file: 'tests/builtin-commands.test.ts' },
  { name: 'edit-tools', file: 'tests/edit-tools.test.ts' },
  { name: 'grep-tools', file: 'tests/grep-tools.test.ts' },
  { name: 'model-selection', file: 'tests/model-selection.test.ts' },
  { name: 'run-stats', file: 'tests/run-stats.test.ts' },
  { name: 'session-commands', file: 'tests/session-commands.test.ts' },
  { name: 'token-usage', file: 'tests/token-usage.test.ts' },
];

interface SuiteResult {
  index: number;
  name: string;
  file: string;
  pass: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/** 默认并发：套件本身是隔离子进程，串行只是浪费；并发上限随机器 CPU 收敛。 */
function resolveConcurrency(): number {
  const raw = Number(process.env.PAYASO_TEST_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return Math.min(6, Math.max(1, os.cpus().length));
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function runSuite(suite: { name: string; file: string }, index: number): Promise<SuiteResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-suite-'));
    const child = spawn(process.execPath, ['--import', 'tsx', suite.file], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PAYASO_HOME: suiteHome,
        PAYASO_CHECKPOINT_DIR: path.join(suiteHome, 'checkpoints'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let droppedBytes = 0;
    const collect = (chunk: Buffer): void => {
      capturedBytes += chunk.length;
      if (capturedBytes > SUITE_CAPTURE_MAX_BYTES) {
        droppedBytes += chunk.length;
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      chunks.push(Buffer.from(`[runner] 子进程启动失败: ${err.message}\n`));
    });
    child.on('close', (exitCode) => {
      fs.rmSync(suiteHome, { recursive: true, force: true });
      const raw = Buffer.concat(chunks).toString('utf8');
      const overflow =
        droppedBytes > 0
          ? `\n[runner] 输出过大：已保留前 ${SUITE_CAPTURE_MAX_BYTES / 1024 / 1024}MB，丢弃后续 ${droppedBytes} 字节\n`
          : '';
      resolve({
        index,
        name: suite.name,
        file: suite.file,
        pass: exitCode === 0,
        exitCode,
        durationMs: Date.now() - startedAt,
        output:
          overflow +
          sliceTextToBudget(raw, {
            maxBytes: SUITE_LOG_MAX_BYTES,
            headBytes: SUITE_LOG_MAX_BYTES / 2,
            tailBytes: SUITE_LOG_MAX_BYTES / 2 - 256,
          }).content,
      });
    });
  });
}

// ---- 日志落盘：best-effort，落盘不可用只降级提示，绝不影响测试结论 ----
let logPath: string | null = null;
let logWriteFailed = false;

function appendLog(text: string): void {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, text);
  } catch (err) {
    if (!logWriteFailed) {
      logWriteFailed = true;
      console.log(`[runner] 日志写入失败，后续不再落盘: ${(err as Error).message}`);
    }
  }
}

function initLog(concurrency: number): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    pruneLogs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    logPath = path.join(LOG_DIR, `run-all-${stamp}.log`);
    appendLog(
      [
        `# PayasoAgent 确定性测试集合日志`,
        `# 时间: ${new Date().toISOString()}  并发: ${concurrency}  套件: ${SUITES.length}`,
        `# 命令: node --import tsx tests/run-all.ts`,
        '',
      ].join('\n'),
    );
  } catch (err) {
    logPath = null;
    console.log(`[runner] 日志落盘不可用，仅输出到终端: ${(err as Error).message}`);
  }
}

/** 清理超出保留份数的历史日志（文件名是 ISO 时间戳，字典序即时间序）。 */
function pruneLogs(): void {
  try {
    const stale = fs
      .readdirSync(LOG_DIR)
      .filter((name) => name.startsWith('run-all-') && name.endsWith('.log'))
      .sort()
      .slice(0, -LOG_KEEP);
    for (const name of stale) fs.rmSync(path.join(LOG_DIR, name), { force: true });
  } catch {
    /* 清理是 best-effort：历史日志的任何问题都不该影响本轮落盘与结论 */
  }
}

// ---- 有界并发：固定 worker 抢同一个队列索引，避免 64 个 tsx 子进程同时起 ----
async function runSuites(concurrency: number): Promise<SuiteResult[]> {
  const results: SuiteResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, SUITES.length) }, async () => {
    while (next < SUITES.length) {
      const index = next++;
      const result = await runSuite(SUITES[index], index);
      results.push(result);
      const label = result.pass ? 'PASS' : 'FAIL';
      console.log(`  ${label}  ${result.name.padEnd(NAME_WIDTH)} ${seconds(result.durationMs)}`);
      appendLog(
        `\n=== ${label} ${result.name} (exit=${result.exitCode}, ${seconds(result.durationMs)}) ===\n` +
          `${result.output.trimEnd()}\n`,
      );
    }
  });
  await Promise.all(workers);
  return results;
}

const concurrency = resolveConcurrency();

console.log('='.repeat(70));
console.log('PayasoAgent 确定性测试集合（无 LLM）');
console.log(`套件: ${SUITES.length} | 并发: ${concurrency}`);
console.log('='.repeat(70));

initLog(concurrency);
const startedAt = Date.now();
const results = (await runSuites(concurrency)).sort((a, b) => a.index - b.index);
const totalMs = Date.now() - startedAt;
const failures = results.filter((r) => !r.pass);
const passed = results.length - failures.length;

console.log(`\n${'='.repeat(70)}`);
console.log('测试集合汇总');
console.log('='.repeat(70));
console.log(
  `套件: ${results.length} | PASS: ${passed} | FAIL: ${failures.length} | ` +
    `总耗时 ${seconds(totalMs)}（并发 ${concurrency}）`,
);
results.forEach((r) => {
  console.log(
    `  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(NAME_WIDTH)} ${seconds(r.durationMs)}`,
  );
});

// 失败详情放在汇总之后重打一遍：tail 截断或只看尾部时，失败原因仍在可见范围内。
if (failures.length > 0) {
  console.log(`\n${'-'.repeat(70)}`);
  console.log(`FAIL 详情（${failures.map((r) => r.name).join(', ')}）`);
  for (const failure of failures) {
    console.log(`\n▶ ${failure.name}  exit=${failure.exitCode}  ${seconds(failure.durationMs)}`);
    console.log(
      sliceTextToBudget(failure.output, {
        maxBytes: FAILURE_EXCERPT_MAX_BYTES,
        headBytes: FAILURE_EXCERPT_MAX_BYTES / 2,
        tailBytes: FAILURE_EXCERPT_MAX_BYTES / 2 - 256,
      }).content.trimEnd(),
    );
  }
}

console.log(
  `\n完整日志: ${logPath ? path.relative(PROJECT_ROOT, logPath) : '(未落盘)'}（含全部套件输出与失败详情）`,
);
// 末行固定为一行判定：无论上面的失败详情多长，tail 都能看到结论、失败套件与重跑命令。
console.log(
  failures.length === 0
    ? `结果: PASS — ${results.length} 套件全绿 | ${seconds(totalMs)}（并发 ${concurrency}）`
    : `结果: FAIL — ${results.length} 套件 | PASS ${passed} | FAIL ${failures.length} | ` +
        `${seconds(totalMs)} | 失败: ${failures.map((r) => r.name).join(', ')}`,
);
if (failures.length > 0) {
  console.log(`重跑失败套件: ${failures.map((r) => `node --import tsx ${r.file}`).join('；')}`);
}
console.log(
  '提示: 需 LLM 的压测与 E2E 未纳入本集合 — stress 用 npm run test:stress；Agent E2E 用 npm test',
);

appendLog(
  `\n${'='.repeat(70)}\n汇总: 套件 ${results.length} | PASS ${passed} | FAIL ${failures.length} | ` +
    `总耗时 ${seconds(totalMs)}（并发 ${concurrency}）\n`,
);
process.exit(passed === results.length ? 0 : 1);
