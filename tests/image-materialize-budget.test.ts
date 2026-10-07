// 套件: 图片物化预算（P0 图片轴）—— 张数+字节双上限、最旧降级、文字占位+只读路径、成批单调
// 用法: npx tsx tests/image-materialize-budget.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage, MessageImage } from '../src/llm/llm.js';
import {
  type InlineImageBudget,
  materializeMessagesForModel,
  resolveInlineImageBudget,
} from '../src/runtime/image-materialize.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-img-budget-'));
const dir = path.join(WS, 'input', 'attachments');
fs.mkdirSync(dir, { recursive: true });

// 往 workspace 写一张 size 字节的图，返回路径引用。
function writeImage(name: string, size: number): MessageImage {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 0x41));
  return { mimeType: 'image/png', path: `input/attachments/${name}`, width: 100, height: 100 };
}

// 一条消息带一张图。
function byImage(images: MessageImage[]): ChatMessage[] {
  return images.map((img) => ({ role: 'user', content: '图', images: [img] }));
}

const DEFAULT = { maxInlineImages: 4, maxInlineImageBytes: 8 * 1024 * 1024 };

// ---- 张数预算 ----

check('4 张以内：全部内联，无占位符', () => {
  const imgs = [0, 1, 2, 3].map((i) => writeImage(`a${i}.png`, 128));
  const view = materializeMessagesForModel(byImage(imgs), WS, true);
  for (const m of view) assert.ok(m.images?.[0]?.data, '每张都应物化');
  assert.ok(!view.some((m) => m.content.includes('图片已省略')), '没有占位符');
});

check('6 张：只内联最新 4 张，最旧 2 张降级为文字 + 只读路径', () => {
  const imgs = [0, 1, 2, 3, 4, 5].map((i) => writeImage(`b${i}.png`, 128));
  const view = materializeMessagesForModel(byImage(imgs), WS, true);
  assert.equal(view[0].images, undefined, '最旧第 0 张降级');
  assert.equal(view[1].images, undefined, '最旧第 1 张降级');
  assert.match(view[0].content ?? '', /图片已省略/);
  assert.match(
    view[0].content ?? '',
    /只读路径 input\/attachments\/b0\.png/,
    '占位符必须带只读路径',
  );
  assert.match(view[0].content ?? '', /100x100/, '占位符带尺寸');
  for (let i = 2; i < 6; i++) assert.ok(view[i].images?.[0]?.data, `第 ${i} 张应内联`);
});

check('成批单调：5 张 → 一次降 2 张（batch=2，不是 1 张）', () => {
  const imgs = [0, 1, 2, 3, 4].map((i) => writeImage(`c${i}.png`, 128));
  const view = materializeMessagesForModel(byImage(imgs), WS, true);
  // max=4，total=5 → omit = ceil((5-4)/2)*2 = 2（成批，不是把第 1 张挤掉）
  assert.equal(view[0].images, undefined);
  assert.equal(view[1].images, undefined);
  for (let i = 2; i < 5; i++) assert.ok(view[i].images?.[0]?.data, `第 ${i} 张应内联`);
});

// ---- 字节预算 ----

check('字节预算：总字节超上限时，最新优先保留、更旧的降级', () => {
  // 3 张各 1_000_000 字节 → 每张 base64 估长 ≈ 1.33MB；预算 2MB → 只能内联最新 1 张
  const imgs = [
    writeImage('big0.png', 1_000_000),
    writeImage('big1.png', 1_000_000),
    writeImage('big2.png', 1_000_000),
  ];
  const budget: InlineImageBudget = { maxInlineImages: 10, maxInlineImageBytes: 2 * 1024 * 1024 };
  const view = materializeMessagesForModel(byImage(imgs), WS, true, budget);
  assert.equal(view[0].images, undefined, '最旧大图降级');
  assert.equal(view[1].images, undefined, '次旧大图也降级（超字节预算）');
  assert.ok(view[2].images?.[0]?.data, '最新的一张仍内联');
});

check('字节预算为 0 语义：正数才计（resolve 不产生 0）', () => {
  // resolveInlineImageBudget 非法/空值回退默认，绝不产生 0/负数
  assert.ok(resolveInlineImageBudget({}).maxInlineImageBytes > 0);
  assert.ok(resolveInlineImageBudget({ PAYASO_MAX_INLINE_IMAGES: 'abc' }).maxInlineImages === 4);
});

// ---- 不变式 ----

check('不修改 transcript 原件（返回新数组 + 新消息）', () => {
  const imgs = [0, 1, 2, 3, 4, 5].map((i) => writeImage(`d${i}.png`, 128));
  const original = byImage(imgs);
  const snapshot = JSON.stringify(original);
  materializeMessagesForModel(original, WS, true, DEFAULT);
  assert.equal(JSON.stringify(original), snapshot, '原件字节不变');
});

check('vision=false：行为不变（剥离全部图 + user 说明）', () => {
  const imgs = [writeImage('e0.png', 128), writeImage('e1.png', 128)];
  const view = materializeMessagesForModel(byImage(imgs), WS, false);
  assert.equal(view[0].images, undefined);
  assert.match(view[0].content ?? '', /当前模型不支持视觉输入/);
});

check('找不到文件的图：降级为「未能载入」，不致命', () => {
  const view = materializeMessagesForModel(
    [
      {
        role: 'user',
        content: '图',
        images: [{ mimeType: 'image/png', path: 'input/attachments/ghost.png' }],
      },
    ],
    WS,
    true,
  );
  assert.equal(view[0].images, undefined);
  assert.match(view[0].content ?? '', /未能载入上下文/);
});

// ---- 无图片（回归：零图片会话曾直接崩） ----
//
// 曾经：total=0 时 omitCount 算成 -1，循环读 slots[-1].rawBytes → TypeError。
// 影响面是所有「视觉模型 + 零图片会话」的第一次调用（实测 run afd5f28a 崩在这里）。

check('零图片 + vision=true：安全返回同一数组引用（不崩）', () => {
  const input: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '纯文本，没有任何图片' },
    { role: 'assistant', content: 'ok' },
  ];
  const view = materializeMessagesForModel(input, WS, true);
  assert.equal(view, input, '应原样返回同一引用');
});

check('零图片 + vision=false：同样安全', () => {
  const input: ChatMessage[] = [{ role: 'user', content: '纯文本' }];
  assert.equal(materializeMessagesForModel(input, WS, false), input);
});

check('零图片 + 空消息列表：安全', () => {
  assert.deepEqual(materializeMessagesForModel([], WS, true), []);
});

// ---- env 解析 ----

check('resolveInlineImageBudget：env 覆盖 + 非法回退默认', () => {
  const b = resolveInlineImageBudget({
    PAYASO_MAX_INLINE_IMAGES: '8',
    PAYASO_MAX_INLINE_IMAGE_BYTES: '1234567',
  });
  assert.equal(b.maxInlineImages, 8);
  assert.equal(b.maxInlineImageBytes, 1234567);
  assert.deepEqual(resolveInlineImageBudget({}), DEFAULT);
});

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n图片物化预算汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log(
  '验收：双上限 / 最旧降级 / 文字占位+只读路径 / 成批单调 / 字节优先保留最新 / 原件不变 / env 可配',
);
