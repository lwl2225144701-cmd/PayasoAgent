// 模块: 用户消息图片附件的尺寸决策单测 —— 变体分派 + singleFit（长边 240 / 比例夹紧 / 不放大）。
// 用法: npx tsx tests/frontend-message-image.test.ts（纯函数，无浏览器）
//
// 这组值是与 DSH Message Images 对齐的契约，改动即改变真机显示尺寸，必须同步改测试。

import assert from 'node:assert/strict';
import {
  MAX_ASPECT,
  MIN_ASPECT,
  messageImageVariant,
  SINGLE_LONG_EDGE,
  singleBox,
  singleFit,
  squareBox,
  THUMBNAIL_SIZE,
  TILE_SIZE,
} from '../web/src/components/Timeline/message-image';

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- 常量契约 ----

test('尺寸常量与 DSH 对齐：单图长边 240、方格 64、缩略图 48、比例 [0.25, 4]', () => {
  assert.equal(SINGLE_LONG_EDGE, 240);
  assert.equal(TILE_SIZE, 64);
  assert.equal(THUMBNAIL_SIZE, 48);
  assert.equal(MIN_ASPECT, 0.25);
  assert.equal(MAX_ASPECT, 4);
});

// ---- 变体分派（唯一的尺寸决策点）----

test('thumbnail 优先级最高，压过 compact 与多图', () => {
  assert.equal(messageImageVariant({ thumbnail: true, compact: true, count: 9 }), 'thumbnail');
});

test('compact 压过张数：1 张图 + 1 个文档时那张图也是方格', () => {
  assert.equal(messageImageVariant({ compact: true, count: 1 }), 'tile');
});

test('组内多于 1 张（Assistant 正文的连续图片块）自动走方格', () => {
  assert.equal(messageImageVariant({ count: 2 }), 'tile');
});

test('单张、非 compact 才是 single', () => {
  assert.equal(messageImageVariant({ count: 1 }), 'single');
});

test('固定方格尺寸：tile 64、thumbnail 48，均居中不偏移', () => {
  assert.deepEqual(squareBox('tile'), { width: 64, height: 64, objectPosition: 'center' });
  assert.deepEqual(squareBox('thumbnail'), { width: 48, height: 48, objectPosition: 'center' });
});

// ---- singleFit ----

test('小图从不放大：按原始像素显示', () => {
  assert.deepEqual(singleFit(120, 80), { width: 120, height: 80, objectPosition: 'center' });
  assert.deepEqual(singleFit(1, 1), { width: 1, height: 1, objectPosition: 'center' });
});

test('大图按长边 240 收敛，比例保持', () => {
  // 3000x2000 → 比例 1.5 → 240x160
  assert.deepEqual(singleFit(3000, 2000), { width: 240, height: 160, objectPosition: 'center' });
  // 正方形 → 240x240
  assert.deepEqual(singleFit(1000, 1000), { width: 240, height: 240, objectPosition: 'center' });
});

test('竖图在区间内：长边是高度，宽度等比', () => {
  // 900x2400 → 比例 0.375（在 [0.25,4] 内）→ 90x240
  assert.deepEqual(singleFit(900, 2400), { width: 90, height: 240, objectPosition: 'center' });
});

test('极高图比例夹紧到 0.25，并在顶部对齐裁切', () => {
  // 100x2000 → 真实比例 0.05，夹到 0.25 → 框 60x240，锚点 center top
  assert.deepEqual(singleFit(100, 2000), { width: 60, height: 240, objectPosition: 'center top' });
});

test('极宽图比例夹紧到 4，并在左侧对齐裁切', () => {
  // 2000x100 → 真实比例 20，夹到 4 → 框 240x60，锚点 left center
  assert.deepEqual(singleFit(2000, 100), { width: 240, height: 60, objectPosition: 'left center' });
});

test('夹紧只影响框、不影响"不放大"：极小但极扁的图仍不放大', () => {
  // 40x1 → 比例 40 夹到 4 → 框 240x60；scale=min(1, 40/240, 1/60)=0.0167 → 4x1
  const box = singleFit(40, 1);
  assert.equal(box.width, 4);
  assert.equal(box.height, 1);
  assert.equal(box.objectPosition, 'left center');
});

test('宽高缺失/为 0（尚未探测出或解码失败）→ 240x240 兜底', () => {
  const box = singleFit(0, 0);
  assert.deepEqual(box, { width: 240, height: 240, objectPosition: 'center' });
});

test('结果必为整数且每边 ≥1（0 宽/0 高会被浏览器当隐藏）', () => {
  for (const [w, h] of [
    [3, 1000],
    [1000, 3],
    [7, 5],
    [1, 99999],
    [99999, 1],
  ]) {
    const box = singleFit(w, h);
    assert.ok(Number.isInteger(box.width) && Number.isInteger(box.height), `${w}x${h} 非整数`);
    assert.ok(box.width >= 1 && box.height >= 1, `${w}x${h} 出现 0 边`);
  }
});

test('任何输入下长边都不超过 240', () => {
  for (const [w, h] of [
    [10000, 10000],
    [10000, 1],
    [1, 10000],
    [3000, 2000],
    [240, 240],
  ]) {
    const box = singleFit(w, h);
    assert.ok(
      Math.max(box.width, box.height) <= SINGLE_LONG_EDGE,
      `${w}x${h} → ${box.width}x${box.height}`,
    );
  }
});

// ---- singleBox：宽高来源优先级 ----

test('优先用 Host 随附件发布的宽高（图片加载前第一帧就是最终尺寸）', () => {
  assert.deepEqual(singleBox({ width: 3000, height: 2000 }), {
    width: 240,
    height: 160,
    objectPosition: 'center',
  });
});

test('Host 没给宽高时退回 onLoad 探测到的框', () => {
  const measured = { width: 111, height: 77, objectPosition: 'center' };
  assert.deepEqual(singleBox({ measured }), measured);
});

test('两者都没有 → 240x240 兜底', () => {
  assert.deepEqual(singleBox({}), { width: 240, height: 240, objectPosition: 'center' });
  assert.deepEqual(singleBox({ measured: null }), {
    width: 240,
    height: 240,
    objectPosition: 'center',
  });
});

test('Host 宽高优先于探测值（哪怕探测值不同）', () => {
  const box = singleBox({
    width: 900,
    height: 2400,
    measured: { width: 1, height: 1, objectPosition: 'center' },
  });
  assert.deepEqual(box, { width: 90, height: 240, objectPosition: 'center' });
});

test('宽高只给了一半视为没给：退回探测/兜底', () => {
  assert.deepEqual(singleBox({ width: 3000 }), {
    width: 240,
    height: 240,
    objectPosition: 'center',
  });
  assert.deepEqual(singleBox({ height: 2000 }), {
    width: 240,
    height: 240,
    objectPosition: 'center',
  });
});

// ---- 执行 ----

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\nfrontend-message-image 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
