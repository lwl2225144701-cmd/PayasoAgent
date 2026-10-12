// Preview 域 viewer registry —— 扩展名 → viewer 的单一注册表。
//
// 结构性契约（设计 §3.2）：新增一种文件类型 = 加一个 viewer 文件 + 在本表
// 加一行。FileTree 图标、标签栏图标、viewer 分发三处全部消费本表，
// 不存在第二处扩展名判断。验收标准里"现场新增类型只改两处"说的就是这里。
//
// M3 起五类文档全部有正式 viewer：markdown / image / pdf / docx / xlsx；
// 文本（txt/代码/无扩展名）是兜底条目，必须排在最后。

import { type ComponentType, lazy } from 'react';
import {
  FileIcon,
  ImageFileIcon,
  MarkdownIcon,
  PdfIcon,
  SheetIcon,
  WordIcon,
} from '../components/icons';
import type { PreviewContentKind } from './types';

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

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const PDF_EXT = /\.pdf$/i;
const DOCX_EXT = /\.docx$/i;
const SHEET_EXT = /\.(xlsx|xls|csv|tsv)$/i;

export const isMarkdownFile = (fileName: string): boolean => MARKDOWN_EXT.test(fileName);
export const isImageFile = (fileName: string): boolean => IMAGE_EXT.test(fileName);
export const isPdfFile = (fileName: string): boolean => PDF_EXT.test(fileName);
export const isDocxFile = (fileName: string): boolean => DOCX_EXT.test(fileName);
export const isSheetFile = (fileName: string): boolean => SHEET_EXT.test(fileName);

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

export type PreviewFileIconName = 'markdown' | 'image' | 'pdf' | 'docx' | 'sheet' | 'file';

/** 文件名 → 图标名（FileTree / 标签栏共用）。 */
export function fileIconName(fileName: string): PreviewFileIconName {
  if (isMarkdownFile(fileName)) return 'markdown';
  if (isImageFile(fileName)) return 'image';
  if (isPdfFile(fileName)) return 'pdf';
  if (isDocxFile(fileName)) return 'docx';
  if (isSheetFile(fileName)) return 'sheet';
  return 'file';
}

/** 图标名 → 组件（唯一一处把图标名映射到 icons.tsx）。 */
export function FileIconFor({ name, size }: { name: PreviewFileIconName; size?: number }) {
  switch (name) {
    case 'markdown':
      return <MarkdownIcon size={size} />;
    case 'image':
      return <ImageFileIcon size={size} />;
    case 'pdf':
      return <PdfIcon size={size} />;
    case 'docx':
      return <WordIcon size={size} />;
    case 'sheet':
      return <SheetIcon size={size} />;
    default:
      return <FileIcon size={size} />;
  }
}
