// useOpenInApps：按目标取"能打开它的已装应用"列表 + 图标 404 回退状态。
//
// Launcher（工作区根）与文件预览操作栏（具体文件）共用：列表由 Host 按目标
// 过滤（端点见 open-in-app.ts / 后端 openable.ts），这里只管理层级状态。
// 图标取不到（非 macOS / 提取失败）时标记 broken，调用方回退字形芯片。

import { useEffect, useState } from 'react';
import { invalidateOpenInApps, listOpenInApps, type OpenInApp } from '../open-in-app';

export interface OpenInAppsState {
  /** 已按目标过滤的应用列表；null = 加载中。 */
  apps: OpenInApp[] | null;
  /** 列表加载失败（端点不可达 / 旧 Host 没有该路由）。 */
  loadFailed: boolean;
  /** 图标 404 的应用 id（回退字形芯片）。 */
  brokenIcons: ReadonlySet<string>;
  /** 标记某个应用的图标取不到。 */
  markIconBroken: (id: string) => void;
}

export function useOpenInApps(path?: string | null, runId?: string | null): OpenInAppsState {
  const [apps, setApps] = useState<OpenInApp[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(new Set());

  // 目标变化（换了文件/切会话）→ 重新取列表；
  // controller 按目标缓存（带 TTL），同一文件连续打开不重复跑系统查询。
  useEffect(() => {
    let cancelled = false;
    setApps(null);
    setLoadFailed(false);
    setBrokenIcons(new Set());
    listOpenInApps(path, runId)
      .then((list) => {
        if (!cancelled) setApps(list);
      })
      .catch(() => {
        if (cancelled) return;
        invalidateOpenInApps();
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, runId]);

  return {
    apps,
    loadFailed,
    brokenIcons,
    markIconBroken: (id: string) => setBrokenIcons((prev) => new Set(prev).add(id)),
  };
}
