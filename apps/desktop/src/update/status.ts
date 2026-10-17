// 模块: 自更新的「页面可见状态」（纯数据 + 纯函数；壳发给页面，页面画侧边栏条目）。
//
// 为什么要有这一层：v0.4.11 真机反馈 —— 点「下载」之后 227MB 的包下载期间**界面上
// 一点反馈都没有**（只有 Dock 图标上一条细细的进度）。用户要的是「设置旁边能看到
// 新版本和下载百分比」，所以壳把状态推给页面，由页面渲染侧边栏条目
// （`web/src/update-status.ts` 是页面侧的同构定义 + 桥封装）。
//
// 三条相：
//   idle        没有可用更新（条目隐藏）
//   available   发现新版本，等用户点（条目显示「新版本 vX.Y.Z」）
//   downloading 正在下载（条目显示百分比 + 进度条）

export type UpdatePhase = 'idle' | 'available' | 'downloading';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** 目标版本（`0.4.12` 这种不带 v；idle 时为空串）。 */
  version: string;
  /** 下载百分比 0..100（非下载阶段为 0）。 */
  percent: number;
}

export const IDLE_UPDATE_STATUS: UpdateStatus = { phase: 'idle', version: '', percent: 0 };

/** 百分比：夹到 [0,100] 并取整（electron-updater 偶发浮点/缺字段）。 */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** 发现新版本（等用户点「下载」）。 */
export function availableStatus(version: string): UpdateStatus {
  return { phase: 'available', version, percent: 0 };
}

/** 下载中（percent 会被夹紧）。 */
export function downloadingStatus(version: string, percent: number): UpdateStatus {
  return { phase: 'downloading', version, percent: clampPercent(percent) };
}

/**
 * 校验跨进程传来的状态（ipc 那头是 unknown）。
 * 壳侧发、页面侧也有一份同样的校验（两边 tsconfig 各自独立，共享类型不现实）。
 */
export function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<UpdateStatus>;
  if (
    candidate.phase !== 'idle' &&
    candidate.phase !== 'available' &&
    candidate.phase !== 'downloading'
  ) {
    return false;
  }
  return typeof candidate.version === 'string' && typeof candidate.percent === 'number';
}
