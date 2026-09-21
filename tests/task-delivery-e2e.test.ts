// 真实 LLM 的交付闭环验收，独立于确定性集合；所有产物与数据库均位于临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-delivery-e2e-'));
process.env.PAYASO_HOME = path.join(root, 'home');
process.env.PAYASO_DB_PATH = path.join(root, 'payaso.db');
process.env.SANDBOX_ROOT = path.join(root, 'sandbox');
const { createHostServer, RunManager } = await import('../src/host/server.js');
const { setWorkspace, clearWorkspace } = await import('../src/host/workspace.js');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
fs.cpSync(path.resolve('.payaso/prompts'), path.join(workspace, '.payaso/prompts'), {
  recursive: true,
});
fs.writeFileSync(path.join(workspace, 'sum.cjs'), 'exports.sum = (a, b) => a - b;\n');
fs.writeFileSync(
  path.join(workspace, 'sum.test.cjs'),
  "const assert = require('node:assert/strict'); const {sum} = require('./sum.cjs'); assert.equal(sum(2,3),5); console.log('sum checks passed');\n",
);
setWorkspace(workspace);
const manager = new RunManager();
const server = createHostServer(manager);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
fs.writeFileSync('/tmp/payaso-delivery-e2e-location.json', JSON.stringify({ root, base }));
console.log(JSON.stringify({ root, base }));
async function json(url: string, init?: RequestInit) {
  const response = await fetch(base + url, init);
  assert.ok(response.ok, `${url}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response.json();
}
async function run(task: string, sessionId?: string, attachments?: unknown[]) {
  const created = await json('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, sessionId, attachments, permissionMode: 'workspace-write' }),
  });
  for (let i = 0; i < 240; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const current = await json(`/runs/${created.runId}`);
    if (current.status === 'running' || current.status === 'stopping') continue;
    const delivery = await json(`/runs/${created.runId}/delivery`);
    fs.writeFileSync(
      path.join(root, `${created.runId}.json`),
      JSON.stringify({ run: current, delivery }, null, 2),
    );
    console.log(
      JSON.stringify({
        task: task.split('\n')[0],
        status: current.status,
        runId: created.runId,
        files: delivery.files,
        checks: delivery.checks,
      }),
    );
    assert.equal(current.status, 'completed', current.error);
    return { ...created, delivery };
  }
  await json(`/runs/${created.runId}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  throw new Error('LLM run timed out');
}
let keep = false;
try {
  const documents = [
    '# 旧版\n超时为 10 秒。只支持 JSON 导出。\n',
    '# 新版\n超时为 30 秒。支持 JSON 和 CSV 导出。\n',
  ];
  const comparison = await run(
    '/compare-docs',
    undefined,
    documents.map((text, i) => ({
      name: `version-${i + 1}.md`,
      mimeType: 'text/markdown',
      dataBase64: Buffer.from(text).toString('base64'),
    })),
  );
  const report = comparison.delivery.files.find(
    (file: { name: string }) => file.name === 'reports/document-comparison.md',
  );
  assert.ok(report, 'comparison report must be a deliverable');
  const download = await fetch(
    `${base}/runs/${comparison.runId}/files/${encodeURIComponent(report.name)}?download=1`,
  );
  assert.ok(download.ok);
  const original = await download.text();
  assert.match(original, /10/);
  assert.match(original, /30/);
  assert.match(original, /CSV/i);
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
  const code = await run(
    '修复 sum.cjs 的加法错误，仅修改该文件；执行 node sum.test.cjs 验证，并汇报结果。',
  );
  assert.ok(code.delivery.files.some((file: { name: string }) => file.name === 'sum.cjs'));
  assert.ok(
    code.delivery.checks.some((check: { status: string }) => check.status === 'passed'),
    'must have actual passing check',
  );
  const review = await run('/review-project .\n只审查 sum.cjs 与 sum.test.cjs，报告保持简短。');
  assert.ok(
    review.delivery.files.some(
      (file: { name: string }) => file.name === 'reports/project-review.md',
    ),
  );
  await run(
    '继续修改 reports/document-comparison.md，在末尾新增“验收备注”一节，正文为“已核对两个版本的超时与导出格式变化。”，不要新建其他报告。检查后给出文件链接。',
    comparison.sessionId,
  );
  const after = await json(`/runs/${comparison.runId}/delivery`);
  assert.equal(
    after.files.find((file: { name: string }) => file.name === report.name)?.status,
    'changed',
  );
  console.log(
    'Delivery real E2E: PASS (document comparison / download / code check / project review / continued edit)',
  );
  keep = process.env.PAYASO_DELIVERY_KEEP_SERVER === '1';
} finally {
  if (!keep) {
    clearWorkspace();
    server.close();
    manager.close();
  }
}
if (keep) {
  console.log('Server retained for UI verification; stop this test process after review.');
  const cleanup = () => {
    clearWorkspace();
    server.close();
    manager.close();
    process.exit(0);
  };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
  setTimeout(cleanup, 10 * 60_000);
}
