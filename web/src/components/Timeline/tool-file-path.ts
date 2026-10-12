// 工具参数 → 可预览的工作区相对路径（M4：Timeline 点文件进预览面板）。
//
// 为什么单独一个纯模块：Timeline 只拿得到工具名与 args（模型给的原始形状，
// 可能是对象、JSON 字符串甚至是别的字段名），判定逻辑必须能脱离 React 单测
// （tests/frontend-tool-file-path.test.ts，非组件测试）。
//
// 只接受"确定是工作区内文件"的路径；拿不准就返回 null —— 宁可不出按钮，
// 也不能把 `/etc/passwd`、`../x`、glob 模式或 URL 送进 /preview/file。

/** 有"单文件路径"语义的工具（glob/ls/grep 是目录或模式，不在此列）。 */
const FILE_TOOLS = /(read|write|edit|move|delete|file|patch)/i;

/** 参数里可能承载路径的字段名，按优先级排列。 */
const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'file',
  'source',
  'destination',
  'target',
] as const;

/** 含 glob/通配符的字符串不是具体文件。 */
const GLOB_CHARS = /[*?[\]{}]/;

/**
 * 校验并归一化一个工作区相对路径。
 * 返回 null 表示"不是可预览的工作区文件"。
 */
export function normalizePreviewTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '' || raw.includes('\0')) return null;
  // 绝对路径（POSIX / Windows 盘符）、家目录、URL 一律拒绝：预览只认工作区相对路径
  if (raw.startsWith('/') || raw.startsWith('~') || raw.startsWith('\\')) return null;
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  // Windows 反斜杠分隔不归一化（工作区路径约定是 POSIX），避免猜错层级
  if (raw.includes('\\')) return null;
  if (raw.endsWith('/')) return null;
  if (GLOB_CHARS.test(raw)) return null;
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return null;
  return segments.join('/');
}

/** 取路径最后一段作为标签名。 */
export function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function pathFromRecord(record: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const candidate = normalizePreviewTarget(record[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}

/**
 * 从工具名 + 原始 args 里取出可预览的工作区相对路径。
 *
 * 支持三种 args 形状：对象（含 `path` 等键）、JSON 字符串、被截断的
 * JSON 字符串（`previewArgs` 之外的原始值一般完整；截断串解析失败即放弃）。
 */
export function extractToolFilePath(tool: string, args: unknown): string | null {
  if (!FILE_TOOLS.test(tool)) return null;
  if (args == null) return null;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed.startsWith('{')) {
      // 裸字符串只可能是路径本身（个别工具的直接参数形态）
      return normalizePreviewTarget(trimmed);
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed !== null && typeof parsed === 'object'
        ? pathFromRecord(parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof args === 'object') return pathFromRecord(args as Record<string, unknown>);
  return null;
}
