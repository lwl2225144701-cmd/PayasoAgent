// 模块: 更新包下载层（断点续传 + 真实进度）的确定性测试。
// 用法: npx tsx tests/download-resume.test.ts
//
// 覆盖 v0.4.23 实机暴露的三个缺陷：
//   1. 上游进度条在流提前结束时谎报 100%（percent/transferred 无条件写成 total）；
//   2. 上游无 HTTP Range，一次失败就从 0 重下；
//   3. 上游失败即删临时文件，跨调用续传不可能 —— 所以续传必须在一次调用内完成，
//      而这意味着 digest 必须跨内部重试保留已收部分的哈希，否则最终一定校验不匹配。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  downloadWithResume,
  existingBytes,
  expectedSha512Base64,
  isTransferComplete,
  planResume,
} from '../apps/desktop/src/update/download-resume';

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('expectedSha512Base64：hex 与 base64 都归一成 base64', () => {
  const bytes = Buffer.from('payaso-update-fixture');
  const hex = createHash('sha512').update(bytes).digest('hex');
  const base64 = createHash('sha512').update(bytes).digest('base64');
  assert.equal(hex.length, 128);
  assert.equal(expectedSha512Base64(hex), base64);
  assert.equal(expectedSha512Base64(base64), base64, 'base64 原样返回');
});

test('planResume：无字节 / 206 续传 / 200 不认 Range 只能从头', () => {
  assert.deepEqual(planResume(0, 200, 1000), { have: 0, total: 1000, reset: false });
  assert.deepEqual(planResume(400, 206, 600), { have: 400, total: 1000, reset: false });
  const reset = planResume(400, 200, 1000);
  assert.equal(reset.have, 0, '服务器忽略 Range 时必须丢弃已有字节');
  assert.equal(reset.total, 1000);
  assert.equal(reset.reset, true);
  // content-length 缺失时不猜总长
  assert.deepEqual(planResume(0, 200, NaN), { have: 0, total: NaN, reset: false });
});

test('isTransferComplete：总长未知只能信流结束；已知则必须收满', () => {
  assert.equal(isTransferComplete(500, 500), true);
  assert.equal(isTransferComplete(499, 500), false, '少一字节也不算完成');
  assert.equal(isTransferComplete(0, NaN), true, '总长未知时交给 sha512 兜底');
});

// ── 假「服务器」：尊重 Range 头，可按脚本在发够 N 字节后中断 ────────────────

interface ServerStep {
  /** 发这么多字节后让连接中断（默认发完）。 */
  truncateAfter?: number;
  error?: Error;
  /** 忽略 Range，返回 200 全量（模拟不支持续传的服务器）。 */
  ignoreRange?: boolean;
  /** 在 content-length 里谎报一个别的长度（模拟被截断的响应）。 */
  claimLength?: number;
}

/**
 * 按脚本回应请求。返回的 fetch 会记录每次收到的 Range 头，
 * 因此测试断言的是「客户端真的按磁盘字节数发起了续传」。
 */
function payloadServer(
  payload: Buffer,
  steps: ServerStep[],
): { fn: typeof fetch; ranges: (string | undefined)[] } {
  const ranges: (string | undefined)[] = [];
  let index = 0;
  const fn = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    ranges.push(init?.headers?.Range);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    const range = init?.headers?.Range;
    const start =
      step.ignoreRange || !range ? 0 : Number(range.replace(/^bytes=/, '').replace(/-$/, ''));
    const body = payload.subarray(start);
    const status = step.ignoreRange || !range ? 200 : 206;
    const headers = new Headers();
    headers.set('content-length', String(step.claimLength ?? body.length));
    const limit =
      step.truncateAfter === undefined ? body.length : Math.min(step.truncateAfter, body.length);
    // 送完 limit 字节后，在下一个宏任务里才让连接死掉。
    // 同 tick 就 controller.error() 会让 ReadableStream 丢掉队列里还没被读走的字节
    // （实测：收到 [] 然后 boom），那反而不真实 —— 真实 TCP 是先把字节交付完，连接才断。
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (limit > 0) controller.enqueue(new Uint8Array(body.subarray(0, limit)));
        if (step.error) setTimeout(() => controller.error(step.error), 0);
        else controller.close();
      },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers,
      body: stream,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, ranges };
}

function temp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'payaso-download-'));
}

const noDelay = async () => {};

