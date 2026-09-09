// 套件: Workspace Scan & Glob — 共用 walker / ignore 策略 / glob 编译器 / glob 工具
// 用法: npx tsx tests/workspace-scan.test.ts
// 覆盖：
//   1. glob 编译器：*、?、**、**/、{a,b}、正则元字符转义、非法模式报错
//   2. walker：默认忽略依赖/产物目录、includeIgnored、不跟随 symlink、确定性排序、上限
//   3. glob 工具集成：按模式查找、mtime 排序、ignore 开关、上限提示

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileGlob, matchesGlob } from '../src/tools/glob-pattern.js';
import { normalizeToolResult, type ToolContext } from '../src/tools/tools.js';
import { execute as executeRaw } from '../src/tools/tools.js';
import '../src/tools/runtime-tools.js';
import { createWorkspace } from '../src/sandbox/sandbox-manager.js';
import { DEFAULT_IGNORED_DIRS, scanWorkspaceFiles } from '../src/tools/workspace-scan.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-workspace-scan-'));
process.env.SANDBOX_ROOT = TEST_ROOT;
const RUN = 'workspace-scan-test';
const root = createWorkspace(RUN);
const ctx: ToolContext = { runId: RUN, workspaceRoot: root };

async function execute(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  return normalizeToolResult(await executeRaw(name, args, context)).text;
}

