// Preview 域前端契约镜像 —— 与后端 src/host/preview/types.ts 手工同步
// （项目现有前后端契约模式，见 web/src/types.ts）。两侧集合一致性由
// tests/preview-api.test.ts（后端）与 tests/frontend-preview-registry.test.ts
// （前端）分别断言，防漂移。
//
// 边界：本文件只放类型与错误码身份，不放请求逻辑（api.ts）与组件。

/** 与后端 PREVIEW_ERROR_CODES 一致：新增 code 必须两侧同步 + i18n 文案。 */
export const PREVIEW_ERROR_CODES = [
  'invalid_path',
  'outside_workspace',
  'not_found',
  'too_large',
  'unsupported',
  'permission_denied',
  'no_workspace',
] as const;

export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

/**
 * 目录树加载失败的身份：已知错误码，或 'unknown'（网络中断 / 响应不是
 * PreviewError JSON —— 例如旧 Host 没有 /preview 路由，SPA fallback 回了 HTML）。
 * 'unknown' 必须有自己的文案：以前这类失败会落进"空目录"，把故障伪装成空目录，
 * 是实机上最误导人的一种假绿。
 */
export type PreviewTreeError = PreviewErrorCode | 'unknown';

export type PreviewEntryKind = 'dir' | 'file';

export interface PreviewTreeEntry {
  name: string;
  /** POSIX 风格相对路径（'/' 分隔；目录不带结尾斜杠）。 */
  path: string;
  kind: PreviewEntryKind;
  hidden: boolean;
  /** 仅 kind==='file'：字节数。 */
  size?: number;
  /** 仅 kind==='file'：mtime（epoch ms）。 */
  mtimeMs?: number;
}

export interface PreviewTreeListing {
  path: string;
  /** 工作区显示名（根目录 basename；与后端手工同步）。 */
  workspace: string;
  parent: string | null;
  entries: PreviewTreeEntry[];
  truncated: boolean;
}

export interface PreviewFileStat {
  name: string;
  path: string;
  kind: PreviewEntryKind;
  size: number;
  mtimeMs: number;
}

/** 与后端内容类别一一对应（viewer registry 按类别分发）。 */
export type PreviewContentKind = 'text' | 'image' | 'pdf' | 'office' | 'unsupported';
