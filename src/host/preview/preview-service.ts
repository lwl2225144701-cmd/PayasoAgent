// 模块: Preview 域业务逻辑 —— 工作区目录树 / 文件读取 / stat。
//
// 边界（设计见 docs/plans/preview-module-plan.md §2）：
// - 本模块**不认识 HTTP**（无 req/res）；参数是纯数据，错误只抛 PreviewError；
// - 安全一律委托 sandbox-manager（resolveWorkspacePath + assertInsideRoot），
//   禁止在本模块内做 path.resolve 直算；
// - 大小上限一律 import attachment-policy，禁止出现新的字节数常量；
// - 忽略规则复用 tools/workspace-scan 的 DEFAULT_IGNORED_DIRS，不得复制第二份；
// - 只读优先：M1 不含写端点（写回与 permission_denied 属 M5）。

import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_IMAGE_BYTES,
  MAX_OFFICE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
} from '../../attachment-policy.js';
import { assertInsideRoot, resolveWorkspacePath } from '../../sandbox/sandbox-manager.js';
import { DEFAULT_IGNORED_DIRS } from '../../tools/workspace-scan.js';
import { IMAGE_EXT_MIME } from '../routes/static-handler.js';
import { getWorkspace } from '../workspace.js';
import { MAX_ENTRIES } from '../workspace-browser.js';
import {
  type PreviewContentKind,
  PreviewError,
  type PreviewFileContent,
  type PreviewFileStat,
  type PreviewTreeEntry,
  type PreviewTreeListing,
} from './types.js';

export const MAX_TREE_ENTRIES = MAX_ENTRIES; // 单层可见条目上限（与页内目录浏览器同值）

/** OOXML 文档 MIME（docx/xlsx 由前端 mammoth/SheetJS 解析原始字节）。 */
const OFFICE_EXT_MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const PDF_MIME = 'application/pdf';

/**
 * 已知二进制扩展名：命中即 unsupported（前端转 FallbackViewer 下载兜底）。
 * 名单之外的扩展名**默认按文本预览**——封闭白名单会让 .csv/.log/.env/无扩展名
 * 文件（Makefile、Dockerfile）全部落入 415，对预览面板是不可接受的缺失；
 * 文本解码不存在安全风险（字节原样呈现），安全性由路径校验 + 大小上限保证。
 */
const KNOWN_BINARY_EXTS: ReadonlySet<string> = new Set([
  // 压缩/归档
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  // 音视频
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wav',
  '.flac',
  // 字体
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // 可执行/二进制对象
  '.exe',
  '.dll',
  '.dylib',
  '.so',
  '.bin',
  '.dat',
  '.class',
  '.jar',
  '.war',
  '.wasm',
  '.node',
  '.o',
  '.a',
  '.pyc',
  '.pyo',
  // 数据库文件
  '.db',
  '.sqlite',
  '.sqlite3',
]);

interface ContentCategory {
  kind: PreviewContentKind;
  mimeType?: string;
  maxBytes?: number;
}

/** 扩展名 → 内容类别 + MIME + 大小上限。上限常量只来自 attachment-policy。 */
function categorize(ext: string): ContentCategory {
  const imageMime = IMAGE_EXT_MIME[ext];
  if (imageMime) return { kind: 'image', mimeType: imageMime, maxBytes: MAX_IMAGE_BYTES };
  if (ext === '.pdf') return { kind: 'pdf', mimeType: PDF_MIME, maxBytes: MAX_PDF_BYTES };
  const officeMime = OFFICE_EXT_MIME[ext];
  if (officeMime) return { kind: 'office', mimeType: officeMime, maxBytes: MAX_OFFICE_BYTES };
  if (KNOWN_BINARY_EXTS.has(ext)) return { kind: 'unsupported' };
  return { kind: 'text', mimeType: 'text/plain; charset=utf-8', maxBytes: MAX_TEXT_BYTES };
}

/**
 * 预览作用域：决定这一批读取落在哪个工作区根上。
 *
 * - 不传 = Host 当前工作区（用户显式"打开工作区"后的默认语义）；
 * - `{ rootPath }` = 调用方（handler 按会话 Run 解析）指定的工作区——
 *   历史会话也能直接浏览它自己的工作区，不必先把工作区切过去；
 * - `{ rootPath: null }` = 显式指定但解析不到（Run 不存在 / 会话已删除 /
 *   旧记录没有 workspaceRoot）→ no_workspace。**不允许静默回落到当前工作区**，
 *   否则用户以为在看 A 会话的文件，实际拿到的是 B 工作区的内容。
 */
export interface PreviewScope {
  rootPath: string | null;
}

function requireWorkspaceRoot(scope?: PreviewScope): string {
  if (scope) {
    if (!scope.rootPath) throw new PreviewError('no_workspace');
    return scope.rootPath;
  }
  const workspace = getWorkspace();
  if (!workspace) throw new PreviewError('no_workspace');
  return workspace.rootPath;
}

/**
 * 归一化调用方传入的相对路径：统一 POSIX 分隔符、去首尾斜杠与空白。
 * 归一化后 '' = 工作区根。绝对路径在此降格为工作区相对路径
 * （'/src' 与 'src' 同义——浏览器地址栏语义，且 resolveWorkspacePath 本来
 * 就拒绝绝对路径，此处提前归一避免无谓的 400）。
 */
