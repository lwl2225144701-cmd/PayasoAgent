// Module: Workspace Scan — one deterministic directory walker shared by the
// file-discovery tools (grep / glob).
//
// Why this module exists (v1.9):
// grep used to walk every directory under the workspace, including
// node_modules/.git/dist, with a 5000-file budget. In a real repo the budget
// was consumed by dependencies before reaching `src/`, so "search the project"
// silently found nothing useful. Both search tools now share one walker with
// one ignore policy, so they cannot drift.
//
// Contract:
// - Never follows symlinks (escape prevention; the caller already authorized the
//   base path via resolveAuthorizedPath).
// - Depth- and count-bounded: a scan always terminates.
// - Deterministic order: entries are returned sorted by relative path.
// - Pure filesystem reads; no tool/registry imports.

import fs from 'node:fs';
import path from 'node:path';

/** Directory names skipped by default (dependencies, VCS, build output, caches). */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

export const SCAN_MAX_DEPTH = 32;
export const SCAN_MAX_FILES = 20_000;
/** Files larger than this are not read for searching (still reported by glob). */
export const SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface ScannedFile {
  /** Absolute path (already inside the authorized root). */
  absPath: string;
  /** POSIX-style path relative to the workspace root. */
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface ScanWorkspaceOptions {
  /** Absolute workspace root; used to compute relPath. */
  root: string;
  /** Absolute directory to start from (must be inside root). Defaults to root. */
  baseDir?: string;
  /** Apply DEFAULT_IGNORED_DIRS (default true). */
  ignore?: boolean;
  maxDepth?: number;
  maxFiles?: number;
}

export interface ScanWorkspaceResult {
  files: ScannedFile[];
  /** Files skipped because the scan hit maxFiles. */
  truncated: boolean;
  /** Directories skipped by the ignore policy. */
  ignoredDirs: number;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Walk `baseDir` and return every regular file, sorted by relative path.
 * Symlinks are never followed and never returned.
 */
export function scanWorkspaceFiles(options: ScanWorkspaceOptions): ScanWorkspaceResult {
  const root = path.resolve(options.root);
  const baseDir = path.resolve(options.baseDir ?? root);
  const ignore = options.ignore !== false;
  const maxDepth = options.maxDepth ?? SCAN_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? SCAN_MAX_FILES;

  const files: ScannedFile[] = [];
  let truncated = false;
  let ignoredDirs = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || files.length >= maxFiles) {
      if (files.length >= maxFiles) truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 目录内排序，保证同一目录下的遍历顺序确定（跨平台一致）。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore && DEFAULT_IGNORED_DIRS.has(entry.name)) {
          ignoredDirs++;
          continue;
        }
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      files.push({
        absPath: abs,
        relPath: toPosix(path.relative(root, abs)) || entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  };

  let baseIsFile = false;
  try {
    baseIsFile = fs.statSync(baseDir).isFile();
  } catch {
    return { files: [], truncated: false, ignoredDirs: 0 };
  }
  if (baseIsFile) {
    const stat = fs.statSync(baseDir);
    files.push({
      absPath: baseDir,
      relPath: toPosix(path.relative(root, baseDir)) || path.basename(baseDir),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  } else {
    walk(baseDir, 0);
  }

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, truncated, ignoredDirs };
}
