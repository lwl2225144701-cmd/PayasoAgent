// 预览面板首页（"开始"视图）的入口卡片。
//
// 纵向列表：工作区文件 → 新建终端 → 浏览器（对齐 DSH 空态入口）。
// 形态：图标 + 标题/描述 + 右侧快捷键。
//
// 为什么单独一个纯模块：卡片元数据要能脱离 React/CSS 单测。

import type { MessageKey } from '../i18n/messages/index';

export type PreviewHomeActionId = 'browser' | 'workspace-files' | 'terminal';

export interface PreviewHomeAction {
  id: PreviewHomeActionId;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}

export const PREVIEW_HOME_ACTIONS: readonly PreviewHomeAction[] = [
  {
    id: 'workspace-files',
    titleKey: 'preview.tree.root',
    descriptionKey: 'preview.dock.home.workspaceFiles.description',
  },
  {
    id: 'terminal',
    titleKey: 'preview.dock.home.terminal',
    descriptionKey: 'preview.dock.home.terminal.description',
  },
  {
    id: 'browser',
    titleKey: 'preview.dock.home.browser',
    descriptionKey: 'preview.dock.home.browser.description',
  },
];

/**
 * 快捷键提示文案（工作区文件卡片右侧的小胶囊）。
 * mac 显示 ⌘P，其它平台显示 Ctrl P —— 与 App 里实际监听的 ⌘/Ctrl+P 一致。
 */
export function shortcutLabel(isMac: boolean): string {
  return isMac ? '⌘ P' : 'Ctrl P';
}

/** 浏览器卡片右侧胶囊（与 App 里 ⌘/Ctrl+T 一致）。 */
export function browserShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘ T' : 'Ctrl T';
}

/** 终端卡片右侧胶囊（展示用；系统终端由 open-in-app 拉起）。 */
export function terminalShortcutLabel(isMac: boolean): string {
  return isMac ? '⌃ `' : 'Ctrl `';
}

/** 卡片右侧快捷键。 */
export function actionShortcut(id: PreviewHomeActionId, isMac: boolean): string | null {
  if (id === 'workspace-files') return shortcutLabel(isMac);
  if (id === 'browser') return browserShortcutLabel(isMac);
  if (id === 'terminal') return terminalShortcutLabel(isMac);
  return null;
}

/** 运行时平台判定（仅在浏览器里调用；SSR/单测传参走 shortcutLabel）。 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}
