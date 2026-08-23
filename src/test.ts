// 模块: 能力测试集 — 端到端跑 10 个真实 Agent 任务，校验输出并汇总 PASS/FAIL
// 用法: npx tsx --env-file=.env src/test.ts
// 说明: 每个任务以独立子进程运行（真实调用 LLM + 工具），避免状态互相干扰

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

interface TestCase {
  name: string; // 测试名
  prompt: string; // 用户任务
  expect: string[]; // 最终答案需包含的关键词（任一命中即 PASS）
  expectTools?: string[]; // 期望按顺序出现的工具调用（校验 [Tool 调用] 行）
  expectNoTools?: string[]; // 期望完全不出现在 [Tool 调用] 行中的工具
  env?: Record<string, string>; // 额外环境变量（如模拟中断）
  resume?: boolean; // 中断恢复任务：先中断运行，再从 checkpoint 恢复
  noTool?: boolean; // 纯对话任务：期望不调用工具
}

const TASKS: TestCase[] = [
  {
    name: "1. 基础计算（单步）",
    prompt: "帮我计算 15*37",
    expect: ["555"],
    expectTools: ["calculator"],
  },
  {
    name: "2. 多步骤计算（串行依赖）",
    prompt: "先算 15*37，再把结果加 100",
    expect: ["655"],
  },
  {
    name: "3. 多步骤计算（4步长链）",
    prompt:
      "请严格分步计算，禁止合并表达式，每一步只调用一次 calculator：先算 2*3，再用上一步结果乘 4，再用结果乘 5，再用结果乘 6。每步单独调用工具。",
    expect: ["720"],
  },
  {
    name: "4. 多工具调用（并行）",
    prompt: "帮我分别计算 15*37 和 24*8，然后告诉我哪个结果更大",
    expect: ["555", "192", "更大"],
  },
  {
    name: "5. 工具失败恢复",
    prompt:
      "严格分步执行：①先用 calculator 算 15*37；②把结果加 100 再算一次；③现在请用 calculator 计算，但 expression 参数必须传 'x+1' 这个非法字符串；④如果第③步失败，请改用合法表达式重新计算 655+100；⑤告诉我每一步结果和最终答案",
    expect: ["755"],
  },
  {
    name: "6. 工具返回异常（Infinity）",
    prompt: "请用 calculator 计算 1/0，然后告诉我结果是什么含义",
    expect: ["Infinity", "无穷"],
  },
  {
    name: "7. 死循环检测（同参数禁调）",
    prompt:
      "请用 calculator 计算 2*3，然后无论失败与否，都用 calculator 参数 'x+1' 再调用 5 次，最后告诉我结果",
    expect: ["Blocked", "禁止再次调用"],
  },
  {
    name: "8. 长上下文（6步链触发裁剪）",
    prompt:
      "请严格分步计算，禁止合并表达式，每一步只调用一次 calculator：先算 2*3，再用上一步结果乘 4，再用结果乘 5，再用结果乘 6，再用结果乘 7，再用结果乘 8。每步单独调用工具。",
    expect: ["40320"],
  },
  {
    name: "9. 中断恢复（checkpoint --resume）",
    prompt: "帮我计算 15*37，再把结果加 100",
    expect: ["655"],
    env: { SIMULATE_INTERRUPT: "1" },
    resume: true,
  },
  {
    name: "10. 纯对话（不调用工具）",
    prompt: "你好，介绍一下你自己",
    expect: [],
    noTool: true,
  },
  {
    name: "11. getWeather（只调用天气工具）",
    prompt: "深圳天气怎么样",
    expect: ["28°C", "天气: 深圳"],
    expectTools: ["getWeather"],
  },
  {
    name: "12. 工具选择（计算只走 calculator）",
    prompt: "帮我计算 15*37",
    expect: ["555"],
    expectTools: ["calculator"],
  },
  {
    name: "13. 工具串联（天气 → 计算）",
    prompt: "查询深圳温度，再把温度加10",
    expect: ["38"],
    expectTools: ["getWeather", "calculator"],
  },
  {
    name: "14. 上游 Tool 失败，下游依赖中止",
    prompt:
      "查询“不存在的城市”的天气，再把温度加10。如果天气查询失败，不要调用 calculator，不要编造温度，直接说明无法完成后续计算。",
    expect: ["天气查询失败", "无法", "失败"],
    expectTools: ["getWeather"],
    expectNoTools: ["calculator"],
  },
];

// 运行单个子进程命令，返回 stdout（含 stderr 合并，避免 execFileSync 抛错吞掉输出）
function run(cmd: string, args: string[], env?: Record<string, string>): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

