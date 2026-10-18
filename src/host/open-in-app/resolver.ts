// open-in-app 装机探测 —— 逐条**证明**清单里的应用装没装，结果即权威。
//
// 规则（对齐参考实现）：每进程只跑一次并缓存；后续 open 撞上 ENOENT 时由路由
// 触发单条目重解析（reresolveEntry），不整表重扫。探测全是只读 IO + 一次性
// spawnSync（Windows reg.exe），不做任何启动动作。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APP_CATALOG,
  type AppCatalogEntry,
  type LocateSpec,
  type OpenableKind,
} from './catalog.js';
import { locateWinGui } from './win-locate.js';

export interface ResolvedApp {
  id: string;
  label: string;
  /** 能打开的目标类别（catalog 声明，端点按目标过滤用）。 */
  opens: OpenableKind[];
  /** darwin：解析出的 .app 绝对路径（`open -a <path>` 与图标提取用）。 */
  bundlePath?: string;
  /** 可执行定位（PATH / win-path）：直接 spawn 的绝对路径。 */
  executablePath?: string;
}

let cache: ResolvedApp[] | null = null;

export function resolveInstalledApps(): ResolvedApp[] {
  if (!cache)
    cache = APP_CATALOG.flatMap((entry) => probeEntry(entry)).filter(
      (a): a is ResolvedApp => a !== null,
    );
  return cache;
}

export function resolveEntryById(id: string): ResolvedApp | null {
  const cached = cache?.find((app) => app.id === id);
  if (cached) return cached;
  const entry = APP_CATALOG.find((e) => e.id === id);
  return entry ? probeEntry(entry) : null;
}

/** 启动后发现可执行文件没了（ENOENT）→ 单条目重解析并覆盖缓存。 */
export function reresolveEntry(id: string): ResolvedApp | null {
  const entry = APP_CATALOG.find((e) => e.id === id);
  if (!entry) return null;
  const fresh = probeEntry(entry);
  if (cache) {
    cache = cache.filter((app) => app.id !== id);
    if (fresh) cache.push(fresh);
  }
  return fresh;
}

function probeEntry(entry: AppCatalogEntry): ResolvedApp | null {
  const spec =
    process.platform === 'darwin'
      ? entry.darwin
      : process.platform === 'win32'
        ? entry.win32
        : entry.linux;
  if (!spec) return null;
  try {
    return probeSpec(entry, spec);
  } catch {
    return null; // 单条目探测失败（权限/注册表缺失等）＝未安装，不拖垮整表
  }
}

function probeSpec(entry: AppCatalogEntry, spec: LocateSpec): ResolvedApp | null {
  switch (spec.kind) {
    case 'app-bundle': {
      for (const base of darwinAppDirs()) {
        for (const name of spec.names) {
          const bundle = path.join(base, name);
          if (isDirectory(bundle))
            return { id: entry.id, label: entry.label, opens: entry.opens, bundlePath: bundle };
        }
      }
      return null;
    }
    case 'path': {
      for (const name of spec.names) {
        const exe = resolveOnPath(name);
        if (exe)
          return { id: entry.id, label: entry.label, opens: entry.opens, executablePath: exe };
      }
      return null;
    }
    case 'win-path': {
      const exe = path.join(os.homedir(), ...spec.rel.split('/'));
      return isFile(exe)
        ? { id: entry.id, label: entry.label, opens: entry.opens, executablePath: exe }
        : null;
    }
    case 'win-gui': {
      const exe = locateWinGui(spec);
      return exe
        ? { id: entry.id, label: entry.label, opens: entry.opens, executablePath: exe }
        : null;
    }
    case 'win-registry': {
      // reg query <key> 退出码 0 = 键存在（即安装过）
      const proc = spawnSync('reg', ['query', spec.key], { timeout: 5000 });
      return proc.status === 0 ? { id: entry.id, label: entry.label, opens: entry.opens } : null;
    }
    case 'desktop-entry': {
      for (const base of linuxApplicationDirs()) {
        for (const name of spec.names) {
          if (isFile(path.join(base, name)))
            return { id: entry.id, label: entry.label, opens: entry.opens };
        }
      }
      return null;
    }
  }
}

function darwinAppDirs(): string[] {
  return [
    '/Applications',
    '/System/Applications',
    '/System/Library/CoreServices',
    path.join(os.homedir(), 'Applications'),
  ];
}

function linuxApplicationDirs(): string[] {
  const dataDirs = (process.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share')
    .split(':')
    .filter(Boolean)
    .map((dir) => path.join(dir, 'applications'));
  return [path.join(os.homedir(), '.local/share/applications'), ...dataDirs];
}

/** 在 PATH 各目录下找可执行文件（X_OK），返回第一个命中的绝对路径。 */
function resolveOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 下一个目录
    }
  }
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
