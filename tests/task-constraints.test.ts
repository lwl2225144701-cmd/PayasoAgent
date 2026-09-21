// 来源证据模式验收（quality-hard-boundaries-plan 步骤 3）
// 用法: npx tsx tests/task-constraints.test.ts
// 对抗性验收：错误行号、越界、旧版本、与原文不符的构造，都不能成为"已核验引用"。
// 校验失败必须明确拒绝发布，而不是让模型补写的文本原样展示。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseTaskConstraints,
  prepareTaskConstraints,
  renderEvidence,
} from '../src/host/task-constraints.js';
import type { TaskConstraints } from '../src/task-constraints.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-evidence-'));
const docA = path.join(root, 'doc-a.md');
const docB = path.join(root, 'doc-b.md');
fs.writeFileSync(
  docA,
  ['alpha 第一行', 'alpha 第二行', 'alpha 第三行', 'alpha 第四行'].join('\n'),
  'utf8',
);
fs.writeFileSync(docB, 'beta 唯一行', 'utf8');

interface Case {
  name: string;
  fn: () => void | Promise<void>;
}
const tests: Case[] = [];
let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

function evidence(items: string[], files: string[]): NonNullable<TaskConstraints['evidence']> {
  const prepared = prepareTaskConstraints(root, { evidence: { files, items } });
  assert.ok(prepared?.evidence);
  return prepared.evidence;
}

const shaA = createHash('sha256').update(fs.readFileSync(docA)).digest('hex');

// ---- 1. 约束解析 ----
test('parseTaskConstraints：未知键、重复项、空 evidence 拒绝；evidence 强制只读', () => {
  assert.throws(() => parseTaskConstraints({ writeScope: ['a'], extra: 1 }));
  assert.throws(() => parseTaskConstraints({ writeScope: ['a', 'a'] }));
  assert.throws(() => parseTaskConstraints({ evidence: { files: [], items: ['x'] } }));
  assert.throws(() => parseTaskConstraints({ evidence: { files: ['a'], items: [] } }));
  const parsed = parseTaskConstraints({ evidence: { files: ['a.md'], items: ['问题'] } });
  assert.deepEqual(parsed?.writeScope, [], 'evidence 模式必须只读（writeScope=[]）');
  const scoped = parseTaskConstraints({ writeScope: ['work/a.txt'] });
  assert.deepEqual(scoped?.writeScope, ['work/a.txt']);
  assert.equal(scoped?.evidence, undefined);
});

test('prepareTaskConstraints：固定 sha256；穿越/绝对路径/目录/软链接拒绝', () => {
  const prepared = prepareTaskConstraints(root, {
    evidence: { files: ['doc-a.md'], items: ['q'] },
  });
  assert.equal(prepared?.evidence?.sources[0].sha256, shaA);
  for (const bad of [['../escape.md'], ['/etc/passwd'], ['.'], ['doc-a.md/..']]) {
    assert.throws(
      () => prepareTaskConstraints(root, { evidence: { files: bad, items: ['q'] } }),
      `应拒绝: ${bad.join()}`,
    );
  }
  fs.symlinkSync(docB, path.join(root, 'link.md'));
  assert.throws(() =>
    prepareTaskConstraints(root, { evidence: { files: ['link.md'], items: ['q'] } }),
  );
  assert.throws(() => prepareTaskConstraints(root, { writeScope: ['missing-parent/x.txt'] }));
});

// ---- 2. renderEvidence 正常路径 ----
const ev = evidence(['项目一', '项目二'], ['doc-a.md', 'doc-b.md']);

test('有效 JSON 引用：原文按行号提取渲染，附文件与行号来源', () => {
  const answer = JSON.stringify([
    { item: 0, citations: [{ source: 0, start: 1, end: 2 }] },
    { item: 1, citations: [] },
  ]);
  const out = renderEvidence(root, ev, answer);
  assert.match(out, /alpha 第一行/);
  // 渲染层对文件名做 markdown 转义：doc\-a\.md
  assert.match(out, /doc\\?-a\\?\.md:1–2/);
  assert.match(out, /未找到证据/);
  assert.match(out, /相关性与完整性仍需结合问题判断/);
});

