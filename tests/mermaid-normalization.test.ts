import assert from 'node:assert/strict';
import { normalizeMermaidChart } from '../web/src/components/MermaidBlock/normalize-chart.js';

// Regression from the 2026-09-27 run: Mermaid interprets `(` in a bare edge
// label as shape syntax, even though the surrounding node labels are quoted.
const runChart = `flowchart TD
  UI["Web UI (web/, React+Vite)<br/>dev 5173 / dist 由 Host 托管"] -->|fetch + SSE| Host
  Host["Host (src/host/, node:http, 仅 127.0.0.1:4500)<br/>server → routes(域 handler) → RunManager 门面<br/>+ SQLite 持久化 + 工作区/设置/Session 服务"] -->|runAgent(task, checkpoint?, opts)| Runtime
  Runtime["Runtime Kernel (src/runtime + src/llm + src/tools)<br/>agent.ts 循环 · turn-policy 回合策略 · tool-invocation 封闭管道<br/>harness/ 裁剪与摘要 · tools/ 14 个工具"] -->|ToolContext 注入权限| Sandbox
  Sandbox["Sandbox (src/sandbox/)<br/>macOS sandbox-exec 隔离 · 工具链发现/准备 · 后台作业"]`;

const normalized = normalizeMermaidChart(runChart);
assert.ok(normalized.includes('-->|"runAgent(task, checkpoint?, opts)"| Runtime'));
assert.ok(normalized.includes('-->|"fetch + SSE"| Host'));
assert.equal(normalizeMermaidChart(normalized), normalized, 'normalization must be idempotent');

const quoted = 'flowchart TD\n  A["text -->|inside (label)|"] -->|"already (quoted)"| B';
assert.equal(normalizeMermaidChart(quoted), quoted, 'quoted node and edge labels stay intact');
const quotedPipe = 'flowchart TD\n  A -->|"already | quoted"| B';
assert.equal(normalizeMermaidChart(quotedPipe), quotedPipe);
assert.equal(
  normalizeMermaidChart('flowchart TD\n  A -->|call("x")| B'),
  'flowchart TD\n  A -->|"call(#quot;x#quot;)"| B',
);
assert.equal(
  normalizeMermaidChart('flowchart TD\n  A ==>|event(x)| B\n  B -.->|retry(y)| C'),
  'flowchart TD\n  A ==>|"event(x)"| B\n  B -.->|"retry(y)"| C',
);
assert.equal(
  normalizeMermaidChart('flowchart TD\n  A[unquoted (node)] --> B'),
  'flowchart TD\n  A["unquoted (node)"] --> B',
);

console.log('Mermaid normalization tests: 6 PASS / 0 FAIL');
