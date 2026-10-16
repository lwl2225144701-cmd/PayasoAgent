// 模块: 桌面壳「检查更新」的纯逻辑 —— 版本门禁 / 轮询退避 / 错误分类。
//
// 为什么单独一个文件：这些判断没有 Electron 依赖，可以进确定性套件（tests/）
// 被真的跑；electron-updater 的接线（coordinator.ts）只能靠源码契约 + 真机验。
// 照 DSH `DesktopUpdateCoordinator`/`DesktopUpdateSchedule` 裁剪，去掉埋点与
// 自定义 httpExecutor（见 docs/plans/auto-update-调研报告.md §5.2）。

/** 解析后的版本号：核心数字段 + 预发布后缀（`0.2.0-rc.2` → prerelase `rc.2`）。 */
export interface ParsedVersion {
  numbers: number[];
  prerelease: string;
}

/**
 * 解析 `x.y.z[-pre]`。壳的版本号由 CI 的 tag 写入（`v0.4.6` → `0.4.6`），格式受控；
 * 非法段按 0 处理，宁可把未知版本判成"旧"也不要抛异常把检查流程打断。
 */
export function parseVersion(text: string): ParsedVersion {
  const [core = '', prerelease = ''] = text.trim().replace(/^v/i, '').split('-', 2);
  const numbers = core.split('.').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  return { numbers, prerelease };
}

/**
 * 比较两个版本号：a > b 返回正数，相等 0，a < b 负数。
 * 预发布版恒小于同号正式版（`0.2.0-rc.2 < 0.2.0`），两个预发布版按后缀字典序。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const width = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < width; i += 1) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === '') return 1;
  if (right.prerelease === '') return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * 候选版本是否严格新于当前版本。
 *
 * DSH 除了 `allowDowngrade=false` 还额外加这道门禁（调研 §1.2）：feed 被人改错、
 * 或者误点了旧版安装包，都不会把用户降级。
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export interface CheckScheduleOptions {
  /** 连续失败次数：0 = 上次成功（用基础间隔）。 */
  attempt: number;
  /** 基础检查间隔（默认 10 分钟，DSH 同款）。 */
  baseMs: number;
  /** 退避上限（默认 6 小时，DSH 同款）。 */
  maxMs: number;
  /** 抖动比例（0.2 = ±20%，打散多客户端同时请求）。 */
  jitterRatio: number;
  /** 注入随机源（测试里给定值，运行时用 Math.random）。 */
  random: () => number;
}

/**
 * 下一次检查要等多久：指数退避到上限，再叠 ±jitterRatio 抖动。
 * 抖动后仍夹在 [0, maxMs×(1+jitterRatio)] 内，避免负数或超上限。
 */
export function nextCheckDelay(options: CheckScheduleOptions): number {
  const { attempt, baseMs, maxMs, jitterRatio, random } = options;
  const exponent = Math.max(0, Math.min(attempt, 16));
  const backoff = Math.min(baseMs * 2 ** exponent, maxMs);
  const factor = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.round(backoff * factor));
}

/** 网络类失败的识别（node/Chromium 的错误串）。 */
const NETWORK_FAILURE =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|net::/i;

export function isNetworkFailure(message: string): boolean {
  return NETWORK_FAILURE.test(message);
}

export type UpdateOperation = 'check' | 'download' | 'install';

/**
 * 给用户看的一句话（原始报错只放 detail，主文案永远是人话）。
 * 文案区分"网络问题"与"安装失败"—— 用户的下一步动作完全不同。
 */
export function describeUpdateFailure(operation: UpdateOperation, message: string): string {
  if (isNetworkFailure(message)) {
    return operation === 'download' ? '下载更新失败：网络不可用' : '检查更新失败：网络不可用';
  }
  if (operation === 'download') return '下载更新失败';
  if (operation === 'install') return '安装更新失败';
  return '检查更新失败';
}
