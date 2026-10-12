// Preview 标签状态：打开哪些文件 / 激活哪个 / 关闭。
// M2 由 PreviewDock 内部持有；M4 Timeline 点文件时提升到 App 级（同一 hook）。

import { useCallback, useState } from 'react';

export interface PreviewTab {
  /** POSIX 相对路径。 */
  path: string;
  name: string;
}

export interface PreviewTabs {
  tabs: PreviewTab[];
  activePath: string | null;
  /** 打开（或激活已打开的）文件标签。 */
  open: (path: string, name: string) => void;
  /** 关闭标签；关闭的是激活标签时激活迁移到最后一个。 */
  close: (path: string) => void;
  setActive: (path: string) => void;
  closeAll: () => void;
}

export function usePreviewTabs(): PreviewTabs {
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const open = useCallback((path: string, name: string) => {
    setTabs((prev) => (prev.some((tab) => tab.path === path) ? prev : [...prev, { path, name }]));
    setActivePath(path);
  }, []);

  const close = useCallback(
    (path: string) => {
      const next = tabs.filter((tab) => tab.path !== path);
      setTabs(next);
      if (activePath === path) {
        setActivePath(next.length > 0 ? next[next.length - 1].path : null);
      }
    },
    [tabs, activePath],
  );

  const closeAll = useCallback(() => {
    setTabs([]);
    setActivePath(null);
  }, []);

  return { tabs, activePath, open, close, setActive: setActivePath, closeAll };
}
