// 模块: Prompt 命令测试（Harness Phase 2 Step 4）
// 覆盖：scanPromptCommands / parsePromptFrontmatter / stripFrontmatter /
//       interpolatePrompt / expandPromptCommand / HTTP GET /prompts
// 不依赖 LLM；用隔离沙箱根 + 临时 workspace + .payaso/prompts 样例文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandPromptCommand } from '../src/host/run-manager.js';
import { createHostServer, RunManager } from '../src/host/server.js';
import { clearWorkspace, setWorkspace } from '../src/host/workspace.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-prompts-test-'));
process.env.SANDBOX_ROOT = ROOT;
process.env.PAYASO_DB_PATH = path.join(ROOT, 'payaso.db');
fs.mkdirSync(ROOT, { recursive: true });

// 临时 workspace + 样例 prompts
const WS = path.join(ROOT, 'ws');
fs.mkdirSync(path.join(WS, '.payaso', 'prompts'), { recursive: true });
fs.writeFileSync(
  path.join(WS, '.payaso', 'prompts', 'review.md'),
  `---
name: review
description: Perform a structured code review
---

Please review the following code for:
1. Correctness and edge cases
2. Performance implications
3. Security concerns

$@
`,
);
fs.writeFileSync(
  path.join(WS, '.payaso', 'prompts', 'test.md'),
  `---
name: test
description: Generate test cases from code patterns
---

Write tests for: $1
Fallback example: ${'$' + '{2:-all}'}
`,
);
// 非法文件名：不应被扫描（含大写 / 下划线）
fs.writeFileSync(
  path.join(WS, '.payaso', 'prompts', 'BAD_NAME.md'),
  '---\nname: bad\n---\ncontent\n',
);

const manager = new RunManager();
const server = createHostServer(manager);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

setWorkspace(WS);

try {
  // ---- HTTP GET /prompts ----
  {
    const r = await fetch(`${base}/prompts`);
    const body = await r.json();
    check('GET /prompts 返回 200', r.status === 200);
    check(
      '命令列表含 review + test（升序）',
      Array.isArray(body.prompts) &&
        body.prompts.length === 2 &&
        body.prompts[0].name === 'review' &&
        body.prompts[1].name === 'test',
      JSON.stringify(body.prompts),
    );
    check(
      '元数据只含 name + description',
      body.prompts.every((p: Record<string, unknown>) => {
        const keys = Object.keys(p).sort();
        return keys.length === 2 && keys[0] === 'description' && keys[1] === 'name';
      }),
    );
  }

  // ---- expandPromptCommand ----
  {
    const commands = [
      { name: 'review', description: 'x', template: 'Review code for:\n$@\n--end' },
      { name: 'test', description: 'x', template: 'Write tests for: $1 (fallback $' + '{2:-all})' },
    ];
    check('无 / 前缀 → 原样返回', expandPromptCommand('hello world', commands) === null);
    check('未知命令 → 降级 null', expandPromptCommand('/unknown foo', commands) === null);
    check(
      '$@ 展开 + 多行参数保留',
      expandPromptCommand('/review file.ts bug', commands) ===
        'Review code for:\nfile.ts bug\n--end',
    );
    check(
      '$1 展开',
      expandPromptCommand('/test math', commands) === 'Write tests for: math (fallback all)',
    );
    check(
      '参数缺省 $' + '{2:-default}',
      expandPromptCommand('/test', commands) === 'Write tests for:  (fallback all)',
    );
    check(
      '多行 task：第一行 /cmd，后续正文追加到模板之后',
      expandPromptCommand('/review\nkeep this', commands) ===
        'Review code for:\n\n--end\nkeep this',
    );
  }
} finally {
  clearWorkspace();
  server.close();
  manager.close();
}

console.log(`\nPrompt commands tests: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) process.exit(1);