// 断言单个任务是否通过
function assert(tc: TestCase, out: string): { pass: boolean; reason: string } {
  if (tc.noTool) {
    // 纯对话：不应出现工具调用，且应给出最终答案
    const hasTool = out.includes("[Tool 调用]");
    const hasAnswer = out.includes("最终答案");
    if (hasTool) return { pass: false, reason: "不应调用工具，但出现了 [Tool 调用]" };
    if (!hasAnswer) return { pass: false, reason: "缺少 [最终答案]" };
    return { pass: true, reason: "" };
  }
  const missing = tc.expect.filter((k) => !out.includes(k));
  if (missing.length > 0) {
    return { pass: false, reason: `答案缺少关键词: ${missing.join(", ")}` };
  }
  // 工具调用顺序校验（按出现顺序匹配 [Tool 调用] 行）
  if (tc.expectTools?.length) {
    const calls = [...out.matchAll(/\[Tool 调用\] (\w+)/g)].map((m) => m[1]);
    const idx = tc.expectTools.map((t) => calls.indexOf(t));
    if (idx.includes(-1)) {
      return { pass: false, reason: `工具调用缺失: ${tc.expectTools.join(" → ")}（实际: ${calls.join(" → ") || "(无)"}）` };
    }
    if (idx.some((v, i) => i > 0 && v <= idx[i - 1])) {
      return { pass: false, reason: `工具调用顺序错误: 期望 ${tc.expectTools.join(" → ")}（实际: ${calls.join(" → ") || "(无)"}）` };
    }
  }
  // 不应出现的工具调用（如依赖失败后下游工具必须为 0 次）
  if (tc.expectNoTools?.length) {
    const calls = [...out.matchAll(/\[Tool 调用\] (\w+)/g)].map((m) => m[1]);
    const forbidden = tc.expectNoTools.filter((t) => calls.includes(t));
    if (forbidden.length > 0) {
      return { pass: false, reason: `工具不应被调用: ${forbidden.join(", ")}（实际调用: ${calls.join(" → ") || "(无)"}）` };
    }
  }
  return { pass: true, reason: "" };
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Agent 能力测试集（真实 LLM 端到端）");
  console.log("=".repeat(60));

  const results: { name: string; pass: boolean; reason: string }[] = [];

  for (const tc of TASKS) {
    console.log(`\n▶ ${tc.name}`);
    console.log(`  任务: ${tc.prompt.slice(0, 80)}${tc.prompt.length > 80 ? "..." : ""}`);

    let out = "";
    try {
      if (tc.resume) {
        // 1) 中断运行（第2次 LLM 调用时网络中断）
        console.log("  [阶段1] 运行并模拟中断...");
        out = run("npx", ["tsx", "--env-file=.env", "src/agent.ts", tc.prompt], tc.env);
        // 提取 checkpoint runId（从 saved 路径）
        const m = out.match(/\.checkpoints\/([0-9a-f-]+)\.json/);
        if (!m) {
          results.push({ name: tc.name, pass: false, reason: "中断运行未产生 checkpoint" });
          console.log("  [FAIL] 未找到 checkpoint 文件");
          continue;
        }
        const runId = m[1];
        console.log(`  [阶段2] 从 checkpoint 恢复 (runId=${runId.slice(0, 8)}...)...`);
        out = run("npx", ["tsx", "--env-file=.env", "src/agent.ts", "--resume", runId]);
      } else {
        out = run("npx", ["tsx", "--env-file=.env", "src/agent.ts", tc.prompt], tc.env);
      }
    } catch (err) {
      out += `\n[test runner error] ${(err as Error).message}`;
    }

    const { pass, reason } = assert(tc, out);
    results.push({ name: tc.name, pass, reason });

    if (pass) {
      console.log(`  [PASS] ✓`);
    } else {
      console.log(`  [FAIL] ✗ ${reason}`);
      // 打印最后 3 行关键输出辅助定位
      const tail = out.split("\n").filter(Boolean).slice(-3);
      tail.forEach((l) => console.log(`    | ${l}`));
    }
  }

  // 清理测试产生的 checkpoint
  rmSync(".checkpoints", { recursive: true, force: true });

  // 汇总
  const passed = results.filter((r) => r.pass).length;
  console.log("\n" + "=".repeat(60));
  console.log("汇总");
  console.log("=".repeat(60));
  results.forEach((r) => {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : ` — ${r.reason}`}`);
  });
  console.log(`\n通过 ${passed}/${results.length}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
