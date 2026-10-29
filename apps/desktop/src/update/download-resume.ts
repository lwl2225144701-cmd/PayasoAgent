// 模块: 更新包的断点续传下载（替换 electron-updater 默认的单流下载）。
//
// 为什么不用上游的（v0.4.23 实机 + 2026-10-29 网络实测）：
//   1. 上游 `ProgressCallbackTransform._flush()` 把 `percent` 和 `transferred`
//      **无条件写成 100 / total**，从不比对实际收到的字节。网络一断、流提前结束，
//      用户先看到一个假的 100%，紧接着 sha512 校验失败、进度归零、从头再下。
//      UI 上就是「100% 突然变回 0」。
//   2. 上游 `httpExecutor.download` 是单流、无 HTTP Range，任何一次失败都从 0 开始。
//      本机实测：直连 GitHub Release 基本不通（curl code=000），走代理也只有
//      20 KB/s 量级，170 MB 的包动辄下十几分钟，断一次就等于这次更新废了。
//   3. 上游下载失败后会删掉临时文件（`removeFileIfAny`），跨调用续传不可能，
//      所以续传必须在**一次 download 调用内部**完成，对外仍然只有成功/失败两种结果。
//
// 注入方式：`NsisUpdater.doDownloadUpdate` 只调 `this.httpExecutor.download(url, dest, options)`，
// 而 `disableDifferentialDownload = true` 保证了差分会短路、不会走到
// `downloadToBuffer` / `GenericDifferentialDownloader`。所以这里用鸭子类型注入即可，
// 不必继承未导出的 `ElectronHttpExecutor`。
//
// 进度语义：`percent = 已接收 / 总长`，只有 `已接收 === 总长` 时才可能是 100；
// 流提前结束时直接抛错，不再谎报。sha512 通过后才 resolve，所以调用方拿到的
// 「100%」一定跟着「文件是完整的」。

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isNetworkFailure } from './policy.js';

