#!/usr/bin/env node
// 生成 context compaction 测试用的大文本文件。
// 每个文件 >20KB、300+ 行、行内容不重复（确定性伪随机，可复现）。
//
// 用法:
//   node scripts/gen-compaction-fixtures.mjs <目标目录> [文件数=6] [每文件KB=25]
//
// 目标目录怎么选:
//   - 如果你在 UI 里选过工作区文件夹 → 就指向那个文件夹
//   - 否则指向当前 run 的沙箱目录: sandbox/workspaces/<runId>
//     （runId 就是该目录下最新创建的那个子目录名）
//
// 注意: readFile 的结果进 LLM 上下文前会被 output-guard 截断到 ~10KB，
// 所以文件只要明显超过 16KB 即可，更大也不会灌进更多 token。

import fs from 'node:fs';
import path from 'node:path';

const SUBJECTS = [
  'the harbor',
  'a quiet library',
  'the night train',
  'an old lighthouse',
  'the market square',
  'a forgotten archive',
  'the river delta',
  'an empty stadium',
  'the mountain pass',
  'a small observatory',
  'the ferry terminal',
  'an abandoned mill',
];
const VERBS = [
  'reveals',
  'hides',
  'echoes',
  'collects',
  'guards',
  'reflects',
  'remembers',
  'measures',
  'outlines',
  'preserves',
  'traces',
  'records',
];
const OBJECTS = [
  'a pattern of tides',
  'the weight of silence',
  'a ledger of departures',
  'the geometry of shadows',
  'a catalog of storms',
  'the rhythm of signals',
  'a map of shortcuts',
  'the temperature of rumors',
  'a sequence of lanterns',
  'the grammar of footprints',
  'an index of delays',
  'the color of distance',
];
const CLAUSES = [
  'while the wind keeps its own schedule',
  'before the first lamp is switched on',
  'after the last page has been turned',
  'as the fog settles over the rooftops',
  'until the bell tower counts to twelve',
  'beneath a sky full of slow clouds',
  'between two tides of the same name',
  'without asking anyone for permission',
];

// mulberry32：确定性伪随机，同样参数生成同样内容
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSentence(rand, lineNo) {
  const s = SUBJECTS[Math.floor(rand() * SUBJECTS.length)];
  const v = VERBS[Math.floor(rand() * VERBS.length)];
  const o = OBJECTS[Math.floor(rand() * OBJECTS.length)];
  const c = CLAUSES[Math.floor(rand() * CLAUSES.length)];
  return `Line ${lineNo}: ${s} ${v} ${o}, ${c}.`;
}

function generateFile(fileIndex, targetKB) {
  const rand = mulberry32(0xc0ffee + fileIndex * 7919);
  const targetBytes = targetKB * 1024;
  const lines = [];
  let bytes = 0;
  let lineNo = 1;
  // 双下限：行数 >= 300 且字节数 >= 目标值
  while (lines.length < 300 || bytes < targetBytes) {
    const line = makeSentence(rand, lineNo++);
    lines.push(line);
    bytes += Buffer.byteLength(`${line}\n`, 'utf8');
  }
  return `${lines.join('\n')}\n`;
}

function estimateTokens(text) {
  // 与后端 estimateTextTokens 一致：ASCII/3 向上取整（此处全 ASCII）
  return Math.ceil(text.length / 3);
}

const [, , targetDir, countArg, kbArg] = process.argv;
if (!targetDir) {
  console.error(
    '用法: node scripts/gen-compaction-fixtures.mjs <目标目录> [文件数=6] [每文件KB=25]',
  );
  process.exit(1);
}
const count = Number(countArg ?? 6);
const targetKB = Number(kbArg ?? 25);
if (!Number.isInteger(count) || count < 1 || !Number.isFinite(targetKB) || targetKB < 20) {
  console.error('参数非法：文件数须为正整数，每文件 KB 须 >= 20');
  process.exit(1);
}

const dir = path.resolve(targetDir);
fs.mkdirSync(dir, { recursive: true });

let totalBytes = 0;
let totalTokens = 0;
for (let i = 1; i <= count; i++) {
  const content = generateFile(i, targetKB);
  const file = path.join(dir, `big${i}.txt`);
  fs.writeFileSync(file, content, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n').length - 1;
  totalBytes += bytes;
  totalTokens += estimateTokens(content);
  console.log(
    `  ${path.basename(file)}  ${(bytes / 1024).toFixed(1)} KB  ${lines} 行  ~${estimateTokens(content)} tokens(原始)`,
  );
}

console.log('');
console.log(`完成：${count} 个文件 → ${dir}`);
console.log(`合计 ${(totalBytes / 1024).toFixed(1)} KB，原始 ~${totalTokens} tokens`);
console.log('提示：每个 readFile 结果进上下文前会被截断到 ~10KB（约 3.4k tokens），');
console.log(`所以实际灌入约 ${count} × 3.4k ≈ ${(count * 3.4).toFixed(0)}k tokens。`);
