// 模块: Preview 域契约 —— 封闭错误码枚举、PreviewError 异常与响应类型。
//
// 为什么单独存在：preview 域是独立模块（设计见 docs/plans/preview-module-plan.md），
// 契约必须有唯一 owner。本文件是**前后端契约的单一来源**——前端
// web/src/preview/types.ts 按项目现有惯例手工镜像，两侧集合一致性由
// tests/preview-api.test.ts 断言，防漂移。
//
// 边界：本文件只放类型与错误身份，不放业务逻辑（service）与 HTTP 细节（handler）。

/**
 * 封闭的错误码集合。新增 code 必须同步三处：
 * handler 的 CODE_STATUS 映射、前端 PreviewErrorCode union、i18n 文案。
 * tests/preview-api.test.ts 对集合内容做断言——改集合而不同步测试会红。
 */
export const PREVIEW_ERROR_CODES = [
  'invalid_path', // 400 空路径/含 ..//绝对路径/目录当文件读
  'outside_workspace', // 403 解析结果逃逸工作区根（含 symlink 逃逸、无权限读取）
  'not_found', // 404 路径不存在
  'unsupported', // 415 类型不在白名单（已知二进制等）
  'permission_denied', // 403 read-only 工作区的写回（M5 写端点启用）
  'no_workspace', // 409 未选择工作区
] as const;

export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

/** code → HTTP 状态。唯一映射表；新增 code 必须在此登记（Record 全键约束兜底）。 */
const CODE_STATUS: Record<PreviewErrorCode, number> = {
  invalid_path: 400,
  outside_workspace: 403,
  not_found: 404,
  unsupported: 415,
  permission_denied: 403,
  no_workspace: 409,
};

/**
 * Preview 域唯一异常。
 *
 * 设计动机（现状问题）：Host 现有错误靠**消息字符串**承载身份
 * （`throw new Error('缺少 fromName/toName')`，中文散文直接泄漏成 API 响应），
 * server.ts 顶层兜底靠**精确字符串匹配**（`msg === 'untrusted origin'`），
 * 前端 jsonFetch 不解析错误体——按码分叉与 i18n 都无从做起。
 *
 * 契约：
 * - `message === code`：日志与 HTTP 响应以 code 为唯一身份，禁止散文消息；
 * - `detail` 只携带机器可读补充字段，
 *   禁止放给人看的句子（给人看的句子归前端 i18n）。
 */
export class PreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'PreviewError';
  }

  /** HTTP 状态码（CODE_STATUS 单一映射）。 */
  get status(): number {
    return CODE_STATUS[this.code];
  }
}

export type PreviewEntryKind = 'dir' | 'file';

export interface PreviewTreeEntry {
  name: string;
  /** POSIX 风格相对路径（'/' 分隔；目录不带结尾斜杠；根级条目即文件名）。 */
  path: string;
  kind: PreviewEntryKind;
  /** dotfile（'.' 前缀）。忽略目录内的条目在 includeIgnored=true 时也会带此标记。 */
  hidden: boolean;
  /** 仅 kind==='file'：字节数。 */
  size?: number;
  /** 仅 kind==='file'：mtime（epoch ms）。 */
  mtimeMs?: number;
}

export interface PreviewTreeListing {
  /** 当前列出的目录（POSIX 相对路径；根为 ''）。 */
  path: string;
  /** 工作区显示名（根目录 basename）。前端面包屑根用它——前端拿不到宿主绝对路径，只拿名字。 */
  workspace: string;
  /** 上级目录（POSIX 相对路径；根为 null）。 */
  parent: string | null;
  entries: PreviewTreeEntry[];
  /** 单层可见条目超 MAX_TREE_ENTRIES 置 true；entries 已截断到上限。 */
  truncated: boolean;
}

export interface PreviewFileStat {
  name: string;
  path: string;
  kind: PreviewEntryKind;
  size: number;
  mtimeMs: number;
}

/**
 * GET /preview/file 的内容分发类别——与前端 viewer registry 的类别一一对应：
 * text→TextViewer / image→ImageViewer / pdf→PdfViewer / office→Word|SheetViewer。
 */
export type PreviewContentKind = 'text' | 'image' | 'pdf' | 'office' | 'unsupported';

export interface PreviewFileContent {
  kind: PreviewContentKind;
  /** kind==='text'：utf8 解码后的内容。 */
  text?: string;
  /** kind==='image'|'pdf'|'office'：原始字节。 */
  buffer?: Buffer;
  /** kind==='image'|'pdf'|'office'：MIME 类型。 */
  mimeType?: string;
}