function write(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

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

// ---- 1. glob 编译器 ----

await test('glob: * 只匹配单层', () => {
  assert.equal(matchesGlob('*.ts', 'a.ts'), true);
  assert.equal(matchesGlob('*.ts', 'src/a.ts'), false);
});

await test('glob: **/ 匹配零层或多层目录', () => {
  assert.equal(matchesGlob('**/*.ts', 'a.ts'), true);
  assert.equal(matchesGlob('**/*.ts', 'src/a.ts'), true);
  assert.equal(matchesGlob('**/*.ts', 'src/x/y/a.ts'), true);
  assert.equal(matchesGlob('**/*.ts', 'a.js'), false);
});

await test('glob: 尾随 ** 匹配任意后代', () => {
  assert.equal(matchesGlob('src/**', 'src/a.ts'), true);
  assert.equal(matchesGlob('src/**', 'src/x/y/a.ts'), true);
  assert.equal(matchesGlob('src/**', 'other/a.ts'), false);
});

await test('glob: ? 匹配单个字符，{a,b} 匹配候选', () => {
  assert.equal(matchesGlob('a?c.ts', 'abc.ts'), true);
  assert.equal(matchesGlob('a?c.ts', 'ac.ts'), false);
  assert.equal(matchesGlob('**/*.{json,md}', 'docs/readme.md'), true);
  assert.equal(matchesGlob('**/*.{json,md}', 'docs/readme.txt'), false);
});

await test('glob: 正则元字符按字面量匹配（不会退化成正则）', () => {
  assert.equal(matchesGlob('a.b.ts', 'a.b.ts'), true);
  assert.equal(matchesGlob('a.b.ts', 'axb.ts'), false, '. 必须是字面量');
  assert.equal(matchesGlob('a+b.ts', 'a+b.ts'), true);
  assert.equal(matchesGlob('a+b.ts', 'aab.ts'), false);
});

await test('glob: 非法模式抛错（未闭合的 { 组）', () => {
  assert.throws(() => compileGlob('src/{a,b.ts'), /unterminated/);
});

// ---- 2. walker ----

write('src/index.ts', 'export const a = 1;\n');
write('src/nested/deep.ts', 'export const b = 2;\n');
write('docs/guide.md', '# guide\n');
write('node_modules/pkg/index.js', 'module.exports = 1;\n');
write('dist/bundle.js', 'bundle\n');
write('.git/config', '[core]\n');

await test('walker: 默认忽略 node_modules / dist / .git', () => {
  const { files, ignoredDirs } = scanWorkspaceFiles({ root });
  const rels = files.map((file) => file.relPath);
  assert.ok(rels.includes('src/index.ts'), `缺少 src/index.ts: ${rels}`);
  assert.ok(rels.includes('docs/guide.md'));
  assert.ok(!rels.some((rel) => rel.startsWith('node_modules/')), '不应包含 node_modules');
  assert.ok(!rels.some((rel) => rel.startsWith('dist/')), '不应包含 dist');
  assert.ok(!rels.some((rel) => rel.startsWith('.git/')), '不应包含 .git');
  assert.ok(ignoredDirs >= 3, `ignoredDirs=${ignoredDirs}`);
});

await test('walker: ignore=false 时包含被忽略目录', () => {
  const { files } = scanWorkspaceFiles({ root, ignore: false });
  const rels = files.map((file) => file.relPath);
  assert.ok(rels.some((rel) => rel.startsWith('node_modules/')));
  assert.ok(rels.some((rel) => rel.startsWith('.git/')));
});

await test('walker: 结果按相对路径确定性排序', () => {
  const { files } = scanWorkspaceFiles({ root });
  const rels = files.map((file) => file.relPath);
  assert.deepEqual(rels, [...rels].sort(), `顺序不确定: ${rels}`);
});

await test('walker: 不跟随 symlink（逃逸防护）', () => {
  const link = path.join(root, 'work', 'link-out');
  try {
    fs.symlinkSync(os.tmpdir(), link);
  } catch {
    return; // 平台不支持 symlink：跳过
  }
  const { files } = scanWorkspaceFiles({ root, baseDir: path.join(root, 'work') });
  assert.ok(!files.some((file) => file.relPath.includes('link-out')), '不应跟随 symlink');
});

await test('walker: 单文件起点返回该文件', () => {
  const { files } = scanWorkspaceFiles({
    root,
    baseDir: path.join(root, 'src', 'index.ts'),
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].relPath, 'src/index.ts');
});

await test('walker: maxFiles 触发 truncated 标记', () => {
  const { files, truncated } = scanWorkspaceFiles({ root, maxFiles: 1 });
  assert.equal(files.length, 1);
  assert.equal(truncated, true);
});

await test('ignore 策略至少覆盖常见依赖与产物目录', () => {
  for (const dir of ['node_modules', '.git', 'dist', 'build', 'coverage', '.next']) {
    assert.ok(DEFAULT_IGNORED_DIRS.has(dir), `缺少忽略规则: ${dir}`);
  }
});

// ---- 3. glob 工具集成 ----

await test('glob 工具：按模式查找并按 mtime 倒序返回', async () => {
  const oldFile = write('work/old.ts', 'old\n');
  const newFile = write('work/new.ts', 'new\n');
  const past = Date.now() - 60_000;
  fs.utimesSync(oldFile, past / 1000, past / 1000);
  fs.utimesSync(newFile, Date.now() / 1000, Date.now() / 1000);

  const res = await execute('glob', { pattern: 'work/*.ts' }, ctx);
  const lines = res.split('\n').filter((line) => line.includes('work/'));
  assert.equal(lines.length, 2, `应找到 2 个文件: ${res}`);
  assert.ok(lines[0].startsWith('work/new.ts'), `最近的应排前: ${res}`);
  assert.ok(lines[1].startsWith('work/old.ts'), `较旧的后: ${res}`);
});

await test('glob 工具：默认忽略 node_modules，includeIgnored=true 可包含', async () => {
  const hidden = await execute('glob', { pattern: '**/index.js' }, ctx);
  assert.ok(!hidden.includes('node_modules/'), `默认应忽略: ${hidden}`);
  const included = await execute('glob', { pattern: '**/index.js', includeIgnored: true }, ctx);
  assert.ok(included.includes('node_modules/pkg/index.js'), `includeIgnored 应包含: ${included}`);
});

await test('glob 工具：无匹配时给出明确说明（不是空字符串）', async () => {
  const res = await execute('glob', { pattern: '**/*.nope' }, ctx);
  assert.ok(res.includes('未找到匹配'), `结果: ${res}`);
});

await test('glob 工具：maxResults 上限与提示', async () => {
  for (let i = 0; i < 5; i++) write(`work/many-${i}.md`, `# ${i}\n`);
  const res = await execute('glob', { pattern: 'work/many-*.md', maxResults: 2 }, ctx);
  const lines = res.split('\n').filter((line) => line.startsWith('work/many-'));
  assert.equal(lines.length, 2, `应只返回 2 个: ${res}`);
  assert.ok(res.includes('maxResults=2'), `应提示上限: ${res}`);
});

await test('glob 工具：非法模式抛错且不执行扫描', async () => {
  await assert.rejects(() => execute('glob', { pattern: 'work/{a,b.md' }, ctx), /不是合法的 glob/);
});

await test('glob 工具：拒绝 workspace 外路径', async () => {
  await assert.rejects(() => execute('glob', { pattern: '*', path: '../..' }, ctx), /路径被拒绝/);
});

console.log(`\nworkspace-scan 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
