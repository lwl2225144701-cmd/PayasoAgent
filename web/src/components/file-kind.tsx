// 文件类型判定与图标 —— 扩展名 → 类型 → 图标的**唯一**映射处。
//
// 消费方：
//   - preview/registry（再导出，FileTree 图标 / 标签栏图标 / FallbackViewer 的既有
//     import 路径不变）；
//   - Timeline 的附件卡片（FileAttachment）。
//
// 本模块**不 import 任何 viewer**：Timeline 走这里拿图标，既不会把 preview 的
// 懒加载 chunk 拖进主包，也不让 components 反向依赖 preview 域。
//
// 扩展名只在这里出现一次。新增一种文件类型 = 在这里加一个正则 + 一个分支，
// 所有图标消费方同时生效。

import type { ReactElement } from 'react';
import {
  FileIcon,
  ImageFileIcon,
  MarkdownIcon,
  PdfIcon,
  SheetIcon,
  SlidesIcon,
  WordIcon,
} from './icons';

/** 文件类型（图标与配色维度；与 viewer 的 PreviewContentKind 是两件事）。 */
export type FileKind = 'markdown' | 'image' | 'pdf' | 'word' | 'sheet' | 'slides' | 'file';

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
const PDF_EXT = /\.pdf$/i;
const DOCX_EXT = /\.(docx?|rtf)$/i;
const SHEET_EXT = /\.(xlsx|xls|csv|tsv)$/i;
const SLIDES_EXT = /\.(pptx?|key)$/i;

export const isMarkdownFile = (fileName: string): boolean => MARKDOWN_EXT.test(fileName);
export const isImageFile = (fileName: string): boolean => IMAGE_EXT.test(fileName);
export const isPdfFile = (fileName: string): boolean => PDF_EXT.test(fileName);
export const isDocxFile = (fileName: string): boolean => DOCX_EXT.test(fileName);
export const isSheetFile = (fileName: string): boolean => SHEET_EXT.test(fileName);
export const isSlidesFile = (fileName: string): boolean => SLIDES_EXT.test(fileName);

/** 文件名 → 文件类型（顺序即优先级，与 preview/registry 的 viewer 匹配一致）。 */
export function fileKindOf(fileName: string): FileKind {
  if (isMarkdownFile(fileName)) return 'markdown';
  if (isImageFile(fileName)) return 'image';
  if (isPdfFile(fileName)) return 'pdf';
  if (isSlidesFile(fileName)) return 'slides';
  if (isDocxFile(fileName)) return 'word';
  if (isSheetFile(fileName)) return 'sheet';
  return 'file';
}

/** 类型 → 图标组件。 */
export function FileKindIcon({ kind, size }: { kind: FileKind; size?: number }): ReactElement {
  switch (kind) {
    case 'markdown':
      return <MarkdownIcon size={size} />;
    case 'image':
      return <ImageFileIcon size={size} />;
    case 'pdf':
      return <PdfIcon size={size} />;
    case 'slides':
      return <SlidesIcon size={size} />;
    case 'word':
      return <WordIcon size={size} />;
    case 'sheet':
      return <SheetIcon size={size} />;
    default:
      return <FileIcon size={size} />;
  }
}
