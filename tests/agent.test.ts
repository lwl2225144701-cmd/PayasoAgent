// 模块: 能力测试集 — 端到端跑 21 个真实 Agent 任务，校验输出并汇总 PASS/FAIL
// 用法: npx tsx --env-file=.env tests/agent.test.ts
// 说明: 每个任务以独立子进程运行（真实调用 LLM + 工具），避免状态互相干扰

import { execFileSync, spawn } from 'node:child_process';
import fs, { rmSync } from 'node:fs';
import path from 'node:path';
import { loadCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { cleanupWorkspace, createWorkspace } from '../src/sandbox/sandbox-manager.js';

interface TestCase {
  name: string; // 测试名
  prompt: string; // 用户任务
  expect: string[]; // 最终答案需包含的关键词（任一命中即 PASS）
  expectAny?: string[]; // 输出需至少包含一个关键词（用于失败/能力缺失等语义）
  expectTools?: string[]; // 期望按顺序出现的工具调用（校验 [Tool 调用] 行）
  expectNoTools?: string[]; // 期望完全不出现在 [Tool 调用] 行中的工具
  expectToolCount?: Record<string, number>; // 期望各工具精确调用次数（校验 [Tool 调用] 行计数）
  expectInvalid?: { tool: string; count: number }; // 期望出现 N 次 tool_result_invalid（指定工具）
  expectState?: Record<string, string | number>; // 期望最终 State JSON 含 key:value
  expectCompletedNotContain?: string[]; // 最终 Scratchpad 的 completedSteps 不得包含这些子串（invalid 结果不应进入）
  env?: Record<string, string>; // 额外环境变量（如 INVALID_WEATHER）
  resume?: boolean; // 中断恢复任务：先中断运行，再从 checkpoint 恢复
  noTool?: boolean; // 纯对话任务：期望不调用工具
  cliArgs?: string[]; // 额外 CLI 参数（如 --run-id <id>，置于任务串之前）
  setup?: () => void; // 运行前准备（如预置沙箱工作区文件）
  teardown?: () => void; // 运行后清理
}

const TASKS: TestCase[] = [
  {
    name: '1. 基础计算（单步）',
    prompt: '帮我计算 15*37',
    expect: ['555'],
    expectTools: ['calculator'],
  },
  {
    name: '2. 多步骤计算（串行依赖）',
    prompt: '先算 15*37，再把结果加 100',
    expect: ['655'],
  },
  {
    name: '3. 多步骤计算（4步长链）',
    prompt:
      '请严格分步计算，禁止合并表达式，每一步只调用一次 calculator：先算 2*3，再用上一步结果乘 4，再用结果乘 5，再用结果乘 6。每步单独调用工具。',
    expect: ['720'],
  },
  {
    name: '4. 多工具调用（并行）',
    prompt: '帮我分别计算 15*37 和 24*8，然后告诉我哪个结果更大',
    expect: ['555', '192', '更大'],
  },
  {
    name: '5. 工具失败恢复',
    prompt:
      "严格分步执行：①先用 calculator 算 15*37；②把结果加 100 再算一次；③现在请用 calculator 计算，但 expression 参数必须传 'x+1' 这个非法字符串；④如果第③步失败，请改用合法表达式重新计算 655+100；⑤告诉我每一步结果和最终答案",
    expect: ['755'],
  },
  {
    name: '6. 工具返回异常（Infinity → invalid）',
    prompt: '请用 calculator 计算 1/0，然后告诉我结果是什么含义',
    expect: ['Infinity', '无穷'],
    expectInvalid: { tool: 'calculator', count: 1 },
    expectState: { invalidToolResults: 1 },
  },
  {
    name: '7. 重复失败工具调用防失控（同参数 Blocked）',
    prompt:
      "请用 calculator 计算 2*3，然后无论失败与否，都用 calculator 参数 'x+1' 再调用 5 次，最后告诉我结果",
    expect: ['Blocked', '禁止再次调用'],
  },
  {
    name: '8. 长链计算（不依赖固定迭代上限）',
    prompt:
      '请严格分步计算，禁止合并表达式，每一步只调用一次 calculator：先算 2*3，再用上一步结果乘 4，再用结果乘 5，再用结果乘 6，再用结果乘 7，再用结果乘 8。每步单独调用工具。',
    expect: ['40320'],
  },
  {
    name: '9. 中断恢复（checkpoint --resume）',
    prompt: '帮我计算 15*37，再把结果加 100',
    expect: ['655'],
    resume: true,
  },
  {
    name: '10. 纯对话（不调用工具）',
    prompt: '你好，介绍一下你自己',
    expect: [],
    noTool: true,
  },
  {
    name: '11. getWeather（只调用天气工具）',
    prompt: '深圳天气怎么样',
    expect: ['28°C', '天气: 深圳'],
    expectTools: ['getWeather'],
  },
  {
    name: '12. 工具选择（计算只走 calculator）',
    prompt: '帮我计算 15*37',
    expect: ['555'],
    expectTools: ['calculator'],
  },
  {
    name: '13. 工具串联（天气 → 计算）',
    prompt: '查询深圳温度，再把温度加10',
    expect: ['38'],
    expectTools: ['getWeather', 'calculator'],
  },
  {
    name: '14. 上游 Tool 失败，下游依赖中止',
    prompt:
      '查询“不存在的城市”的天气，再把温度加10。如果天气查询失败，不要调用 calculator，不要编造温度，直接说明无法完成后续计算。',
    expect: ['天气查询失败', '无法', '失败'],
    expectTools: ['getWeather'],
    expectNoTools: ['calculator'],
  },
  {
    name: '15. Tool Result Invalid（getWeather temperature=null）',
    prompt: '查询深圳当前温度，再把温度加 10，告诉我最终结果。',
    // v1.2 验证：getWeather 执行成功但 temperature=null → 结果无效
    // 不增加额外提示词，观察 Runtime 自然处理（INVALID_WEATHER=1 让数据源返回 null）
    // 注：不断言 getWeather 精确次数（LLM 可能换城市名探索，如 深圳→Shenzhen，各次参数不同，
    //     防重调机制按设计只拦相同参数）；核心不变式 = 下游 calculator 0 次 + invalid=1 + completedSteps 空
    expect: [],
    env: { INVALID_WEATHER: '1' },
    expectNoTools: ['calculator'],
    expectInvalid: { tool: 'getWeather', count: 1 },
    expectState: { invalidToolResults: 1 },
    expectCompletedNotContain: ['temperature'],
  },
  {
    name: '16. calculator NaN Result Invalid（0/0 → NaN）',
    prompt: '先用 calculator 计算 0/0，再把结果加 10。',
    // v1.2 验证：0/0 → NaN → execute 成功 → 结果无效（NaN 不写入 completedSteps，不把 NaN 当有效数值执行）
    // 注：不断言 calculator 精确次数/ completedSteps 整体为空——LLM 可能自创替代表达式（如 (8-8)/4=0 为有效结果），
    //     核心不变式 = NaN 产生且仅产生 1 次 invalid、invalidToolResults=1、completedSteps 不含 NaN
    expect: ['NaN', '无效', '未定义'],
    expectInvalid: { tool: 'calculator', count: 1 },
    expectState: { invalidToolResults: 1 },
    expectCompletedNotContain: ['NaN'],
  },
  // ---- Loop 边界：正常结束 ≠ 任务成功完成 ----
  // 这些用例验证无效结果、工具失败和能力缺失时的停止语义，避免把
  // status=completed 误认为任务已完成。
  {
    name: '17. 无效结果不重复调用同一请求',
    prompt:
      '只查询一次深圳当前温度，然后把温度加 10。如果返回的温度为空或无效，停止并明确说明，禁止重新查询深圳或调用 calculator。',
    expect: [],
    env: { INVALID_WEATHER: '1' },
    expectNoTools: ['calculator'],
    expectToolCount: { getWeather: 1 },
    expectInvalid: { tool: 'getWeather', count: 1 },
    expectState: { invalidToolResults: 1 },
    expectCompletedNotContain: ['temperature'],
  },
  {
    name: '18. 正常结束但任务未完成：tool failure',
    prompt:
      '必须使用 calculator 计算 x+1，并把计算结果乘以 2，告诉我最终数值。如果工具无法完成，不允许改成其他表达式。',
    // 注意：LLM 可能先验拒绝（不真正调用 calculator）或调用后触发 tool_error→Recovery→Blocked，
    // 两条路径都属"正常结束但任务未完成"，故不断言工具调用
    expect: [],
    expectAny: ['无法', '失败', '不能', '错误'],
  },
  {
    name: '19. 正常结束但任务未完成：missing capability',
    prompt:
      '请查询北京今天的实时股票价格，并告诉我价格。必须通过可用工具获取真实数据，不允许猜测。',
    expect: [],
    expectAny: ['无法', '没有', '不支持', '不能', '不可用'],
    expectNoTools: ['calculator', 'getWeather', 'ls', 'read', 'grep', 'write', 'edit', 'shell'],
  },
  // ---- 无 Workspace 时的旧 Sandbox 兼容行为 ----
  // 预置 sandbox/workspaces/e2e-demo 工作区（--run-id 固定）。真实 Workspace 的
  // Host→Run→Runtime 链路由 tests/workspace.test.ts 与 Host 集成测试覆盖。
  {
    name: '20. 旧 Sandbox 兼容：ls（查看 work 目录）',
    prompt: '请查看 work 目录中有哪些文件',
    expect: ['a.txt'],
    expectTools: ['ls'],
    cliArgs: ['--run-id', 'e2e-demo'],
    setup: () => {
      const r = createWorkspace('e2e-demo');
      fs.writeFileSync(path.join(r, 'work', 'a.txt'), 'aaa');
      fs.mkdirSync(path.join(r, 'work', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(r, 'input', 'demo.txt'), 'hello sandbox');
    },
    teardown: () => cleanupWorkspace('e2e-demo'),
  },
  {
    name: '21. 旧 Sandbox 兼容：read（读取 input/demo.txt）',
    prompt: '请读取 input/demo.txt，并告诉我里面写了什么',
    expect: ['hello sandbox'],
    expectTools: ['read'],
    cliArgs: ['--run-id', 'e2e-demo'],
    setup: () => {
      const r = createWorkspace('e2e-demo');
      fs.writeFileSync(path.join(r, 'input', 'demo.txt'), 'hello sandbox');
      fs.writeFileSync(path.join(r, 'work', 'a.txt'), 'aaa');
    },
    teardown: () => cleanupWorkspace('e2e-demo'),
  },
];

// 运行单个子进程命令，返回 stdout（含 stderr 合并，避免 execFileSync 抛错吞掉输出）
function run(cmd: string, args: string[], env?: Record<string, string>): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

// 真正制造一次可恢复中断：等待第一步工具完成并进入下一轮 LLM 请求后，
// 由测试进程终止 CLI 子进程。这样不依赖不存在的 SIMULATE_INTERRUPT 环境变量，
// checkpoint 必须来自真实的中断现场。
async function runInterrupted(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ output: string; interrupted: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let interrupted = false;
    const terminate = (): void => {
      if (!child.pid) return;
      try {
        // npx may spawn a separate tsx/node child; terminate the whole test
        // process group so a killed phase cannot keep writing the checkpoint.
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const deadline = setTimeout(() => {
      if (!interrupted) terminate();
    }, 120_000);
    const onData = (chunk: Buffer | string): void => {
      output += String(chunk);
      // 迭代 2 说明第一轮工具结果已经保存，下一轮 LLM 请求已经开始。
      if (
        !interrupted &&
        output.includes('[Tool 调用] calculator') &&
        output.includes('--- 迭代 2 ---')
      ) {
        interrupted = true;
        terminate();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('close', () => {
      clearTimeout(deadline);
      resolve({ output, interrupted });
    });
  });
}

// 断言单个任务是否通过
function assert(tc: TestCase, out: string): { pass: boolean; reason: string } {
  if (tc.noTool) {
    // 纯对话：不应出现工具调用，且应给出最终答案
    const hasTool = out.includes('[Tool 调用]');
    const hasAnswer = out.includes('最终答案');
    if (hasTool) return { pass: false, reason: '不应调用工具，但出现了 [Tool 调用]' };
    if (!hasAnswer) return { pass: false, reason: '缺少 [最终答案]' };
    return { pass: true, reason: '' };
  }
  // 基线：非纯对话任务也必须给出最终答案（防止 Agent 崩溃 / 超迭代静默失败）
  if (!out.includes('最终答案')) {
    return { pass: false, reason: '缺少 [最终答案]，Agent 可能崩溃或 Host/LLM 请求超时' };
  }
  const missing = tc.expect.filter((k) => !out.includes(k));
  if (missing.length > 0) {
    return { pass: false, reason: `答案缺少关键词: ${missing.join(', ')}` };
  }
  if (tc.expectAny?.length && !tc.expectAny.some((k) => out.includes(k))) {
    return { pass: false, reason: `输出缺少任一语义关键词: ${tc.expectAny.join(' / ')}` };
  }
  const calls = [...out.matchAll(/\[Tool 调用\] (\w+)/g)].map((m) => m[1]);
  // 工具调用顺序校验（按出现顺序匹配 [Tool 调用] 行）
  if (tc.expectTools?.length) {
    const idx = tc.expectTools.map((t) => calls.indexOf(t));
    if (idx.includes(-1)) {
      return {
        pass: false,
        reason: `工具调用缺失: ${tc.expectTools.join(' → ')}（实际: ${calls.join(' → ') || '(无)'}）`,
      };
    }
    if (idx.some((v, i) => i > 0 && v <= idx[i - 1])) {
      return {
        pass: false,
        reason: `工具调用顺序错误: 期望 ${tc.expectTools.join(' → ')}（实际: ${calls.join(' → ') || '(无)'}）`,
      };
    }
  }
  // 不应出现的工具调用（如依赖失败后下游工具必须为 0 次）
  if (tc.expectNoTools?.length) {
    const forbidden = tc.expectNoTools.filter((t) => calls.includes(t));
    if (forbidden.length > 0) {
      return {
        pass: false,
        reason: `工具不应被调用: ${forbidden.join(', ')}（实际调用: ${calls.join(' → ') || '(无)'}）`,
      };
    }
  }
  // 精确调用次数（v1.2: 如 getWeather 必须恰好 1 次、calculator 必须 0 次）
  if (tc.expectToolCount) {
    for (const [tool, n] of Object.entries(tc.expectToolCount)) {
      const got = calls.filter((t) => t === tool).length;
      if (got !== n) {
        return { pass: false, reason: `工具 ${tool} 调用次数=${got}，期望 ${n}` };
      }
    }
  }
  // tool_result_invalid 事件（v1.2: 每行一条 Trace 事件，结果 JSON 内嵌不影响行匹配）
  if (tc.expectInvalid) {
    const inv = tc.expectInvalid; // 闭包内收窄失效，先取局部常量
    const lines = out
      .split('\n')
      .filter(
        (l) => l.includes('"type":"tool_result_invalid"') && l.includes(`"tool":"${inv.tool}"`),
      );
    if (lines.length !== inv.count) {
      return {
        pass: false,
        reason: `tool_result_invalid(${inv.tool}) 次数=${lines.length}，期望 ${inv.count}`,
      };
    }
  }
  // State 字段校验（最终 printState 的 JSON 输出，如 "invalidToolResults": 1）
  if (tc.expectState) {
    for (const [k, v] of Object.entries(tc.expectState)) {
      if (!out.includes(`"${k}": ${v}`)) {
        return { pass: false, reason: `State 缺少 "${k}": ${v}` };
      }
    }
  }
  // completedSteps 不得包含指定子串（v1.2: invalid 结果不应进入 completedSteps；
  // 用"不包含"而非"整体为空"，因为 LLM 可能合法地探索其他参数产生有效步骤）
  if (tc.expectCompletedNotContain?.length) {
    const blocks = out.split('=== Scratchpad ===');
    const last = blocks[blocks.length - 1] ?? '';
    const m = last.match(/"completedSteps":\s*\[([\s\S]*?)\],\s*"failedSteps"/);
    const section = m ? m[1] : '';
    for (const s of tc.expectCompletedNotContain) {
      if (section.includes(s)) {
        return { pass: false, reason: `completedSteps 中包含不应出现的内容: ${s}` };
      }
    }
  }
  return { pass: true, reason: '' };
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Agent 能力测试集（真实 LLM 端到端）');
  console.log('='.repeat(60));

  const results: { name: string; pass: boolean; reason: string }[] = [];

  for (const tc of TASKS) {
    console.log(`\n▶ ${tc.name}`);
    console.log(`  任务: ${tc.prompt.slice(0, 80)}${tc.prompt.length > 80 ? '...' : ''}`);

    let out = '';
    try {
      tc.setup?.(); // 运行前准备（如预置沙箱工作区文件）
      if (tc.resume) {
        // 1) 在第一步工具完成、第二轮 LLM 请求开始后终止进程
        console.log('  [阶段1] 运行并模拟中断...');
        const interrupted = await runInterrupted(
          'npx',
          ['tsx', '--env-file=.env', 'src/cli.ts', ...(tc.cliArgs ?? []), tc.prompt],
          tc.env,
        );
        out = interrupted.output;
        if (!interrupted.interrupted) {
          results.push({ name: tc.name, pass: false, reason: '未在第一轮工具完成后中断 CLI' });
          console.log('  [FAIL] 未在第一轮工具完成后中断 CLI');
          continue;
        }
        // 提取 checkpoint runId（从 saved 路径）
        const m = out.match(/\.checkpoints\/([0-9a-f-]+)\.json/);
        if (!m) {
          results.push({ name: tc.name, pass: false, reason: '中断运行未产生 checkpoint' });
          console.log('  [FAIL] 未找到 checkpoint 文件');
          continue;
        }
        const runId = m[1];
        const checkpoint = loadCheckpoint(runId);
        if (!checkpoint || checkpoint.status === 'completed') {
          results.push({
            name: tc.name,
            pass: false,
            reason: '中断现场没有可恢复的 running checkpoint',
          });
          console.log('  [FAIL] 中断现场没有可恢复的 running checkpoint');
          continue;
        }
        console.log(`  [阶段2] 从 checkpoint 恢复 (runId=${runId.slice(0, 8)}...)...`);
        out = run('npx', [
          'tsx',
          '--env-file=.env',
          'src/cli.ts',
          ...(tc.cliArgs ?? []),
          '--resume',
          runId,
        ]);
      } else {
        out = run(
          'npx',
          ['tsx', '--env-file=.env', 'src/cli.ts', ...(tc.cliArgs ?? []), tc.prompt],
          tc.env,
        );
      }
    } catch (err) {
      out += `\n[test runner error] ${(err as Error).message}`;
    } finally {
      tc.teardown?.(); // 运行后清理（continue 路径也会执行）
    }

    const { pass, reason } = assert(tc, out);
    results.push({ name: tc.name, pass, reason });

    if (pass) {
      console.log(`  [PASS] ✓`);
    } else {
      console.log(`  [FAIL] ✗ ${reason}`);
      // 打印最后 3 行关键输出辅助定位
      const tail = out.split('\n').filter(Boolean).slice(-3);
      tail.forEach((l) => {
        console.log(`    | ${l}`);
      });
    }
  }

  // 清理测试产生的 checkpoint（环境安全删除守卫可能拦截大批量删除，失败不阻塞汇总）
  try {
    rmSync('.checkpoints', { recursive: true, force: true });
  } catch (e) {
    console.log(
      `  [cleanup] 清理 .checkpoints 被安全守卫拦截（可手动删除）: ${(e as Error).message.split('\n')[0]}`,
    );
  }

  // 汇总
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${'='.repeat(60)}`);
  console.log('汇总');
  console.log('='.repeat(60));
  results.forEach((r) => {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ` — ${r.reason}`}`);
  });
  console.log(`\n通过 ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
