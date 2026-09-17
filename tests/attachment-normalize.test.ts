// 模块: 附件归一化测试（attachment-normalize P1 期；sharp 出夹具，秒级完成）
// 用法: npx tsx tests/attachment-normalize.test.ts
// 验收：魔数 sniff 准确、MIME 与字节一致性强制、EXIF 方向应用、超预算下采样、
//       动图透传、png 透明度保留、sharp 缺失降级、尺寸超限拒绝。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { CreateRunAttachmentInput } from '../src/host/run-manager.js';
import {
  NORMALIZE_PIXEL_TARGET,
  type PreparedAttachment,
  prepareAttachments,
  sniffImageMime,
} from '../src/host/attachments/normalize.js';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-att-norm-'));

function item(name: string, mimeType: string, bytes: Buffer): CreateRunAttachmentInput {
  return { name, mimeType, dataBase64: bytes.toString('base64') };
}

async function jpegFixture(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 200 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// sharp 0.35 的 withExif 写不进 Orientation tag（0x0112 缺失，读回恒为 1），
// 这里手工构造标准 EXIF APP1 段（MM 字节序，IFD0 单条目 Orientation=6 right-top），
// 插到 JPEG 的 APP0 之后，得到真实携带方向的夹具。
async function jpegWithOrientation(width: number, height: number): Promise<Buffer> {
  const base = await jpegFixture(width, height);
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 偏移
  tiff.writeUInt16BE(1, 8); // IFD 条目数
  tiff.writeUInt16BE(0x0112, 10); // Orientation tag
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count
  tiff.writeUInt16BE(6, 18); // value = 6（right-top，横躺）
  tiff.writeUInt16BE(0, 20); // 值字段填充
  tiff.writeUInt32BE(0, 22); // next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4 + payload.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  const app0Length = base.readUInt16BE(4);
  const insertAt = 2 + 2 + app0Length;
  return Buffer.concat([base.subarray(0, insertAt), app1, base.subarray(insertAt)]);
}

const main = async (): Promise<void> => {
  // ---- sniffImageMime（无 sharp 依赖）----
  await test('sniff：jpeg/png/gif/webp/bmp 魔数准确，垃圾字节为 null', () => {
    assert.equal(
      sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])),
      'image/jpeg',
    );
    assert.equal(
      sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
      'image/png',
    );
    assert.equal(sniffImageMime(Buffer.from(`GIF89a${'x'.repeat(6)}`, 'latin1')), 'image/gif');
    assert.equal(sniffImageMime(Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1')), 'image/webp');
    assert.equal(
      sniffImageMime(Buffer.from('BM\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1')),
      'image/bmp',
    );
    assert.equal(sniffImageMime(Buffer.alloc(12, 7)), null);
  });

  await test('MIME 与字节不符：png 字节声明 jpeg → 拒绝', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'green' } })
      .png()
      .toBuffer();
    await assert.rejects(
      () => prepareAttachments([item('m.png', 'image/jpeg', png)], sharp),
      /声明类型与实际/,
    );
  });

  await test('垃圾字节：魔数都不对 → 拒绝', async () => {
    await assert.rejects(
      () => prepareAttachments([item('x.jpg', 'image/jpeg', Buffer.alloc(64, 3))], sharp),
      /不是可识别的图片字节/,
    );
  });

  await test('EXIF 方向应用：200x100 + Orientation 6 → 输出 100x200', async () => {
    const bytes = await jpegWithOrientation(200, 100);
    const fixtureOrientation = (await sharp(bytes).metadata()).orientation;
    assert.equal(fixtureOrientation, 6, '夹具必须真实携带 Orientation=6');
    const [prepared] = (await prepareAttachments(
      [item('rot.jpg', 'image/jpeg', bytes)],
      sharp,
    )) as PreparedAttachment[];
    assert.equal(prepared.width, 100);
    assert.equal(prepared.height, 200);
    const outMeta = await sharp(Buffer.from(prepared.dataBase64, 'base64')).metadata();
    assert.equal(outMeta.format, 'jpeg');
    assert.equal(outMeta.orientation, undefined, '方向已应用并剥离');
  });

  await test('超预算下采样：4000x3000（12M 像素）→ ≤2048²，记录 originalDimensions', async () => {
    const bytes = await jpegFixture(4000, 3000);
    const [prepared] = (await prepareAttachments(
      [item('big.jpg', 'image/jpeg', bytes)],
      sharp,
    )) as PreparedAttachment[];
    const outPixels = (prepared.width ?? 0) * (prepared.height ?? 0);
    assert.ok(outPixels > 0 && outPixels <= NORMALIZE_PIXEL_TARGET);
    assert.equal(prepared.originalDimensions, '4000x3000');
    const outMeta = await sharp(Buffer.from(prepared.dataBase64, 'base64')).metadata();
    assert.equal(outMeta.format, 'jpeg');
    // 设计目标是总像素 ≤2048²（保纵横比），不是每边 ≤2048
    const metaPixels = (outMeta.width ?? 0) * (outMeta.height ?? 0);
    assert.ok(metaPixels > 0 && metaPixels <= NORMALIZE_PIXEL_TARGET);
  });

  await test('解码失败：PNG 魔数 + 乱尾 → 明确报错', async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(256, 9),
    ]);
    await assert.rejects(
      () => prepareAttachments([item('bad.png', 'image/png', corrupt)], sharp),
      /解码失败/,
    );
  });

  await test('gif 透传：字节原样、仅补尺寸元数据', async () => {
    const gif = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'yellow' },
    })
      .gif()
      .toBuffer();
    const [prepared] = (await prepareAttachments(
      [item('a.gif', 'image/gif', gif)],
      sharp,
    )) as PreparedAttachment[];
    assert.equal(prepared.dataBase64, gif.toString('base64'), 'gif 字节不重编');
    assert.equal(prepared.width, 32);
    assert.equal(prepared.height, 32);
  });

  await test('png 透明度保留：RGBA → 输出仍 png 且 hasAlpha', async () => {
    const png = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const [prepared] = (await prepareAttachments(
      [item('a.png', 'image/png', png)],
      sharp,
    )) as PreparedAttachment[];
    const outMeta = await sharp(Buffer.from(prepared.dataBase64, 'base64')).metadata();
    assert.equal(outMeta.format, 'png');
    assert.equal(outMeta.hasAlpha, true);
  });

  await test('webp：格式保持 webp', async () => {
    const webp = await sharp({ create: { width: 48, height: 48, channels: 3, background: 'blue' } })
      .webp()
      .toBuffer();
    const [prepared] = (await prepareAttachments(
      [item('a.webp', 'image/webp', webp)],
      sharp,
    )) as PreparedAttachment[];
    const outMeta = await sharp(Buffer.from(prepared.dataBase64, 'base64')).metadata();
    assert.equal(outMeta.format, 'webp');
  });

  await test('单边超限：17000x1 → 拒绝', async () => {
    const strip = await sharp({
      create: { width: 17000, height: 1, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await assert.rejects(
      () => prepareAttachments([item('strip.png', 'image/png', strip)], sharp),
      /尺寸超限/,
    );
  });

  await test('sharp 缺失降级：仅嗅探、字节原样、无尺寸元数据', async () => {
    const jpeg = await jpegFixture(4000, 3000); // 明明超预算也不处理
    const [prepared] = (await prepareAttachments(
      [item('d.jpg', 'image/jpeg', jpeg)],
      null,
    )) as PreparedAttachment[];
    assert.equal(prepared.dataBase64, jpeg.toString('base64'));
    assert.equal(prepared.width, undefined);
    assert.equal(prepared.height, undefined);
    assert.equal(prepared.originalDimensions, undefined);
  });

  // ---- 汇总 ----
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${'='.repeat(56)}`);
  console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('验收：嗅探/MIME 一致性/EXIF/下采样/透传/降级/超限 ✓');
};

void main();
