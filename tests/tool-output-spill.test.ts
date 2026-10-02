// 套件: 工具输出 spill（B 项 · 单条闸可恢复）
// 用法: npx tsx tests/tool-output-spill.test.ts
// 验收：超限内容落盘且能读回被砍掉的中间段 / 路径在工作区内可被 read 读 /
//       内容寻址稳定命名 / UTF-8 不乱码 / fail-soft 不丢数据 / 只读不可写。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAttachmentStoreRoot } from '../src/attachments/store.js';
import { guardToolOutput } from '../src/runtime/output-guard.js';
import {
  spillNotice,
  spillToolOutput,
  TOOL_OUTPUT_SPILL_DIR,
} from '../src/runtime/tool-output-spill.js';

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

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-spill-store-'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-spill-ws-'));
process.env.PAYASO_ATTACHMENT_STORE = STORE;

const target = { workspaceRoot: WS, toolName: 'shell', runId: 'run-test-1' };

// ---- 落盘基本契约 ----

check('落盘返回工作区内相对路径（input/spill/ 下）', () => {
  const rel = spillToolOutput('hello spill', target);
  assert.ok(rel, '应落盘成功');
  assert.ok(
    rel.startsWith(`${TOOL_OUTPUT_SPILL_DIR}/`),
    `路径应在 ${TOOL_OUTPUT_SPILL_DIR}/ 下：${rel}`,
  );
  assert.ok(rel.endsWith('.txt'), '应是 .txt');
  assert.ok(!path.isAbsolute(rel), '必须是工作区相对路径（read 只接受相对路径）');
  assert.ok(fs.existsSync(path.join(WS, rel)), '文件真实存在');
});

check('内容逐字节一致（含中文 / emoji 不乱码）', () => {
  const text = '中文内容 ✅ 🎉\n第二行\ttab\r\n尾';
  const rel = spillToolOutput(text, target);
  assert.ok(rel);
  assert.equal(fs.readFileSync(path.join(WS, rel), 'utf8'), text);
});

check('落盘文件只读（非 win32）', () => {
  const rel = spillToolOutput('readonly check', target);
  assert.ok(rel);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(WS, rel)).mode & 0o777;
    assert.equal(mode, 0o444, `应是 0444，实际 ${mode.toString(8)}`);
  }
});

check('同一内容重复落盘：命名稳定（内容寻址）', () => {
  const text = 'stable naming payload';
  const a = spillToolOutput(text, target);
  const b = spillToolOutput(text, target);
  assert.ok(a && b);
  assert.equal(a, b, '同内容应得到同一路径');
});

check('去重：同内容在库内只有一个对象', () => {
  const before = countObjects();
  spillToolOutput('dedup payload', target);
  const after = countObjects();
  const mid = countObjects();
  spillToolOutput('dedup payload', target);
  assert.equal(countObjects(), mid, '第二次不应新增对象');
  assert.ok(after >= before);
});

check('spillNotice 含可读回路径', () => {
  const rel = spillToolOutput('notice payload', target);
  assert.ok(rel);
  const notice = spillNotice(rel);
  assert.ok(notice.includes(rel), '提示里必须带路径');
  assert.match(notice, /read/, '提示里要说明用 read 读回');
});

// ---- fail-soft ----

check('落盘失败：workspaceRoot 不可写 → 返回 null，不抛错', () => {
  const filePath = path.join(WS, 'not-a-dir.txt');
  fs.writeFileSync(filePath, 'x');
  const rel = spillToolOutput('fail soft payload', {
    workspaceRoot: filePath, // 指向文件而非目录 → 发布必然失败
    toolName: 'shell',
    runId: 'run-test-1',
  });
  assert.equal(rel, null, '失败必须返回 null（调用方据此保留原结果）');
});

// ---- 核心验收：以前丢掉的中间段，现在能捞回来 ----

check('超限后可恢复：guard 砍掉的中间段，能从落盘文件里读回', () => {
  const head = 'H'.repeat(10 * 1024);
  const middle = `<<<MIDDLE-UNIQUE-${'m'.repeat(40 * 1024)}>>>`;
  const tail = 'T'.repeat(5 * 1024);
  const full = head + middle + tail;

  // 1) guard 截断：中间段不在模型可见内容里
  const guarded = guardToolOutput(full);
  assert.equal(guarded.truncated, true, '应被截断');
  assert.ok(!guarded.content.includes('MIDDLE-UNIQUE'), '中间段确实不在受限结果里');
  assert.ok(guarded.content.includes('H'.repeat(100)), '头部保留');

  // 2) 落盘后能完整读回
  const rel = spillToolOutput(full, target);
  assert.ok(rel, '应落盘成功');
  const recovered = fs.readFileSync(path.join(WS, rel), 'utf8');
  assert.equal(recovered, full, '落盘内容与原文完全一致');
  assert.ok(recovered.includes('MIDDLE-UNIQUE'), '被砍掉的中间段可以读回');
  assert.equal(Buffer.byteLength(recovered, 'utf8'), guarded.originalBytes, '字节数一致');
});

// ---- 拼接后的模型可见结果 ----

check('模型可见结果 = 受限内容 + 落盘提示（长度可控）', () => {
  const full = 'A'.repeat(50 * 1024);
  const guarded = guardToolOutput(full);
  const rel = spillToolOutput(full, target);
  assert.ok(rel);
  const result = `${guarded.content}\n${spillNotice(rel)}`;
  assert.ok(result.includes(rel));
  assert.ok(
    Buffer.byteLength(result, 'utf8') < guarded.originalBytes,
    '拼接后仍远小于原文（否则落盘就没意义了）',
  );
});

function countObjects(): number {
  const objects = path.join(getAttachmentStoreRoot(), 'objects');
  if (!fs.existsSync(objects)) return 0;
  let n = 0;
  for (const bucket of fs.readdirSync(objects)) {
    n += fs.readdirSync(path.join(objects, bucket)).length;
  }
  return n;
}

fs.rmSync(STORE, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n工具输出 spill 汇总: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
console.log('验收：落盘可读回 / 路径在工作区内 / 内容寻址稳定 / UTF-8 安全 / fail-soft / 只读');
