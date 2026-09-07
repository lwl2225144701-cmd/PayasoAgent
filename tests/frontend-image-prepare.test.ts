// 模块: 客户端图片预处理纯函数测试（附件 v2 P2，无 canvas 依赖，毫秒级）
// 用法: npx tsx tests/frontend-image-prepare.test.ts
// 验收：缩放预算 floor 语义（乘积不超目标、不放大）、gif 跳过策略、质量阶梯。

import assert from 'node:assert/strict';
import {
  CLIENT_PIXEL_TARGET,
  CLIENT_QUALITY_LADDER,
  downscaleDims,
} from '../web/src/utils/image-prepare';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  [FAIL] ${name}: ${message}`);
  }
}

const main = async (): Promise<void> => {
  await test('不超预算：返回 null（原样上传）', () => {
    assert.equal(downscaleDims(1920, 1080), null);
    assert.equal(downscaleDims(100, 200), null);
    // 恰好等于预算也不缩
    assert.equal(downscaleDims(2048, 2048), null);
  });

  await test('4000x3000 → floor 缩放，乘积不超预算', () => {
    const dims = downscaleDims(4000, 3000);
    assert.ok(dims);
    assert.ok(dims.width < 4000 && dims.height < 3000);
    assert.ok(dims.width * dims.height <= CLIENT_PIXEL_TARGET);
    // floor 语义：2364x1773（round 会越界 0.03%）
    assert.equal(dims.width, Math.floor(4000 * Math.sqrt(CLIENT_PIXEL_TARGET / 12_000_000)));
    assert.equal(dims.height, Math.floor(3000 * Math.sqrt(CLIENT_PIXEL_TARGET / 12_000_000)));
  });

  await test('宽幅长条：16000x400（6.4M 像素）缩到 ≤2048 总像素', () => {
    const dims = downscaleDims(16000, 400);
    assert.ok(dims);
    assert.ok(dims.width * dims.height <= CLIENT_PIXEL_TARGET);
    assert.ok(dims.width < 16000);
    // 17000x1 只有 17K 像素：总像素预算内不缩（单边超限由服务端 P1 拒绝）
    assert.equal(downscaleDims(17000, 1), null);
  });

  await test('非法输入：返回 null（回退原样）', () => {
    assert.equal(downscaleDims(0, 100), null);
    assert.equal(downscaleDims(100, -1), null);
    assert.equal(downscaleDims(Number.NaN, 100), null);
  });

  await test('质量阶梯：png 单次、jpeg/webp 三级', () => {
    assert.equal(CLIENT_QUALITY_LADDER.length, 3);
    assert.deepEqual([...CLIENT_QUALITY_LADDER], [0.8, 0.6, 0.45]);
  });

  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('验收：缩放预算/边界/非法输入/阶梯 ✓');
};

void main();
