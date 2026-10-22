// 套件: 前端 Run 文本取值 — 脏数据不得让渲染期抛错（白屏回归闸门）
// 用法: node --import tsx tests/frontend-run-task.test.ts
// 覆盖：run-task 安全取值（非字符串→空串/不抛错）、截断长度与改动前逐字一致、
//   以及两条接线不变量（TurnNavigator/Timeline 不得再直接 `.task.slice()`；
//   入口 main.tsx 必须挂根级 ErrorBoundary）。
//
// 背景（实测复现）：/runs 响应里第 2 轮 `task: null` 时，TurnNavigator 的
// `run.task.slice(0, 30)` 抛 TypeError，React 卸载整棵树，`#root` 子节点变 0，
// 页面只剩标题栏空白。task 在类型/存储层是必填，但 API 边界无运行时校验，
// 因此这里把「取值必须类型安全」钉成确定性契约。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runResultClip, runTaskClip, runTaskText } from '../web/src/run-task.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

// ---- 1. runTaskText：只有字符串原样返回，其余一律降级为空串 ----
check('runTaskText：字符串原样返回（不 trim、不截断）', () => {
  assert.equal(runTaskText({ task: '  改一下登录逻辑  ' }), '  改一下登录逻辑  ');
  assert.equal(runTaskText({ task: '' }), '');
});

check('runTaskText：null / undefined / 数字 / 对象 / 数组 → 空串，不抛错', () => {
  assert.equal(runTaskText({ task: null as unknown as string }), '');
  assert.equal(runTaskText({ task: undefined as unknown as string }), '');
  assert.equal(runTaskText({ task: 42 as unknown as string }), '');
  assert.equal(runTaskText({ task: {} as unknown as string }), '');
  assert.equal(runTaskText({ task: [] as unknown as string }), '');
  assert.equal(runTaskText(null), '');
  assert.equal(runTaskText(undefined), '');
});

// ---- 2. 取值与改动前的 `.slice()` 写法逐字一致（正常数据展示内容不变）----
check('runTaskClip：截断长度与改动前一致，超长补 … 只在展示层做', () => {
  const long = 'x'.repeat(50);
  assert.equal(runTaskClip({ task: long }, 30), 'x'.repeat(30));
  assert.equal(runTaskClip({ task: '短任务' }, 30), '短任务');
  assert.equal(runTaskClip({ task: long }, 120).length, 50, 'limit 大于长度时原样返回');
});

check('runTaskClip：脏数据 → 空串（调用方据此兜「未命名任务」）', () => {
  assert.equal(runTaskClip({ task: null as unknown as string }, 30), '');
  assert.equal(runTaskClip(null, 30), '');
});

check('runResultClip：终态结果截断与空值语义（空串为假值，跳过该行）', () => {
  assert.equal(runResultClip({ result: 'y'.repeat(200) }, 160).length, 160);
  assert.equal(runResultClip({ result: '短结果' }, 160), '短结果');
  assert.equal(runResultClip({ result: null as unknown as string }, 160), '');
  assert.equal(runResultClip({ result: '' }, 160), '');
  assert.ok(!runResultClip({ result: null as unknown as string }, 160), '空串必须是假值');
});

// ---- 3. 回归靶心：曾崩溃的两处调用现在必须安全 ----
check('回归：{ task: null } 走安全入口不再抛 TypeError（原崩溃点）', () => {
  const dirty = { task: null as unknown as string, result: null as unknown as string };
  assert.doesNotThrow(() => runTaskClip(dirty, 30));
  assert.doesNotThrow(() => runResultClip(dirty, 160));
  // 对照：改动前的写法确实会炸（证明本测试守的是真问题，不是空跑）
  assert.throws(() => (dirty.task as string).slice(0, 30), /Cannot read properties of null/);
});

// ---- 4. 接线不变量：源码不得绕过安全入口 / 不得丢掉根级兜底 ----
const projectRoot = process.cwd();
const readSource = (relative: string): string =>
  fs.readFileSync(path.resolve(projectRoot, relative), 'utf8');

check('TurnNavigator / Timeline 不再直接 `.task.slice(` / `.result.slice(`', () => {
  const offenders: string[] = [];
  for (const relative of [
    'web/src/components/TurnNavigator/index.tsx',
    'web/src/components/Timeline/index.tsx',
  ]) {
    const source = readSource(relative);
    if (/\b(run|preview|props\.run)\.task\.slice\(/.test(source))
      offenders.push(`${relative}: .task.slice`);
    if (/\b(preview|run)\.result\.slice\(/.test(source))
      offenders.push(`${relative}: .result.slice`);
  }
  assert.deepEqual(offenders, [], `仍有未经安全入口的取值：${offenders.join(', ')}`);
});

check('两处调用点确实走 run-task 安全入口', () => {
  assert.ok(readSource('web/src/components/TurnNavigator/index.tsx').includes('../../run-task'));
  assert.ok(readSource('web/src/components/Timeline/index.tsx').includes('../../run-task'));
});

check('入口挂载根级 ErrorBoundary，且 App 在其子树内', () => {
  const main = readSource('web/src/main.tsx');
  assert.ok(main.includes('ErrorBoundary'), 'main.tsx 必须有 ErrorBoundary');
  assert.match(
    main,
    /<ErrorBoundary>[\s\S]*<App\s*\/>[\s\S]*<\/ErrorBoundary>/,
    'App 必须包在 ErrorBoundary 内（否则渲染期异常仍会卸载整棵树）',
  );
});

check('ErrorBoundary 实现渲染期兜底的两条必需钩子', () => {
  const boundary = readSource('web/src/components/ErrorBoundary/index.tsx');
  assert.ok(boundary.includes('getDerivedStateFromError'), '缺 getDerivedStateFromError');
  assert.ok(boundary.includes('componentDidCatch'), '缺 componentDidCatch');
});

console.log(`\nFrontend run-task tests: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