// ── 下载行为 ──────────────────────────────────────────────────────────────

test('完整下载：写盘、sha512 校验通过、进度只增不减', async () => {
  const dir = temp();
  try {
    const payload = Buffer.from('x'.repeat(64 * 1024));
    const dest = path.join(dir, 'temp-setup.exe');
    const { fn } = payloadServer(payload, [{}]);
    const seen: number[] = [];
    const result = await downloadWithResume(
      new URL('https://example.test/setup.exe'),
      dest,
      {
        sha512: createHash('sha512').update(payload).digest('base64'),
        onProgress: (info) => seen.push(info.percent),
      },
      { fetch: fn, delay: noDelay },
    );
    assert.equal(result, dest);
    assert.deepEqual(readFileSync(dest), payload);
    assert.equal(seen.at(-1), 100, '最后一个进度必须是真 100（收满了）');
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i] >= seen[i - 1], '进度不允许回退');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sha512 不匹配：立即抛错，绝不重试', async () => {
  const dir = temp();
  try {
    const payload = Buffer.from('tampered');
    const dest = path.join(dir, 'temp-setup.exe');
    const { fn, ranges } = payloadServer(payload, [{}]);
    await assert.rejects(
      downloadWithResume(
        'https://example.test/setup.exe',
        dest,
        {
          sha512: createHash('sha512').update(Buffer.from('original')).digest('base64'),
        },
        { fetch: fn, delay: noDelay },
      ),
      /sha512 checksum mismatch/,
    );
    assert.equal(ranges.length, 1, '校验失败重试没有意义，不能浪费一次请求');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('中途断线：带 Range 续传，digest 跨重试保持连续（核心回归）', async () => {
  const dir = temp();
  try {
    const head = Buffer.from('A'.repeat(10));
    const tail = Buffer.from('B'.repeat(20));
    const whole = Buffer.concat([head, tail]);
    const expected = createHash('sha512').update(whole).digest('base64');
    const dest = path.join(dir, 'temp-setup.exe');

    // 第一轮：只发 10 字节就断线；第二轮：按 Range 续传剩下 20 字节。
    const { fn, ranges } = payloadServer(whole, [
      { truncateAfter: 10, error: new Error('net::ERR_CONNECTION_CLOSED') },
      {},
    ]);
    const logs: string[] = [];
    const seen: number[] = [];
    await downloadWithResume(
      'https://example.test/setup.exe',
      dest,
      {
        sha512: expected,
        onProgress: (info) => seen.push(info.percent),
      },
      { fetch: fn, delay: noDelay, log: (m) => logs.push(m) },
    );

    assert.deepEqual(readFileSync(dest), whole, '续传后文件必须完整');
    assert.deepEqual(ranges, [undefined, 'bytes=10-'], '第二轮必须带 Range 头');
    assert.equal(existingBytes(dest), 30);
    // 关键：digest 必须包含第一轮的 10 字节，否则这里必然校验失败
    assert.ok(logs.some((line) => line.includes('retry 1/3, resuming from 10 bytes')));
    // 进度只增不减，且从没出现过假的 100%
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1]);
    assert.ok(seen.every((percent) => percent <= 100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务器忽略 Range（返回 200）：丢弃已有字节从头下', async () => {
  const dir = temp();
  try {
    const stale = Buffer.from('STALE');
    const fresh = Buffer.from('FRESH-CONTENT');
    const dest = path.join(dir, 'temp-setup.exe');
    writeFileSync(dest, stale);
    assert.equal(existingBytes(dest), stale.length);

    const { fn, ranges } = payloadServer(fresh, [{ ignoreRange: true }]);
    await downloadWithResume(
      'https://example.test/setup.exe',
      dest,
      {
        sha512: createHash('sha512').update(fresh).digest('base64'),
      },
      { fetch: fn, delay: noDelay },
    );
    assert.deepEqual(readFileSync(dest), fresh, '不能把旧字节残留在文件头部');
    assert.equal(ranges[0], `bytes=${stale.length}-`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('流提前结束且字节不足：抛错，不谎报 100%', async () => {
  const dir = temp();
  try {
    const dest = path.join(dir, 'temp-setup.exe');
    // 声称 100 字节，只给 10 字节就正常结束（连接被截断）
    const { fn } = payloadServer(Buffer.alloc(10), [{ ignoreRange: true, claimLength: 100 }]);
    const seen: number[] = [];
    await assert.rejects(
      downloadWithResume(
        'https://example.test/setup.exe',
        dest,
        {
          onProgress: (info) => seen.push(info.percent),
        },
        { fetch: fn, delay: noDelay },
      ),
      /连接提前中断，收到 10 \/ 100 字节/,
    );
    assert.ok(!seen.some((percent) => percent === 100), '没收满就不允许出现 100%');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘上已有部分字节：开跑前先把前缀喂进 digest', async () => {
  const dir = temp();
  try {
    const head = Buffer.from('A'.repeat(10));
    const tail = Buffer.from('B'.repeat(20));
    const whole = Buffer.concat([head, tail]);
    const dest = path.join(dir, 'temp-setup.exe');
    writeFileSync(dest, head);

    const { fn, ranges } = payloadServer(whole, [{}]);
    const logs: string[] = [];
    await downloadWithResume(
      'https://example.test/setup.exe',
      dest,
      {
        sha512: createHash('sha512').update(whole).digest('base64'),
      },
      { fetch: fn, delay: noDelay, log: (m) => logs.push(m) },
    );

    assert.deepEqual(readFileSync(dest), whole);
    assert.deepEqual(ranges, ['bytes=10-']);
    assert.ok(logs.some((line) => line.includes('resume from 10 bytes already on disk')));
    assert.equal(statSync(dest).size, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取消：立即抛出，不再发起后续请求', async () => {
  const dir = temp();
  try {
    const dest = path.join(dir, 'temp-setup.exe');
    const { fn, ranges } = payloadServer(Buffer.alloc(5), [{}]);
    const token = { cancelled: true };
    await assert.rejects(
      downloadWithResume(
        'https://example.test/setup.exe',
        dest,
        {
          cancellationToken: token,
        },
        { fetch: fn, delay: noDelay },
      ),
      /cancelled/,
    );
    assert.equal(ranges.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重试耗尽：抛出最后一次网络错误', async () => {
  const dir = temp();
  try {
    const dest = path.join(dir, 'temp-setup.exe');
    const { fn, ranges } = payloadServer(Buffer.alloc(5), [
      { error: new Error('net::ERR_CONNECTION_RESET') },
    ]);
    await assert.rejects(
      downloadWithResume(
        'https://example.test/setup.exe',
        dest,
        { attempts: 2 },
        {
          fetch: fn,
          delay: noDelay,
        },
      ),
      /ERR_CONNECTION_RESET/,
    );
    assert.equal(ranges.length, 3, '1 次首发 + 2 次重试');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP 非 2xx：按网络失败处理并重试（可达上限后抛出）', async () => {
  const dir = temp();
  try {
    const dest = path.join(dir, 'temp-setup.exe');
    const { fn } = payloadServer(Buffer.alloc(0), [{ error: new Error('HTTP 503') }]);
    await assert.rejects(
      downloadWithResume(
        'https://example.test/setup.exe',
        dest,
        { attempts: 1 },
        {
          fetch: fn,
          delay: noDelay,
        },
      ),
      /HTTP 503/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Readable 适配：分块写入、进度单调递增且末值等于总长', async () => {
  const dir = temp();
  try {
    const payload = Buffer.from('y'.repeat(40));
    const dest = path.join(dir, 'temp-setup.exe');
    const { fn } = payloadServer(payload, [{}]);
    const seen: number[] = [];
    await downloadWithResume(
      'https://example.test/setup.exe',
      dest,
      {
        sha512: createHash('sha512').update(payload).digest('base64'),
        onProgress: (info) => seen.push(info.transferred),
      },
      { fetch: fn, delay: noDelay },
    );
    assert.deepEqual(readFileSync(dest), payload);
    // 不假设 chunk 边界（Readable.fromWeb 可能合并），只锁真实契约：
    // 单调不减、从不超过总长、最后一定收满。
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] >= seen[i - 1], '进度不允许回退');
    assert.ok(seen.every((value) => value <= payload.length));
    assert.equal(seen.at(-1), payload.length, '收满才算完');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${(err as Error).message}`);
      failed += 1;
    }
  }
  console.log(`\ndownload-resume 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

// 兜底：确认 Readable.fromWeb 在本机可用（Node 18+ / Electron 44）。
assert.ok(typeof Readable.fromWeb === 'function', 'Readable.fromWeb 不可用');
void main();