export function normalizeRelPath(rel: string): string {
  return String(rel ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function isTraversal(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.split(/[\\/]+/).includes('..');
}

/**
 * rel（已归一化）→ 已校验的绝对路径。空串 = 工作区根本身。
 * 双重校验：resolveWorkspacePath（字符串级）+ assertInsideRoot（realpath/symlink 级），
 * 与 run 文件端点（readFileChecked）同一套链。
 */
function resolveChecked(root: string, rel: string): string {
  if (rel.length === 0) return root;
  if (isTraversal(rel)) throw new PreviewError('invalid_path');
  let abs: string;
  try {
    abs = resolveWorkspacePath(root, rel);
  } catch {
    // 预检已拦绝对路径/穿越；走到这里只可能是字符串级逃逸判定
    throw new PreviewError('outside_workspace');
  }
  try {
    assertInsideRoot(root, abs);
  } catch {
    throw new PreviewError('outside_workspace');
  }
  return abs;
}

function parentRel(rel: string): string | null {
  if (rel.length === 0) return null;
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}

/**
 * 列出单层目录内容（懒加载语义：前端点开目录才请求下一级）。
 * - 目录在前、文件在后，各按名称 locale 排序（与 workspace-browser 一致）；
 * - 默认跳过 DEFAULT_IGNORED_DIRS（node_modules/.git/dist/…），includeIgnored=true 全览；
 * - dotfile 标记 hidden；symlink/fifo/socket 等非普通文件不枚举（不跟随，防逃逸）；
 * - 可见条目超 MAX_TREE_ENTRIES 截断并置 truncated。
 */
export function listTree(
  rel: string,
  includeIgnored = false,
  scope?: PreviewScope,
): PreviewTreeListing {
  const root = requireWorkspaceRoot(scope);
  const norm = normalizeRelPath(rel);
  const abs = resolveChecked(root, norm);

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new PreviewError('not_found');
    if (code === 'ENOTDIR') throw new PreviewError('invalid_path');
    // EACCES/EPERM 等：读取被拒。403 是语义最近的既有 code（读侧无独立拒绝码）
    throw new PreviewError('outside_workspace');
  }

  const visible: PreviewTreeEntry[] = [];
  for (const dirent of dirents) {
    if (visible.length > MAX_TREE_ENTRIES) break; // 已收满一层 + 1 条越界证据，停止扫
    const name = dirent.name;
    if (!includeIgnored && DEFAULT_IGNORED_DIRS.has(name)) continue;
    const childRel = norm.length > 0 ? `${norm}/${name}` : name;
    const hidden = name.startsWith('.');
    if (dirent.isDirectory()) {
      visible.push({ name, path: childRel, kind: 'dir', hidden });
      continue;
    }
    if (!dirent.isFile()) continue; // symlink/fifo/socket：不枚举（不跟随）
    try {
      const st = fs.statSync(path.join(abs, name));
      visible.push({
        name,
        path: childRel,
        kind: 'file',
        hidden,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // 竞态删除/不可 stat：跳过该条目，不让整层列表失败
    }
  }

  const dirs = visible
    .filter((e) => e.kind === 'dir')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const files = visible
    .filter((e) => e.kind === 'file')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const sorted = [...dirs, ...files];
  const truncated = sorted.length > MAX_TREE_ENTRIES;

  return {
    path: norm,
    workspace: path.basename(root) || root,
    parent: parentRel(norm),
    entries: truncated ? sorted.slice(0, MAX_TREE_ENTRIES) : sorted,
    truncated,
  };
}

/**
 * 读取工作区文件内容，按扩展名分发类别（与前端 viewer registry 对应）：
 * 文本返回 utf8 字符串；图片/pdf/office 返回原始字节 + MIME（前端解析渲染）；
 * 已知二进制扩展名拒绝（415）。
 */
export function readFile(rel: string, scope?: PreviewScope): PreviewFileContent {
  const root = requireWorkspaceRoot(scope);
  const norm = normalizeRelPath(rel);
  if (norm.length === 0) throw new PreviewError('invalid_path'); // 根是目录，不是文件
  const abs = resolveChecked(root, norm);

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PreviewError('not_found');
    throw new PreviewError('outside_workspace');
  }
  if (!st.isFile()) throw new PreviewError('invalid_path'); // 目录不可当文件读

  const category = categorize(path.extname(norm).toLowerCase());
  if (category.kind === 'unsupported') throw new PreviewError('unsupported');
  const limit = category.maxBytes ?? 0;
  if (st.size > limit) {
    throw new PreviewError('too_large', { limit, size: st.size });
  }

  if (category.kind === 'text') {
    return { kind: 'text', text: fs.readFileSync(abs, 'utf8') };
  }
  return { kind: category.kind, buffer: fs.readFileSync(abs), mimeType: category.mimeType };
}

/** 单文件元数据（树 UI 行内展示与 P3 刷新的比对基准）。 */
export function statFile(rel: string, scope?: PreviewScope): PreviewFileStat {
  const root = requireWorkspaceRoot(scope);
  const norm = normalizeRelPath(rel);
  if (norm.length === 0) throw new PreviewError('invalid_path');
  const abs = resolveChecked(root, norm);

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new PreviewError('not_found');
    throw new PreviewError('outside_workspace');
  }
  return {
    name: path.basename(norm),
    path: norm,
    kind: st.isDirectory() ? 'dir' : 'file',
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}
