// Host-owned in-page directory browser for Workspace picking.
//
// Rationale: a plain Web app cannot reveal an arbitrary absolute local path
// (browser sandbox), so the Host enumerates directories over HTTP and the UI
// renders a tree inside the page — no native FolderBrowserDialog window that
// can get hidden behind the browser (the failure mode the native picker had
// on Windows). Selecting a directory still runs the same authorization chain
// as the native picker (see workspace.ts / canonicalizeWorkspaceRoot): the
// user explicitly chooses a folder, which is the authorization.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

const MAX_ENTRIES = 500; // 单层目录返回上限，超出置 truncated 由前端提示

// Windows 上的虚拟"此电脑"层：path 为空串表示盘符列表（非真实目录）。
// 让浏览器内的选择器具备跨盘导航，而不是只能从 home（C 盘）往下钻。
const VIRTUAL_VOLUMES_PATH = '';

function isHiddenName(name: string): boolean {
  // '.' 前缀（dotfiles）与 '$' 前缀（Windows 系统目录，如 $Recycle.Bin）视为隐藏
  return name.startsWith('.') || name.startsWith('$');
}

// Windows 盘根 "C:\" 展示为 "C:"；POSIX 根 "/" 原样显示。
function rootDisplayName(root: string): string {
  if (process.platform === 'win32') {
    return root.replace(/[\\/]+$/, '') || root;
  }
  return root;
}

// 枚举当前存在的驱动器（Windows：C:\ D:\ …；POSIX 单根无盘概念）。
function listVolumes(): DirectoryEntry[] {
  if (process.platform !== 'win32') return [];
  const entries: DirectoryEntry[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) {
        entries.push({ name: `${letter}:`, path: path.normalize(root), hidden: false });
      }
    } catch {
      // 个别盘符 stat 失败（如未就绪的可移动盘）直接跳过
    }
  }
  return entries;
}

// 由当前绝对路径构造逐级面包屑（每级携带可跳转的完整绝对路径）。
// Windows 下盘根之上再加一级虚拟"此电脑"，用于切换其他盘。
function buildCrumbs(current: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = [];
  let cur = path.normalize(current);
  const isWin = process.platform === 'win32';
  // eslint 风格防护：极端情况下仍能终止
  for (let i = 0; i < 256; i++) {
    const parent = path.dirname(cur);
    crumbs.push({
      name: parent === cur ? rootDisplayName(cur) : path.basename(cur),
      path: cur,
      hidden: false,
    });
    if (parent === cur) {
      if (isWin && /^[a-zA-Z]:[\\/]/.test(cur)) {
        // 盘根之上提供"此电脑"层（path 为空串 = 盘符列表）
        crumbs.push({ name: '此电脑', path: VIRTUAL_VOLUMES_PATH, hidden: false });
      }
      break;
    }
    cur = parent;
  }
  return crumbs.reverse();
}

function volumesListing(home: string): DirectoryListing {
  return {
    path: VIRTUAL_VOLUMES_PATH,
    home: path.normalize(home),
    crumbs: [{ name: '此电脑', path: VIRTUAL_VOLUMES_PATH, hidden: false }],
    entries: listVolumes(),
    truncated: false,
  };
}

async function resolveBrowseTarget(requested?: string): Promise<string> {
  const home = os.homedir();
  // 空串是保留的"此电脑/盘符列表"虚拟层，由 browseDirectory 先行处理
  if (requested === undefined) return path.normalize(home);
  const raw = String(requested).trim();
  if (raw.length === 0) return path.normalize(home);
  if (!path.isAbsolute(raw)) {
    // 非绝对路径（如用户输入".."或相对片段）一律回到 home，不猜测
    return path.normalize(home);
  }
  return path.normalize(raw);
}

/**
 * 列出目录的单层内容（仅目录）。约定与 web/src/api.ts 的 DirectoryListing 一致。
 * - path 缺省 → home；空串（保留值）→ Windows "此电脑"盘符列表；非绝对路径 → home
 * - 不存在的路径/权限错误由调用方以错误信息呈现（不做静默回退，用户应能感知）
 */
export async function browseDirectory(
  requestedPath?: string,
): Promise<DirectoryListing> {
  const home = os.homedir();
  // 空串 = 虚拟"此电脑"层：列出所有可用盘符（仅 Windows；POSIX 回退 home）
  const raw =
    requestedPath === undefined ? undefined : String(requestedPath).trim();
  if (raw === '' && process.platform === 'win32') {
    return volumesListing(home);
  }
  const target = await resolveBrowseTarget(requestedPath);
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('目录不存在');
    if (code === 'EPERM' || code === 'EACCES') throw new Error('无权访问该目录');
    throw new Error('无法读取目录');
  }

  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    // 只展示目录（工作区必须是一个文件夹）；符号链接目录经 dirent.isDirectory
    // 无法识别，此处按目录处理需额外 stat，代价高——保持仅真实目录可见，
    // 用户若需链接目标可通过路径直填（Edit path）直达。
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    entries.push({
      name,
      path: path.join(target, name),
      hidden: isHiddenName(name),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const truncated = entries.length > MAX_ENTRIES;
  const listed = truncated ? entries.slice(0, MAX_ENTRIES) : entries;

  return {
    path: target,
    home: path.normalize(home),
    crumbs: buildCrumbs(target),
    entries: listed,
    truncated,
  };
}

const INVALID_FOLDER_NAME = /[\\/:*?"<>|]/;

/**
 * 在 parentPath 下新建目录（对话框内创建新工作区目录的唯一入口）。
 * 名称必须为单个路径段：禁止分隔符/通配/保留字符与 ".."。
 */
export async function createDirectoryInside(
  parentPath: string,
  rawName: string,
): Promise<{ path: string }> {
  const parent = String(parentPath ?? '').trim();
  const name = String(rawName ?? '').trim();
  if (!parent || !path.isAbsolute(parent)) throw new Error('父目录必须为绝对路径');
  if (!name || name === '.' || name === '..') throw new Error('文件夹名称非法');
  if (INVALID_FOLDER_NAME.test(name)) throw new Error('名称不能包含 \\ / : * ? " < > | 字符');
  const target = path.join(path.normalize(parent), name);
  try {
    await fs.mkdir(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Error('已存在同名文件夹');
    if (code === 'EPERM' || code === 'EACCES') throw new Error('无权在该位置创建文件夹');
    if (code === 'ENOENT') throw new Error('父目录不存在');
    throw new Error('创建文件夹失败');
  }
  return { path: target };
}
