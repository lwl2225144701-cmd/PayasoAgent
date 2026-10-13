// Preview 域 viewer registry —— 扩展名 → viewer 的单一注册表。
//
// 结构性契约（设计 §3.2）：新增一种文件类型 = 加一个 viewer 文件 + 在本表
// 加一行。FileTree 图标、标签栏图标、viewer 分发三处全部消费本表。
// 验收标准里"现场新增类型只改两处"说的就是这里。
//
// M3 起五类文档全部有正式 viewer：markdown / image / pdf / docx / xlsx；
// 文本（txt/代码/无扩展名）是兜底条目，必须排在最后。
//
// 扩展名判断本身不住在本文件：`components/file-kind` 是扩展名 → 类型 → 图标
// 的唯一实现（Timeline 附件卡片也消费它，且不能因此把 viewer 拖进主包），
// 本文件 import 它并在末尾再导出，FileTree / 标签栏 / FallbackViewer 的
// import 路径不变。

import { type ComponentType, lazy } from 'react';
import {
  type FileKind,
  FileKindIcon,
  fileKindOf,
  isDocxFile,
  isImageFile,
  isMarkdownFile,
  isPdfFile,
  isSheetFile,
} from '../components/file-kind';
import type { PreviewContentKind } from './types';

// 图标相关的单一实现在 components/file-kind（扩展名只在那里出现一次）；
// 这里再导出，FileTree / 标签栏 / FallbackViewer 的既有 import 路径不变。
export type PreviewFileIconName = FileKind;
export const fileIconName = fileKindOf;
export {
  FileKindIcon as FileIconFor,
  isDocxFile,
  isImageFile,
  isMarkdownFile,
  isPdfFile,
  isSheetFile,
};

export interface ViewerProps {
  /** POSIX 相对路径（/preview/file?path= 用）。 */
  path: string;
  /** 文件名（展示与匹配用）。 */
  name: string;
  /**
   * 预览作用域：当前会话 Run 的 id。有它时后端按该 Run 的工作区取文件
   * （历史会话也能看自己的文件）；缺省 = Host 当前工作区。
   */
  runId?: string | null;
}

export interface ViewerSpec {
  /** 命中判定（按注册顺序，先命中先赢）。 */
  match: (fileName: string) => boolean;
  /** 懒加载组件（React.lazy 保持稳定身份；Suspense 骨架由 PreviewDock 统一提供）。 */
  Component: ComponentType<ViewerProps>;
  /** 后端内容类别（与 categorize 对齐；用于图标与降级判断）。 */
  kind: PreviewContentKind;
}

export const VIEWERS: readonly ViewerSpec[] = [
  {
    match: isMarkdownFile,
    Component: lazy(() => import('./viewers/MarkdownViewer')),
    kind: 'text',
  },
  { match: isImageFile, Component: lazy(() => import('./viewers/ImageViewer')), kind: 'image' },
  { match: isPdfFile, Component: lazy(() => import('./viewers/PdfViewer')), kind: 'pdf' },
  { match: isDocxFile, Component: lazy(() => import('./viewers/WordViewer')), kind: 'office' },
  { match: isSheetFile, Component: lazy(() => import('./viewers/SheetViewer')), kind: 'office' },
  // 文本兜底必须最后：txt/js/ts/json/无扩展名…… 以及已知二进制（后端 415，
  // 由 TextViewer 的错误态转 FallbackViewer 下载兜底）
  { match: () => true, Component: lazy(() => import('./viewers/TextViewer')), kind: 'text' },
];

/** 未命中任何 viewer 的文件（当前不会发生；防御性保留）。 */
export const FallbackViewer = lazy(() => import('./viewers/FallbackViewer'));

/** 解析文件名对应的 viewer；未命中返回 null（调用方用 FallbackViewer）。 */
export function resolveViewer(fileName: string): ViewerSpec | null {
  return VIEWERS.find((spec) => spec.match(fileName)) ?? null;
}
