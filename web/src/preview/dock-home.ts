// 预览面板首页（"开始"视图）的入口卡片。
//
// 居中两格：浏览器进入内嵌页面，文件进入目录树。
//
// 为什么单独一个纯模块：卡片元数据要能脱离 React/CSS 单测。

import type { MessageKey } from '../i18n/messages/index';

export type PreviewHomeActionId = 'browser' | 'workspace-files';

export interface PreviewHomeAction {
  id: PreviewHomeActionId;
  titleKey: MessageKey;
}

export const PREVIEW_HOME_ACTIONS: readonly PreviewHomeAction[] = [
  { id: 'browser', titleKey: 'preview.dock.home.browser' },
  { id: 'workspace-files', titleKey: 'preview.dock.filesTab' },
];

/**
 * 快捷键提示文案（卡片右侧的小胶囊）。
 * mac 显示 ⌘P，其它平台显示 Ctrl P —— 与 App 里实际监听的 ⌘/Ctrl+P 一致。
 */
export function shortcutLabel(isMac: boolean): string {
  return isMac ? '⌘ P' : 'Ctrl P';
}

/** 运行时平台判定（仅在浏览器里调用；SSR/单测传参走 shortcutLabel）。 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}
