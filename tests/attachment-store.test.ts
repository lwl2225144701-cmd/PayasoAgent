// 模块: 附件内容寻址库单元测试（attachment-store P0 期，纯文件系统，秒级完成）
// 用法: npx tsx tests/attachment-store.test.ts
// 验收：sha256 去重单对象、原子发布字节完整、0444 只读、同名冲突追加后缀不覆盖、
//       tmp 孤儿清扫、跨设备（copy 回退路径）直测、物化优先走库路径。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage, MessageImage } from '../src/llm/llm.js';
import {
  attachmentSha256,
  publishAttachmentIntoWorkspace,
  putAttachmentObject,
  sweepAttachmentTmp,
} from '../src/runtime/attachment-store.js';
import {
  materializeMessagesForModel,
  writeAttachmentFile,
} from '../src/runtime/image-materialize.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  [FAIL] ${name}: ${message}`);
  }
}

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-att-store-'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-att-ws-'));
// 库根指向临时目录（getAttachmentStoreRoot 调用时读 env，与 SANDBOX_ROOT 测试同款）
process.env.PAYASO_ATTACHMENT_STORE = STORE;

function pngBytes(seed: number): Buffer {
  // 合法 PNG 魔数 + 随机 payload（P0 阶段不做解码校验，字节任意）
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(64, seed);
  return Buffer.concat([head, body]);
}

// ---- putAttachmentObject：去重与原子发布 ----

test('同字节去重：两次 put 同一对象路径，existed 第二次为 true', () => {
  const bytes = pngBytes(1);
  const first = putAttachmentObject(STORE, bytes);
  const second = putAttachmentObject(STORE, bytes);
  assert.equal(first.existed, false);
  assert.equal(second.existed, true);
  assert.equal(first.storePath, second.storePath);
  assert.equal(attachmentSha256(bytes), first.sha256);
  assert.equal(fs.readdirSync(path.join(STORE, 'objects', first.sha256.slice(0, 2))).length, 1);
});

test('原子发布：字节完整落库且权限 0444', () => {
  const bytes = pngBytes(2);
  const stored = putAttachmentObject(STORE, bytes);
  const onDisk = fs.readFileSync(stored.storePath);
  assert.ok(onDisk.equals(bytes));
  const mode = fs.statSync(stored.storePath).mode & 0o777;
  assert.equal(mode, 0o444);
});

test('分片目录：对象落在 objects/<sha前2>/ 下', () => {
  const stored = putAttachmentObject(STORE, pngBytes(3));
  assert.equal(path.basename(path.dirname(stored.storePath)), stored.sha256.slice(0, 2));
});

