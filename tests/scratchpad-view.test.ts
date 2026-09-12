// 套件: Scratchpad View — 进度投影只保留行为信号，不重复工具结果
// 用法: npx tsx tests/scratchpad-view.test.ts
// 回归目标（v1.10）：原实现每步回放 1000 字符结果 + 再回放一次 lastResult，
// 实测每请求 ~6.3K token，且与 transcript 重复、每轮变化破坏 prompt cache。

import assert from 'node:assert/strict';
import { estimateTextTokens } from '../src/harness/model-context.js';
import {
  renderBoundedScratchpadView,
  type ScratchpadView,
} from '../src/harness/scratchpad-view.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

function pad(overrides: Partial<ScratchpadView> = {}): ScratchpadView {
  return {
    task: '分析项目',
    completedSteps: [],
    failedSteps: [],
    invalidSteps: [],
    nextStep: null,
    lastResult: '',
    ...overrides,
  };
}

function step(index: number, result = 'R'.repeat(1_000)) {
  return { step: index, tool: 'read', input: `src/file-${index}.ts`, result };
}

await test('空 scratchpad 仍有结构（任务/下一步/约束）', () => {
  const view = renderBoundedScratchpadView(pad());
  assert.match(view.text, /执行进度 Scratchpad/);
  assert.match(view.text, /任务: 分析项目/);
  assert.match(view.text, /已完成步骤:/);
  assert.match(view.text, /\(暂无\)/);
  assert.match(view.text, /下一步:/);
  assert.match(view.text, /禁止重复调用失败记录中的相同参数/);
});

await test('不再回放工具结果（结果由 transcript 承载）', () => {
  const view = renderBoundedScratchpadView(
    pad({
      completedSteps: [step(1, 'SECRET_TOOL_OUTPUT'.repeat(50))],
      lastResult: 'LAST_RESULT_MARKER'.repeat(50),
    }),
  );
  assert.ok(!view.text.includes('SECRET_TOOL_OUTPUT'), '不应包含步骤结果');
  assert.ok(!view.text.includes('LAST_RESULT_MARKER'), '不应包含 lastResult');
  assert.ok(view.text.includes('read("src/file-1.ts")'), '应保留调用记录');
});

await test('步骤列表只保留最近 N 步并标注省略', () => {
  const steps = Array.from({ length: 30 }, (_, i) => step(i + 1));
  const view = renderBoundedScratchpadView(pad({ completedSteps: steps }), {
    maxCompletedSteps: 5,
  });
  assert.equal(view.omittedCompletedSteps, 25);
  assert.match(view.text, /共 30 步（最近 5 步）/);
  assert.match(view.text, /已省略更早 25 步/);
  assert.ok(view.text.includes('read("src/file-30.ts")'), '保留最新');
  assert.ok(!view.text.includes('src/file-25.ts'), '更早的应被省略');
});

await test('长输入被裁剪到字段上限', () => {
  const view = renderBoundedScratchpadView(
    pad({ completedSteps: [{ step: 1, tool: 'grep', input: 'x'.repeat(500), result: '' }] }),
    { maxFieldChars: 100 },
  );
  assert.ok(view.text.includes('…[truncated]'));
  assert.equal(view.truncated, true);
  assert.ok(!view.text.includes('x'.repeat(200)), '超长输入必须被裁剪');
});

await test('失败/无效记录保留（防重复调用的关键信号）', () => {
  const view = renderBoundedScratchpadView(
    pad({
      failedSteps: [{ tool: 'read', input: 'missing.ts', error: '文件不存在', retries: 3 }],
      invalidSteps: [
        { tool: 'grep', input: 'work/bin', result: 'x', reason: '二进制文件，不支持搜索' },
      ],
    }),
  );
  assert.ok(view.text.includes('已失败 3 次'));
  assert.ok(view.text.includes('禁止再次调用相同参数'));
  assert.ok(view.text.includes('结果无效'));
  assert.ok(view.text.includes('不要重复依赖该结果'));
});

await test('nextStep 被渲染（未决策时给出等待提示）', () => {
  const withNext = renderBoundedScratchpadView(
    pad({ nextStep: { tool: 'edit', input: 'src/a.ts' } }),
  );
  assert.ok(withNext.text.includes('edit("src/a.ts")'));
  const without = renderBoundedScratchpadView(pad());
  assert.ok(without.text.includes('等待 LLM 决策'));
});

await test('token 预算：20 步各 1000 字符结果时仍显著低于旧实现（旧 ≈6.3K）', () => {
  const steps = Array.from({ length: 20 }, (_, i) => step(i + 1, 'R'.repeat(1_000)));
  const view = renderBoundedScratchpadView(pad({ completedSteps: steps }));
  const tokens = estimateTextTokens(view.text);
  assert.ok(tokens < 1_500, `应远小于旧实现的 6.3K，实际 ${tokens}`);
  assert.ok(view.text.length > 0);
});

await test('超长任务描述被裁剪且标记 truncated', () => {
  const view = renderBoundedScratchpadView(pad({ task: 'T'.repeat(2_000) }), {
    maxTaskChars: 120,
  });
  assert.equal(view.truncated, true);
  assert.ok(!view.text.includes('T'.repeat(200)));
});

console.log(`\nscratchpad-view 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
