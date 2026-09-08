// 确定性测试：工具链准备成功后的显式重试入口（纯函数部分）。
// 失败命令提取 + 重试消息组装；真实交互在 Timeline 组件中走既有续轮路径。

import {
  composeToolchainRetryMessage,
  findLastFailedShellCommand,
} from '../web/src/components/Timeline/preparation-retry.js';
import type { HostEvent } from '../web/src/types.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const step = (n: number) => ({ step: n, timestamp: `2026-09-05T00:00:0${n}.000Z` });
const shellCall = (n: number, command: string): HostEvent => ({
  ...step(n),
  type: 'tool_call',
  tool: 'shell',
  args: { command },
});
const shellError = (n: number): HostEvent => ({
  ...step(n),
  type: 'tool_error',
  tool: 'shell',
  error: 'missing tool',
  attempt: 1,
  exhausted: true,
});
const readCall = (n: number): HostEvent => ({
  ...step(n),
  type: 'tool_call',
  tool: 'read',
  args: { path: 'a.txt' },
});
const readError = (n: number): HostEvent => ({
  ...step(n),
  type: 'tool_error',
  tool: 'read',
  error: 'boom',
  attempt: 1,
  exhausted: true,
});

check('无事件 → null', findLastFailedShellCommand([]) === null);
check(
  '只有成功调用、无失败 → null',
  (() => {
    const r = findLastFailedShellCommand([shellCall(1, 'git status')]);
    return r === null;
  })(),
);
check(
  'shell 失败 → 提取其命令',
  (() => {
    const r = findLastFailedShellCommand([shellCall(1, 'git status'), shellError(2)]);
    return r === 'git status';
  })(),
);
check(
  '非 shell 工具的失败不参与提取',
  (() => {
    const r = findLastFailedShellCommand([readCall(1), readError(2)]);
    return r === null;
  })(),
);
check(
  '读失败夹在中间 → 仍取最后失败的 shell 命令',
  (() => {
    const r = findLastFailedShellCommand([
      shellCall(1, 'git status'),
      shellError(2),
      readCall(3),
      readError(4),
    ]);
    return r === 'git status';
  })(),
);
check(
  '多次 shell 失败 → 取最后一次',
  (() => {
    const r = findLastFailedShellCommand([
      shellCall(1, 'git status'),
      shellError(2),
      shellCall(3, 'npm test'),
      shellError(4),
    ]);
    return r === 'npm test';
  })(),
);
check(
  "失败后又成功的 shell → 该成功不影响'最后失败'记录",
  (() => {
    const r = findLastFailedShellCommand([
      shellCall(1, 'git status'),
      shellError(2),
      shellCall(3, 'ls'),
    ]);
    return r === 'git status';
  })(),
);

const message = composeToolchainRetryMessage('git status');
check('重试消息包含失败命令', message.includes('`git status`'));
check('重试消息说明来源（依赖安装完成）', message.includes('依赖已安装完成'));
check('重试消息保留用户授权语义', message.includes('明确发起的重试'));

console.log(`\nToolchain retry pure tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
