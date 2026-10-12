// 套件: 前端预览集成 — 工具参数 → 可预览工作区路径的提取规则（M4）
// 用法: npx tsx tests/frontend-tool-file-path.test.ts（纯函数，无浏览器/无 React）
//
// 为什么单测这条规则：Timeline 只凭工具名 + 原始 args 决定要不要给"在预览面板中
// 打开"入口。误判的代价是把 `/etc/passwd`、`../secret`、glob 模式或 URL 送进
// /preview/file（后端会按错误码拒绝，但前端不该给出这个入口）。

import assert from 'node:assert/strict';
import {
  baseName,
  extractToolFilePath,
  normalizePreviewTarget,
} from '../web/src/components/Timeline/tool-file-path';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name} — ${(err as Error).message}`);
  }
}

// ---- normalizePreviewTarget：只认工作区相对路径 ----

test('normalizePreviewTarget：接受普通工作区相对路径', () => {
  assert.equal(normalizePreviewTarget('src/host/preview/types.ts'), 'src/host/preview/types.ts');
  assert.equal(normalizePreviewTarget('a.md'), 'a.md');
  assert.equal(normalizePreviewTarget('  docs/plans/x.md  '), 'docs/plans/x.md');
  assert.equal(
    normalizePreviewTarget('input/attachments/abcd1234-报告.docx'),
    'input/attachments/abcd1234-报告.docx',
  );
});

test('normalizePreviewTarget：拒绝绝对路径 / 家目录 / Windows 盘符', () => {
  assert.equal(normalizePreviewTarget('/etc/passwd'), null);
  assert.equal(normalizePreviewTarget('~/notes.md'), null);
  assert.equal(normalizePreviewTarget('C:\\Users\\me\\a.md'), null);
  assert.equal(normalizePreviewTarget('\\\\server\\share\\a.md'), null);
});

test('normalizePreviewTarget：拒绝 URL 与协议相对地址', () => {
  assert.equal(normalizePreviewTarget('https://example.com/a.md'), null);
  assert.equal(normalizePreviewTarget('file:///tmp/a.md'), null);
});

test('normalizePreviewTarget：拒绝上跳、当前目录段与尾斜杠（目录）', () => {
  assert.equal(normalizePreviewTarget('../outside.md'), null);
  assert.equal(normalizePreviewTarget('a/../../b.md'), null);
  assert.equal(normalizePreviewTarget('./a.md'), null);
  assert.equal(normalizePreviewTarget('a//b.md'), null);
  assert.equal(normalizePreviewTarget('docs/'), null);
});

test('normalizePreviewTarget：拒绝 glob 模式与非字符串/空值', () => {
  assert.equal(normalizePreviewTarget('src/**/*.ts'), null);
  assert.equal(normalizePreviewTarget('src/[ab].ts'), null);
  assert.equal(normalizePreviewTarget('a?b.md'), null);
  assert.equal(normalizePreviewTarget(''), null);
  assert.equal(normalizePreviewTarget('   '), null);
  assert.equal(normalizePreviewTarget(null), null);
  assert.equal(normalizePreviewTarget(42), null);
  assert.equal(normalizePreviewTarget({ path: 'a.md' }), null);
});

// ---- extractToolFilePath：工具名 + args 形状 ----

test('extractToolFilePath：只对文件类工具生效（glob/ls/grep/shell 不给入口）', () => {
  const args = { path: 'src/a.ts' };
  assert.equal(extractToolFilePath('readFile', args), 'src/a.ts');
  assert.equal(extractToolFilePath('write', args), 'src/a.ts');
  assert.equal(extractToolFilePath('edit', args), 'src/a.ts');
  assert.equal(extractToolFilePath('moveFile', { source: 'a.md', destination: 'b.md' }), 'a.md');
  assert.equal(extractToolFilePath('deleteFile', { path: 'a.md' }), 'a.md');
  assert.equal(extractToolFilePath('glob', args), null);
  assert.equal(extractToolFilePath('ls', args), null);
  assert.equal(extractToolFilePath('grep', args), null);
  assert.equal(extractToolFilePath('shell', { command: 'cat src/a.ts' }), null);
  assert.equal(extractToolFilePath('updatePlan', args), null);
});

test('extractToolFilePath：字段优先级 path > file_path > filePath > file', () => {
  assert.equal(extractToolFilePath('read', { file_path: 'a/b.md' }), 'a/b.md');
  assert.equal(extractToolFilePath('read', { filePath: 'a/c.md' }), 'a/c.md');
  assert.equal(extractToolFilePath('read', { file: 'a/d.md' }), 'a/d.md');
  assert.equal(
    extractToolFilePath('read', { file_path: 'fallback.md', path: 'primary.md' }),
    'primary.md',
  );
  // 前面字段非法时继续往后找，而不是直接放弃
  assert.equal(extractToolFilePath('read', { path: '/abs/x.md', file_path: 'rel.md' }), 'rel.md');
});

test('extractToolFilePath：args 是 JSON 字符串也能解析（含被截断的串）', () => {
  assert.equal(
    extractToolFilePath('write', '{"path":"out/result.md","content":"hi"}'),
    'out/result.md',
  );
  assert.equal(extractToolFilePath('read', '  {"file_path": "x/y.txt"}  '), 'x/y.txt');
  // 截断的 JSON：解析失败即放弃，不得瞎猜路径
  assert.equal(extractToolFilePath('write', '{"path":"out/result.md","content":"很长的正文'), null);
});

test('extractToolFilePath：裸字符串参数按路径本身处理', () => {
  assert.equal(extractToolFilePath('readFile', 'src/cli.ts'), 'src/cli.ts');
  assert.equal(extractToolFilePath('readFile', '/etc/passwd'), null);
});

test('extractToolFilePath：args 缺失或形状不对 → null', () => {
  assert.equal(extractToolFilePath('read', null), null);
  assert.equal(extractToolFilePath('read', undefined), null);
  assert.equal(extractToolFilePath('read', 42), null);
  assert.equal(extractToolFilePath('read', {}), null);
  assert.equal(extractToolFilePath('read', { unrelated: 'a.md' }), null);
  assert.equal(extractToolFilePath('read', { path: { nested: true } }), null);
});

// ---- baseName ----

test('baseName：取最后一段（无目录时返回自身）', () => {
  assert.equal(baseName('a/b/c.md'), 'c.md');
  assert.equal(baseName('c.md'), 'c.md');
  assert.equal(baseName('a/b/'), '');
});

console.log(`\nfrontend-tool-file-path 测试完成：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed === 0 ? 0 : 1;