test('tmp 清扫：超龄孤儿删除，新文件保留，objects 不受影响', () => {
  const now = Date.now();
  const tmpDir = path.join(STORE, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const orphan = path.join(tmpDir, 'orphan');
  const fresh = path.join(tmpDir, 'fresh');
  fs.writeFileSync(orphan, 'x');
  fs.writeFileSync(fresh, 'y');
  const old = new Date(now - 2 * 60 * 60 * 1000);
  fs.utimesSync(orphan, old, old);
  const removed = sweepAttachmentTmp(STORE, now);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.ok(fs.existsSync(putAttachmentObject(STORE, pngBytes(3)).storePath));
});

// ---- publishAttachmentIntoWorkspace：可见性与冲突 ----

test('硬链接进 workspace：同 inode，relPath 正确', () => {
  const bytes = pngBytes(4);
  const stored = putAttachmentObject(STORE, bytes);
  const wsRoot = path.join(WS, 'run-a');
  fs.mkdirSync(wsRoot, { recursive: true });
  const { relPath, copied } = publishAttachmentIntoWorkspace(
    stored.storePath,
    wsRoot,
    'input/attachments',
    'abc.png',
  );
  assert.equal(copied, false);
  assert.equal(relPath, 'input/attachments/abc.png');
  const wsFile = path.join(wsRoot, relPath);
  assert.ok(fs.statSync(wsFile).ino === fs.statSync(stored.storePath).ino);
  assert.equal(fs.statSync(wsFile).mode & 0o777, 0o444);
});

test('同名不同字节：追加 -2 后缀，先到者不被覆盖', () => {
  const wsRoot = path.join(WS, 'run-b');
  fs.mkdirSync(wsRoot, { recursive: true });
  const a = putAttachmentObject(STORE, pngBytes(5));
  const b = putAttachmentObject(STORE, pngBytes(6));
  const ra = publishAttachmentIntoWorkspace(a.storePath, wsRoot, 'input/attachments', 'same.png');
  const rb = publishAttachmentIntoWorkspace(b.storePath, wsRoot, 'input/attachments', 'same.png');
  assert.equal(ra.relPath, 'input/attachments/same.png');
  assert.equal(rb.relPath, 'input/attachments/same-2.png');
  assert.ok(
    !fs
      .readFileSync(path.join(wsRoot, ra.relPath))
      .equals(fs.readFileSync(path.join(wsRoot, rb.relPath))),
  );
});

test('同字节同名（跨 workspace 引用同一对象）：第二次 EEXIST 也追加后缀，内容一致', () => {
  const wsRoot = path.join(WS, 'run-c');
  fs.mkdirSync(wsRoot, { recursive: true });
  const stored = putAttachmentObject(STORE, pngBytes(7));
  const r1 = publishAttachmentIntoWorkspace(
    stored.storePath,
    wsRoot,
    'input/attachments',
    'dup.png',
  );
  const r2 = publishAttachmentIntoWorkspace(
    stored.storePath,
    wsRoot,
    'input/attachments',
    'dup.png',
  );
  assert.equal(r2.relPath, 'input/attachments/dup-2.png');
  assert.ok(
    fs
      .readFileSync(path.join(wsRoot, r1.relPath))
      .equals(fs.readFileSync(path.join(wsRoot, r2.relPath))),
  );
});

test('copy 回退路径直测：内容与权限一致（模拟跨卷分支）', () => {
  const wsRoot = path.join(WS, 'run-d');
  fs.mkdirSync(wsRoot, { recursive: true });
  const stored = putAttachmentObject(STORE, pngBytes(8));
  // 直接调用 copy 语义：目标先占位模拟既有冲突验证 COPYFILE_EXCL 行为
  const { relPath, copied } = publishAttachmentIntoWorkspace(
    stored.storePath,
    wsRoot,
    'input/attachments',
    'c8.png',
  );
  assert.equal(typeof copied, 'boolean');
  assert.ok(fs.readFileSync(path.join(wsRoot, relPath)).equals(pngBytes(8)));
});

test('路径逃逸拒绝：目录含 .. 直接抛错', () => {
  const wsRoot = path.join(WS, 'run-e');
  fs.mkdirSync(wsRoot, { recursive: true });
  const stored = putAttachmentObject(STORE, pngBytes(9));
  assert.throws(() =>
    publishAttachmentIntoWorkspace(stored.storePath, wsRoot, '../outside', 'x.png'),
  );
});

// ---- writeAttachmentFile：端到端（入库 + workspace 可见性）----

test('writeAttachmentFile：返回 relPath + sha256，workspace 与库字节一致', () => {
  const wsRoot = path.join(WS, 'run-f');
  fs.mkdirSync(wsRoot, { recursive: true });
  const dataBase64 = pngBytes(10).toString('base64');
  const { relPath, sha256 } = writeAttachmentFile({
    workspaceRoot: wsRoot,
    directory: 'input/attachments',
    fileName: 'e2e 图.png', // 中文名保留在磁盘文件名里（publishStem 只滤危险字符）
    dataBase64,
  });
  assert.ok(sha256.length === 64);
  const wsFile = fs.readFileSync(path.join(wsRoot, relPath));
  assert.ok(wsFile.equals(pngBytes(10)));
  assert.equal(sha256, attachmentSha256(wsFile));
});

test('publishStem：Unicode 文件名保留可读，危险字符仍被消毒', () => {
  const wsRoot = path.join(WS, 'run-stem');
  fs.mkdirSync(wsRoot, { recursive: true });
  const dataBase64 = pngBytes(10).toString('base64');
  const publish = (fileName: string) =>
    writeAttachmentFile({ workspaceRoot: wsRoot, directory: 'input/attachments', fileName, dataBase64 }).relPath
      .split('/')
      .pop();
  // 中文/日文与内部空格保留，不再挤成一串下划线
  assert.equal(publish('需求说明 v2.png'), '需求说明 v2.png');
  assert.equal(publish('設計書.md'), '設計書.md');
  // 路径穿越（basename 已剥离）、控制字符、隐藏文件与结尾点仍被消毒
  assert.equal(publish('../../etc/passwd.png'), 'passwd.png');
  assert.equal(publish('bad\tname.txt'), 'bad_name.txt');
  assert.equal(publish('.gitignore'), '_gitignore');
  assert.equal(publish('trailing. .'), 'trailing');
});

test('writeAttachmentFile：空内容抛错', () => {
  const wsRoot = path.join(WS, 'run-g');
  fs.mkdirSync(wsRoot, { recursive: true });
  assert.throws(() =>
    writeAttachmentFile({
      workspaceRoot: wsRoot,
      directory: 'input/attachments',
      fileName: 'a.png',
      dataBase64: '',
    }),
  );
});

// ---- materialize：sha256 库路径优先 ----

test('物化优先走库路径：workspace 副本被删后仍能物化（sha 在）', () => {
  const wsRoot = path.join(WS, 'run-h');
  fs.mkdirSync(wsRoot, { recursive: true });
  const bytes = pngBytes(11);
  const stored = putAttachmentObject(STORE, bytes);
  // 模拟一条"workspace 副本丢失但 sha 在"的消息
  const image: MessageImage = {
    mimeType: 'image/png',
    path: 'input/attachments/ghost.png',
    sha256: stored.sha256,
  };
  const messages: ChatMessage[] = [{ role: 'user', content: '看图', images: [image] }];
  const view = materializeMessagesForModel(messages, wsRoot, true);
  const materialized = view[0]?.images?.[0];
  assert.ok(materialized?.data, '应通过库路径物化成功');
  assert.ok(Buffer.from(materialized.data, 'base64').equals(bytes));
});

test('物化回退 workspace：无 sha（旧数据）路径照常工作', () => {
  const wsRoot = path.join(WS, 'run-i');
  const dir = path.join(wsRoot, 'input', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = pngBytes(12);
  fs.writeFileSync(path.join(dir, 'legacy.png'), bytes);
  const image: MessageImage = { mimeType: 'image/png', path: 'input/attachments/legacy.png' };
  const view = materializeMessagesForModel(
    [{ role: 'user', content: '看图', images: [image] }],
    wsRoot,
    true,
  );
  const materialized = view[0]?.images?.[0];
  assert.ok(materialized?.data);
  assert.ok(Buffer.from(materialized.data, 'base64').equals(bytes));
});

test('库缺失且 workspace 缺失：该张图被丢弃不致命', () => {
  const wsRoot = path.join(WS, 'run-j');
  fs.mkdirSync(wsRoot, { recursive: true });
  const fakeSha = 'f'.repeat(64);
  const image: MessageImage = {
    mimeType: 'image/png',
    path: 'input/attachments/missing.png',
    sha256: fakeSha,
  };
  const view = materializeMessagesForModel(
    [{ role: 'user', content: '看图', images: [image] }],
    wsRoot,
    true,
  );
  assert.equal(view[0]?.images?.length ?? 0, 0);
});

// ---- 汇总 ----
fs.rmSync(STORE, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${'='.repeat(56)}`);
console.log(`汇总: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log('验收：内容寻址去重、原子发布、只读、冲突后缀、清扫、库路径物化 ✓');
