// 套件: Workspace Instructions — 项目指令发现链 + skills 目录兼容
// 用法: npx tsx tests/workspace-instructions.test.ts
// 回归目标（v1.9）：只认 PAYASO.md 时，使用 AGENTS.md/CLAUDE.md 约定的仓库
// 完全拿不到项目规则（pi 仓库的 11.9KB AGENTS.md 就是实例）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadProjectInstructionFiles,
  readProjectInstructions,
  resolveSkillRelativePath,
  scanWorkspaceSkills,
} from '../src/host/workspace-instructions.js';

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

function makeWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-instructions-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function skill(name: string, description: string, body = '# skill'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

// ---- 1. 项目指令发现链 ----

await test('AGENTS.md 被识别（旧实现只认 PAYASO.md）', () => {
  const root = makeWorkspace({ 'AGENTS.md': '# Rules\n- run tests before commit\n' });
  const instructions = readProjectInstructions(root, 'workspace-write');
  assert.ok(instructions.includes('run tests before commit'), instructions);
});

await test('CLAUDE.md 被识别', () => {
  const root = makeWorkspace({ 'CLAUDE.md': '# Claude rules\n- use pnpm\n' });
  assert.ok(readProjectInstructions(root, 'workspace-write').includes('use pnpm'));
});

await test('多文件按优先级合并，并标注来源', () => {
  const root = makeWorkspace({
    'PAYASO.md': 'PAYASO-RULE',
    'AGENTS.md': 'AGENTS-RULE',
    'CLAUDE.md': 'CLAUDE-RULE',
  });
  const instructions = readProjectInstructions(root, 'workspace-write');
  assert.ok(instructions.includes('## PAYASO.md'));
  assert.ok(instructions.includes('## AGENTS.md'));
  assert.ok(instructions.includes('## CLAUDE.md'));
  assert.ok(
    instructions.indexOf('PAYASO-RULE') < instructions.indexOf('AGENTS-RULE'),
    'PAYASO.md 优先级最高',
  );
  assert.ok(instructions.indexOf('AGENTS-RULE') < instructions.indexOf('CLAUDE-RULE'));
});

await test('单文件不加多余标题（保持原样注入）', () => {
  const root = makeWorkspace({ 'AGENTS.md': 'only-rule\n' });
  assert.equal(readProjectInstructions(root, 'workspace-write'), 'only-rule');
});

await test('软链重复文件只注入一次（realpath 去重）', () => {
  const root = makeWorkspace({ 'AGENTS.md': 'DEDUP-RULE\n' });
  try {
    fs.symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md'));
  } catch {
    return; // 平台不支持 symlink
  }
  const files = loadProjectInstructionFiles(root, 'workspace-write');
  assert.equal(files.length, 1, `应只加载一次: ${JSON.stringify(files.map((f) => f.source))}`);
  assert.equal(files[0].source, 'AGENTS.md');
});

await test('read-only 模式不加载任何项目指令', () => {
  const root = makeWorkspace({ 'AGENTS.md': 'RULE\n' });
  assert.equal(readProjectInstructions(root, 'read-only'), '');
  assert.deepEqual(loadProjectInstructionFiles(root, 'read-only'), []);
});

await test('超大指令文件（>32KB）被跳过，不影响其他文件', () => {
  const root = makeWorkspace({
    'PAYASO.md': 'x'.repeat(33 * 1024),
    'AGENTS.md': 'KEPT-RULE\n',
  });
  const instructions = readProjectInstructions(root, 'workspace-write');
  assert.ok(instructions.includes('KEPT-RULE'));
  assert.ok(!instructions.includes('x'.repeat(100)));
});

await test('无任何指令文件 → 空串（不注入空段）', () => {
  const root = makeWorkspace({ 'README.md': '# hi\n' });
  assert.equal(readProjectInstructions(root, 'workspace-write'), '');
});

// ---- 2. skills 目录兼容 ----

await test('scanWorkspaceSkills 识别 .payaso / .claude / .pi', () => {
  const root = makeWorkspace({
    '.payaso/skills/alpha/SKILL.md': skill('alpha', 'payaso skill'),
    '.claude/skills/beta/SKILL.md': skill('beta', 'claude skill'),
    '.pi/skills/gamma/SKILL.md': skill('gamma', 'pi skill'),
  });
  const skills = scanWorkspaceSkills(root, 'workspace-write');
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['alpha', 'beta', 'gamma']);
  assert.equal(skills.find((s) => s.name === 'beta')?.description, 'claude skill');
});

await test('同名 skill 以更高优先级目录为准（.payaso > .claude > .pi）', () => {
  const root = makeWorkspace({
    '.payaso/skills/dup/SKILL.md': skill('dup', 'from payaso'),
    '.claude/skills/dup/SKILL.md': skill('dup', 'from claude'),
  });
  const skills = scanWorkspaceSkills(root, 'workspace-write');
  const dup = skills.filter((s) => s.name === 'dup');
  assert.equal(dup.length, 1, '同名只保留一份');
  assert.equal(dup[0].description, 'from payaso');
  assert.equal(dup[0].sourceDir, '.payaso/skills');
});

await test('非法目录名与非 SKILL.md 被忽略', () => {
  const root = makeWorkspace({
    '.payaso/skills/Bad_Name/SKILL.md': skill('bad', 'should be ignored'),
    '.payaso/skills/no-skill/README.md': '# not a skill',
  });
  assert.deepEqual(scanWorkspaceSkills(root, 'workspace-write'), []);
});

await test('read-only 模式不扫描 skills', () => {
  const root = makeWorkspace({ '.payaso/skills/alpha/SKILL.md': skill('alpha', 'x') });
  assert.deepEqual(scanWorkspaceSkills(root, 'read-only'), []);
});

await test('resolveSkillRelativePath 按目录优先级解析', () => {
  const root = makeWorkspace({
    '.claude/skills/only-claude/SKILL.md': skill('only-claude', 'x'),
    '.payaso/skills/both/SKILL.md': skill('both', 'x'),
    '.claude/skills/both/SKILL.md': skill('both', 'x'),
  });
  assert.equal(
    resolveSkillRelativePath(root, 'both'),
    '.payaso/skills/both/SKILL.md',
    '优先 .payaso',
  );
  assert.equal(
    resolveSkillRelativePath(root, 'only-claude'),
    '.claude/skills/only-claude/SKILL.md',
  );
  assert.equal(resolveSkillRelativePath(root, 'missing'), null);
});

await test('resolveSkillRelativePath 拒绝非法名称（路径逃逸防护）', () => {
  const root = makeWorkspace({ '.payaso/skills/alpha/SKILL.md': skill('alpha', 'x') });
  for (const bad of ['../alpha', 'Alpha', 'a/b', '', 'a'.repeat(65)]) {
    assert.equal(resolveSkillRelativePath(root, bad), null, `应拒绝: ${bad}`);
  }
});

console.log(`\nworkspace-instructions 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