export interface ResumableProgressInfo {
  total: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

export interface ResumableDownloadOptions {
  /** latest.yml 声明的 sha512（base64 或 hex）。 */
  sha512?: string | null;
  sha2?: string | null;
  headers?: Record<string, string> | null;
  cancellationToken?: { cancelled: boolean } | null;
  onProgress?: (info: ResumableProgressInfo) => void;
  /** 内部重试次数（不含首次尝试）。默认 3。 */
  attempts?: number;
  retryDelayMs?: number;
}

export interface ResumableDownloadDeps {
  fetch?: typeof fetch;
  log?: (message: string) => void;
  delay?: (ms: number) => Promise<void>;
}

/** latest.yml 里 sha512 可能是 hex（128 位小写）或 base64；统一成 base64 再比。 */
export function expectedSha512Base64(value: string): string {
  if (value.length === 128 && /^[0-9a-f]+$/.test(value)) {
    return Buffer.from(value, 'hex').toString('base64');
  }
  return value;
}

export interface ResumePlan {
  /** 这一轮实际要从哪里开始收。 */
  have: number;
  /** 总长；拿不到 content-length 时为 NaN。 */
  total: number;
  /** 是否必须丢弃已有字节从头下（服务器不认 Range）。 */
  reset: boolean;
}

/**
 * 决定这一轮怎么下。已有部分字节 + 服务器返回 206 → 续传；
 * 已有部分字节但返回 200 → 服务器不认 Range，只能从头。
 */
export function planResume(
  existingBytes: number,
  status: number,
  contentLength: number,
): ResumePlan {
  if (existingBytes <= 0) {
    return { have: 0, total: Number.isFinite(contentLength) ? contentLength : NaN, reset: false };
  }
  if (status === 206) {
    return {
      have: existingBytes,
      total: Number.isFinite(contentLength) ? existingBytes + contentLength : NaN,
      reset: false,
    };
  }
  return { have: 0, total: Number.isFinite(contentLength) ? contentLength : NaN, reset: true };
}

/** 流是否算「收完了」：总长未知时只能信流结束，交给 sha512 兜底。 */
export function isTransferComplete(have: number, total: number): boolean {
  return !Number.isFinite(total) || have === total;
}

/** 已落盘字节数；文件不存在当 0。 */
export function existingBytes(destination: string): number {
  try {
    return statSync(destination).size;
  } catch {
    return 0;
  }
}

/** 把磁盘上已有的前缀喂进 digest，保证续传后整文件哈希连续。 */
async function seedDigestFromDisk(destination: string, digest: ReturnType<typeof createHash>) {
  const stream = createReadStream(destination);
  try {
    for await (const chunk of stream) digest.update(chunk as Buffer);
  } finally {
    stream.destroy();
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带 Range 续传与网络重试的下载。任何非网络错误（sha512 不匹配、文件写不进去等）
 * 立即抛出，不浪费重试机会。
 *
 * 每一轮都从磁盘真相出发：`have = existingBytes()`，digest 由「重读磁盘上前缀」播种。
 * 这样即使上一轮的写流在出错时被 destroy、丢掉了还没落盘的字节，下一轮也只会
 * 续真正落盘的那段 —— 「磁盘字节数」和「digest 已收字节数」永远不会脱钩。
 * 代价是每轮多读一遍已有字节（170 MB 约 0.2 秒），相对下载时长可以忽略。
 */
export async function downloadWithResume(
  url: URL | string,
  destination: string,
  options: ResumableDownloadOptions = {},
  deps: ResumableDownloadDeps = {},
): Promise<string> {
  const fetchFn = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const delay = deps.delay ?? defaultDelay;
  const attempts = Math.max(0, options.attempts ?? 3);
  const retryDelayMs = options.retryDelayMs ?? 3_000;
  const started = Date.now();

  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (attempt > 0) {
      log(
        `download interrupted (${String(lastError instanceof Error ? lastError.message : lastError)}); retry ${attempt}/${attempts}, resuming from ${existingBytes(destination)} bytes`,
      );
      await delay(retryDelayMs);
    }
    try {
      const received = await runAttempt(fetchFn, url, destination, options, log);
      const actual = received.digest.digest('base64');
      const expected = options.sha512 ? expectedSha512Base64(options.sha512) : null;
      if (expected !== null && actual !== expected) {
        throw new Error(`sha512 checksum mismatch, expected ${expected}, got ${actual}`);
      }
      log(
        `download verified in ${Math.round((Date.now() - started) / 1000)}s: ${destination} (${received.have} bytes)`,
      );
      return destination;
    } catch (error) {
      lastError = error;
      if (options.cancellationToken?.cancelled) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // 非网络类失败（校验不匹配、磁盘写不进）重试也没有意义，直接交出去。
      if (!isNetworkFailure(message)) throw error;
      if (attempt === attempts) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`下载更新失败：${String(lastError)}`);
}

interface AttemptResult {
  have: number;
  digest: ReturnType<typeof createHash>;
}

async function runAttempt(
  fetchFn: typeof fetch,
  url: URL | string,
  destination: string,
  options: ResumableDownloadOptions,
  log: (message: string) => void,
): Promise<AttemptResult> {
  let have = existingBytes(destination);
  let digest = createHash('sha512');
  if (have > 0) {
    log(`resume from ${have} bytes already on disk`);
    await seedDigestFromDisk(destination, digest);
  }

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (have > 0) headers.Range = `bytes=${have}-`;
  const response = await fetchFn(url, { headers, redirect: 'follow' });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const lengthHeader = response.headers.get('content-length');
  const contentLength = lengthHeader === null ? NaN : Number.parseInt(lengthHeader, 10);
  const plan = planResume(have, response.status, contentLength);
  if (plan.reset) {
    log('server ignored Range; restarting from scratch');
    have = 0;
    digest = createHash('sha512');
    await truncate(destination);
  }
  const total = plan.total;
  have = plan.have;

  const body = response.body;
  if (body === null) throw new Error('下载更新失败：响应没有内容');

  const started = Date.now();
  // 每收到一块就 appendFile 落盘，然后才更新计数和进度。
  // 不用流式 pipeline：它会在出错时销毁写流，把已经收到的字节一起丢掉，
  // 续传就废了。这里「落盘才继续」，连接在任何一刻断掉，磁盘上有的就是全部已收字节。
  for await (const chunk of Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])) {
    if (options.cancellationToken?.cancelled) throw new Error('cancelled');
    const buffer = chunk as Buffer;
    await appendFile(destination, buffer);
    digest.update(buffer);
    have += buffer.length;
    options.onProgress?.({
      total,
      transferred: have,
      // 总长未知时不猜百分比，交给 sha512 兜底。
      percent: Number.isFinite(total) && total > 0 ? (have / total) * 100 : 0,
      bytesPerSecond: Math.round(have / ((Date.now() - started) / 1000)),
    });
  }

  // 流结束了但字节不够：这就是上游谎报 100% 的那一幕，这里必须拦住。
  if (!isTransferComplete(have, total)) {
    throw new Error(`下载更新失败：连接提前中断，收到 ${have} / ${total} 字节`);
  }
  return { have, digest };
}

/**
 * 供 `NsisUpdater` 注入的 httpExecutor。
 *
 * `disableDifferentialDownload = true` 时 `doDownloadUpdate` 只会调 `download()`，
 * 差分会短路、走不到 `downloadToBuffer` / `GenericDifferentialDownloader`，
 * 所以这里只需要实现这一个方法；注入处的类型断言接 `HttpExecutor` 的其余成员。
 */
export function createResumingHttpExecutor(deps: ResumableDownloadDeps = {}) {
  return {
    download: (url: URL | string, destination: string, options: ResumableDownloadOptions = {}) =>
      downloadWithResume(url, destination, options, deps),
  };
}

async function truncate(destination: string): Promise<void> {
  await writeFile(destination, Buffer.alloc(0));
}
