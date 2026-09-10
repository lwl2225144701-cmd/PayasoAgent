// 套件: 前端 i18n 覆盖 — 消息表完整性与"用户可见中文不得残留"扫描
// 用法: node --import tsx tests/frontend-i18n-coverage.test.ts
//
// 这是"全套英文切换"的验收闸门：只要 web/src 里还有写死中文的用户可见文案，
// 这个套件就红（注释不算——按仓库约定注释保留中文）。
// 豁免仅两处，且必须写明理由：i18n/ 目录本身，以及带 `i18n-exempt:` 标记的行
// （语言自称「中文」、`/permission 只读` 这类用户输入别名）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MESSAGES } from '../web/src/i18n/messages/index.js';
import { translate, translator } from '../web/src/i18n/translate.js';
import { listWebSources, scanSource, scanUserVisibleCjk } from './helpers/i18n-scan.js';

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

// ---- 1. 消息表完整性 ----
check('每条消息都有 zh-CN 与 en-US 且非空', () => {
  const keys = Object.keys(MESSAGES);
  assert.ok(keys.length > 0, 'message table must not be empty');
  const broken: string[] = [];
  for (const key of keys) {
    const entry = (MESSAGES as Record<string, Record<string, string>>)[key];
    for (const language of ['zh-CN', 'en-US']) {
      const value = entry?.[language];
      if (typeof value !== 'string' || value.trim() === '') broken.push(`${key}[${language}]`);
    }
  }
  assert.deepEqual(broken, [], `missing translations: ${broken.join(', ')}`);
});

check('英文条目不含 CJK（漏翻译的常见伪装：中英混排时直接抄了中文）', () => {
  const cjk = /[\u4e00-\u9fff]/;
  const suspicious: string[] = [];
  for (const [key, entry] of Object.entries(MESSAGES as Record<string, Record<string, string>>)) {
    if (cjk.test(entry['en-US'])) suspicious.push(key);
  }
  // 严格：消息表的英文侧不得出现任何中文。语言自称「中文」这类例外不走表
  // （GeneralSettings 里保留字面量 + i18n-exempt 注释），所以这里不必开白名单。
  assert.deepEqual(suspicious, [], `en-US entries containing CJK: ${suspicious.join(', ')}`);
});

check('中英占位符集合一致（否则英文界面会渲染出 {x} 字面量）', () => {
  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
  const mismatched: string[] = [];
  for (const [key, entry] of Object.entries(MESSAGES as Record<string, Record<string, string>>)) {
    const zh = placeholders(entry['zh-CN']);
    const en = placeholders(entry['en-US']);
    if (zh.join(',') !== en.join(',')) {
      mismatched.push(`${key}: zh=[${zh.join(',')}] en=[${en.join(',')}]`);
    }
  }
  assert.deepEqual(mismatched, [], `placeholder mismatch:\n${mismatched.join('\n')}`);
});

check('各领域消息表之间没有重复 key', () => {
  const dir = path.resolve('web/src/i18n/messages');
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!/\.ts$/.test(file) || file === 'types.ts' || file === 'index.ts') continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/^\s*'([a-zA-Z0-9_.]+)':\s*\{/gm)) {
      const key = match[1] as string;
      const previous = seen.get(key);
      if (previous) duplicates.push(`${key} (${previous} / ${file})`);
      else seen.set(key, file);
    }
  }
  assert.deepEqual(duplicates, [], `duplicate keys: ${duplicates.join(', ')}`);
  assert.equal(seen.size, Object.keys(MESSAGES).length, 'aggregated MESSAGES is out of sync');
});

// ---- 2. translate 行为 ----
check('插值替换同名占位符，未知占位符保持原样', () => {
  assert.equal(translate('zh-CN', 'common.time.minutes', { count: 5 }), '5分钟');
  assert.equal(translate('en-US', 'common.time.minutes', { count: 5 }), '5m');
  assert.equal(translate('en-US', 'common.time.minutes'), '{count}m');
  assert.equal(translate('en-US', 'common.time.minutes', { other: 1 }), '{count}m');
});

check('translator 绑定语言', () => {
  assert.equal(translator('zh-CN')('common.cancel'), '取消');
  assert.equal(translator('en-US')('common.cancel'), 'Cancel');
});

// ---- 3. 用户可见中文扫描（验收闸门）----
check('web/src 内用户可见位置不残留中文（i18n 目录与 exempt 行除外）', () => {
  const hits = scanUserVisibleCjk(listWebSources());
  const detail = hits
    .slice(0, 40)
    .map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`)
    .join('\n');
  const more = hits.length > 40 ? `\n  … 另有 ${hits.length - 40} 处` : '';
  assert.equal(hits.length, 0, `仍有 ${hits.length} 处写死中文：\n${detail}${more}`);
});

// ---- 4. 扫描器自身的可靠性（避免"扫描器失效=假绿"）----
check('扫描器：注释不算违规，字符串/模板/JSX 文本算', () => {
  const source = [
    '// 行注释中文不算违规',
    '/* 块注释中文也不算违规 */',
    "const url = 'https://example.com/中文路径';",
    'const tpl = `模板 ${x} 中文`;',
    'const s = "普通字符串中文";',
    'const el = <div title="属性中文">JSX 文本中文</div>;',
  ].join('\n');
  const hits = scanSource('sample.tsx', source);
  // 同一行可能有多个命中（模板首尾两段、JSX 属性 + JSX 文本），按行去重后比对
  const hitLines = [...new Set(hits.map((hit) => hit.line))];
  assert.deepEqual(hitLines, [3, 4, 5, 6], `unexpected hits: ${JSON.stringify(hits, null, 2)}`);
  assert.ok(hits.length >= 4, '注释不得被计入');
});

check('扫描器：正则字面量里的引号不会让判定跑偏（曾用状态机时的假阳性）', () => {
  const source = [
    'const re = /["\']/g;',
    '// 这行是注释里的中文，必须被忽略',
    "export const label = '标签中文';",
  ].join('\n');
  const hits = scanSource('sample.ts', source);
  assert.deepEqual(
    hits.map((hit) => hit.line),
    [3],
    '正则里的引号不得把后续注释误判成代码',
  );
});

check('扫描器：i18n-exempt 标记可豁免（含上一行）', () => {
  const dir = path.resolve('.payaso/tmp-i18n-scan');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sample.ts');
  fs.writeFileSync(
    file,
    [
      '// i18n-exempt: 语言自称',
      "export const a = '中文';",
      "export const b = '未豁免中文';",
      "export const c = '同行豁免中文'; // i18n-exempt: 用户输入别名",
    ].join('\n'),
  );
  try {
    const hits = scanUserVisibleCjk([file]);
    assert.equal(hits.length, 1, `expected 1 hit, got ${JSON.stringify(hits)}`);
    assert.ok(hits[0]?.text.includes('未豁免中文'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('扫描器：跳过 i18n 目录（消息表本体就是中文）', () => {
  assert.deepEqual(scanUserVisibleCjk(['web/src/i18n/messages/app.ts']), []);
});

console.log(`\n前端 i18n 覆盖汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：消息表双语完整 / 无重复 key / 插值正确 / web 无残留中文 / 扫描器自身有效 ✓');
