// 预览面板首页（"开始"视图）的入口卡片登记表。
//
// 参照 DeepSeek Harness 的右侧面板首页：面板打开时先给一张"工作区文件"卡片，
// 点它才进入文件树 / viewer。**只登记文件这一张**——终端、浏览器明确不做
// （面板只服务文件预览，见 docs/plans/preview-gui-调研报告.md 的范围收窄）。
//
// 为什么单独一个纯模块：卡片元数据要能脱离 React/CSS 单测（
// tests/frontend-preview-registry.test.ts 断言"只有一张卡"且 key 在消息表里
// 双语齐备）；新增一类面板 = 这里加一行 + 一个视图分支。

import type { MessageKey } from '../i18n/messages/index';

export interface PreviewHomeAction {
  /** 视图身份（点击后由 PreviewDock 分发到对应视图）。 */
  id: 'workspace-files';
  /** 卡片标题（复用文件树根标签：同一个东西同一个说法）。 */
  titleKey: MessageKey;
  /** 卡片副标题：说明这张卡能干什么。 */
  descriptionKey: MessageKey;
}

export const PREVIEW_HOME_ACTIONS: readonly PreviewHomeAction[] = [
  {
    id: 'workspace-files',
    titleKey: 'preview.tree.root',
    descriptionKey: 'preview.dock.home.workspaceFiles.description',
  },
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
