// 模块: 页面侧的「更新状态」桥（壳 → 页面）。
//
// 真机反馈（v0.4.11）：点「下载」之后 227MB 的包下载期间，界面上**没有任何进度**，
// 看起来像卡死；用户要的是「设置旁边能看到新版本 + 下载百分比」。
//
// 分工：壳负责检查/下载（apps/desktop/src/update/coordinator.ts），把状态用
// `payaso:updateStatus` 推给页面；页面只渲染。桥的权威声明在 vite-env.d.ts，
// 这里再写一份最小结构是因为 `tests/` 按根 tsconfig 检查本文件时看不到 web 的
// 全局声明；方法全可选 —— 老壳里没有这两个方法，新页面配老壳不能抛异常。

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** 目标版本（`0.4.12`，不含 v）。 */
  version: string;
  /** 下载百分比 0..100。 */
  percent: number;
  manual?: boolean;
}

export const IDLE_UPDATE_STATUS: UpdateStatus = { phase: 'idle', version: '', percent: 0 };

interface DesktopUpdateBridge {
  onUpdateStatus?: (listener: (status: unknown) => void) => (() => void) | void;
  startUpdateDownload?: () => void;
  getAppVersion?: () => Promise<string>;
}

function bridge(): DesktopUpdateBridge | undefined {
  return (window as unknown as { payasoDesktop?: DesktopUpdateBridge }).payasoDesktop;
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * 校验 + 夹紧跨进程传来的状态（ipc 那头是 unknown）。
 * 任何不合规的值都退化成 idle —— 页面宁可不显示条目，也不能渲染出 "undefined%"。
 */
export function normalizeUpdateStatus(value: unknown): UpdateStatus {
  if (typeof value !== 'object' || value === null) return IDLE_UPDATE_STATUS;
  const candidate = value as Partial<UpdateStatus>;
  if (
    candidate.phase !== 'checking' &&
    candidate.phase !== 'available' &&
    candidate.phase !== 'downloading' &&
    candidate.phase !== 'ready' &&
    candidate.phase !== 'installing'
  ) {
    return IDLE_UPDATE_STATUS;
  }
  const version = typeof candidate.version === 'string' ? candidate.version : '';
  if (version === '' && candidate.phase !== 'checking') return IDLE_UPDATE_STATUS;
  const percent = typeof candidate.percent === 'number' ? clampPercent(candidate.percent) : 0;
  return {
    phase: candidate.phase,
    version,
    percent,
    ...(candidate.phase === 'ready' ? { manual: candidate.manual === true } : {}),
  };
}

/**
 * 订阅更新状态；返回取消订阅函数。
 * 浏览器里没有桥 → 返回空函数、永不回调（侧边栏条目自然不出现）。
 */
export function subscribeUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  try {
    const unsubscribe = bridge()?.onUpdateStatus?.((value) =>
      listener(normalizeUpdateStatus(value)),
    );
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  } catch {
    return () => {};
  }
}

/** 点侧边栏「新版本」→ 让壳开始下载。没有桥时是空操作。 */
export function startUpdateDownload(): void {
  try {
    bridge()?.startUpdateDownload?.();
  } catch {
    // 桥不可用/被拒：忽略（页面只是少了一个入口）
  }
}

/** 读当前壳版本；浏览器 / 老壳没有桥时返回空串。 */
export async function readAppVersion(): Promise<string> {
  try {
    const version = await bridge()?.getAppVersion?.();
    return typeof version === 'string' ? version.trim() : '';
  } catch {
    return '';
  }
}