test('fenced JSON（```json 包裹）被接受', () => {
  const out = renderEvidence(
    root,
    ev,
    '```json\n[{"item":0,"citations":[{"source":0,"start":3,"end":4}]},{"item":1,"citations":[]}]\n```',
  );
  assert.match(out, /alpha 第三行/);
});

// ---- 3. 对抗用例：一律拒绝发布 ----
test('非 JSON 答复拒绝发布', () => {
  assert.throws(
    () => renderEvidence(root, ev, '项目一在 doc-a.md 第一行，我确信。'),
    /不是有效 JSON/,
  );
});

test('行号越界（end 超过总行数）拒绝', () => {
  const answer = JSON.stringify([
    { item: 0, citations: [{ source: 0, start: 3, end: 99 }] },
    { item: 1, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, ev, answer), /行号或来源无效/);
});

test('行号倒置（end < start）与非正数行号拒绝', () => {
  for (const c of [
    { source: 0, start: 3, end: 2 },
    { source: 0, start: 0, end: 1 },
  ]) {
    const answer = JSON.stringify([
      { item: 0, citations: [c] },
      { item: 1, citations: [] },
    ]);
    assert.throws(() => renderEvidence(root, ev, answer), /行号或来源无效/);
  }
});

test('超长引用（单段 >40 行、总量 >160 行）拒绝', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n');
  fs.writeFileSync(docA, lines, 'utf8');
  const bigEv = evidence(['q1', 'q2'], ['doc-a.md', 'doc-b.md']);
  const tooLong = JSON.stringify([
    { item: 0, citations: [{ source: 0, start: 1, end: 41 }] },
    { item: 1, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, bigEv, tooLong), /行号或来源无效|上限/);
  const many = JSON.stringify([
    { item: 0, citations: Array.from({ length: 8 }, () => ({ source: 0, start: 1, end: 21 })) },
    { item: 1, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, bigEv, many), /上限/);
  fs.writeFileSync(
    docA,
    ['alpha 第一行', 'alpha 第二行', 'alpha 第三行', 'alpha 第四行'].join('\n'),
    'utf8',
  );
});

test('来源索引无效拒绝；未知字段拒绝；重复与缺失项目拒绝', () => {
  const badSource = JSON.stringify([
    { item: 0, citations: [{ source: 5, start: 1, end: 1 }] },
    { item: 1, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, ev, badSource), /行号或来源无效/);
  const extraField = JSON.stringify([
    { item: 0, citations: [], note: '模型夹带的结论' },
    { item: 1, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, ev, extraField), /无效字段|未授权/);
  const dup = JSON.stringify([
    { item: 0, citations: [] },
    { item: 0, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, ev, dup), /未授权项目|缺少/);
  const missing = JSON.stringify([{ item: 0, citations: [] }]);
  assert.throws(() => renderEvidence(root, ev, missing), /缺少所问项目/);
});

test('来源文件在渲染时已变化（sha 不匹配）拒绝——旧版本不能当已核验引用', () => {
  fs.writeFileSync(docA, 'alpha 第一行\n被篡改的第二行\n', 'utf8');
  const answer = JSON.stringify([
    { item: 0, citations: [{ source: 0, start: 1, end: 1 }] },
    { item: 1, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, ev, answer), /已变化/);
  fs.writeFileSync(
    docA,
    ['alpha 第一行', 'alpha 第二行', 'alpha 第三行', 'alpha 第四行'].join('\n'),
    'utf8',
  );
});

test('来源文件被删除或替换为目录时拒绝', () => {
  const tmpEv = evidence(['q1', 'q2'], ['doc-b.md', 'doc-a.md']);
  fs.rmSync(docB);
  const answer = JSON.stringify([
    { item: 0, citations: [{ source: 0, start: 1, end: 1 }] },
    { item: 1, citations: [] },
  ]);
  assert.throws(() => renderEvidence(root, tmpEv, answer));
  fs.writeFileSync(docB, 'beta 唯一行', 'utf8');
});

// ---- 汇总 ----
async function main(): Promise<void> {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      failures.push(`${t.name} — ${msg}`);
      console.log(`  [FAIL] ${t.name} — ${msg}`);
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('验收：证据模式正常渲染正确；错误行号/越界/旧版本/夹带字段均拒绝发布 ✓');
}

main();
