// Windows GUI 装机探测。纯解析函数可在任意平台单测；真正的 IO 只在 win32 上跑。
//
// 不把安装路径写死在某个盘符上：本机 Cursor 在 D:\cursor、VS Code 在 D:\mccode、
// PyCharm 在 D:\Pcharm，固定的 %LOCALAPPDATA%\Programs\... 一条都对不上，
// 菜单里就只剩 PATH 上的 wt.exe（「终端」）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocateSpec } from './catalog.js';

export type WinGuiSpec = Extract<LocateSpec, { kind: 'win-gui' }>;

const SKIP_DIRS = new Set([
  'jbr',
  'jre',
  'node_modules',
  '.git',
  'plugins',
  'lib',
  'help',
  'cache',
  'caches',
  'logs',
  'temp',
  'tmp',
]);

/** `reg query /ve` 的 stdout 里取出 REG_SZ 的值（英文 (Default) / 中文 (默认) 都认）。 */
export function parseRegSz(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/REG_SZ\s+(.+?)\s*$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * 从 Cursor / VS Code 的 .cmd 垫片里找出 GUI exe。
 *
 * 两家都是这一句（`%~dp0` = 垫片所在目录）：
 *   "%~dp0..\..\..\Cursor.exe" "%~dp0..\out\cli.js" %*
 *   "%~dp0..\Code.exe" "...cli.js" %*
 * 也接受已经写成绝对路径的 `"D:\...\Code.exe"`。
 * 给出 exeNames 时只认名单里的文件名，避免垫片里先出现的别的 exe。
 */
export function guiExeFromShim(
  cmdText: string,
  cmdDir: string,
  exeNames?: readonly string[],
): string | null {
  const wanted =
    exeNames && exeNames.length > 0 ? new Set(exeNames.map((name) => name.toLowerCase())) : null;
  const resolved: string[] = [];
  for (const match of cmdText.matchAll(/"(%~dp0)?([^"\r\n]+?\.exe)"/gi)) {
    const raw = match[2]?.trim();
    if (!raw) continue;
    if (match[1]) {
      resolved.push(path.win32.normalize(path.win32.resolve(cmdDir, raw)));
      continue;
    }
    if (path.win32.isAbsolute(raw)) resolved.push(path.win32.normalize(raw));
  }
  if (wanted) {
    return (
      resolved.find((candidate) => wanted.has(path.win32.basename(candidate).toLowerCase())) ?? null
    );
  }
  return resolved[0] ?? null;
}

let shortcutCache: { name: string; target: string }[] | null = null;

/** 证明 spec 对应的 GUI 已安装，返回可直接 spawn 的 exe 绝对路径。非 win32 恒为 null。 */
export function locateWinGui(spec: WinGuiSpec): string | null {
  if (process.platform !== 'win32') return null;

  for (const name of spec.exeNames) {
    const fromReg = appPathFor(name);
    if (fromReg) return fromReg;
  }
  for (const name of spec.exeNames) {
    const fromPath = resolveOnPath(name);
    if (fromPath) return fromPath;
    if (name.toLowerCase() === 'explorer.exe') {
      const windir = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      const explorer = path.join(windir, 'explorer.exe');
      if (isFile(explorer)) return explorer;
    }
  }
  for (const name of spec.shimNames ?? []) {
    const shim = resolveOnPath(name);
    if (!shim) continue;
    let text: string;
    try {
      text = readShim(shim);
    } catch {
      continue;
    }
    const exe = guiExeFromShim(text, path.win32.dirname(shim), spec.exeNames);
    if (exe && isFile(exe)) return exe;
  }
  for (const rel of spec.relPaths ?? []) {
    for (const root of programRoots()) {
      const candidate = path.join(root, ...rel.split('/'));
      if (isFile(candidate)) return candidate;
    }
  }
  const wanted = new Set(spec.exeNames.map((name) => name.toLowerCase()));
  for (const rel of spec.searchRoots ?? []) {
    for (const root of expandSearchRoot(rel)) {
      const found = findExe(root, wanted, 5, { left: 400 });
      if (found) return found;
    }
  }
  return shortcutMatch(spec);
}

function appPathFor(exeName: string): string | null {
  if (!/^[\w.-]+$/.test(exeName)) return null;
  const keys = [
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
  ];
  for (const key of keys) {
    let stdout: Buffer;
    try {
      const proc = spawnSync('reg', ['query', key, '/ve'], {
        timeout: 5000,
        windowsHide: true,
      });
      if (proc.status !== 0 || !proc.stdout?.length) continue;
      stdout = proc.stdout;
    } catch {
      continue;
    }
    const value = parseRegSz(decodeConsole(stdout));
    if (value && isFile(value)) return value;
  }
  return null;
}

function programRoots(): string[] {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return [path.join(local, 'Programs'), pf, pf86];
}

function expandSearchRoot(rel: string): string[] {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const prefixed: [string, string][] = [
    ['%LOCALAPPDATA%/', local],
    ['%ProgramFiles%/', pf],
    ['%ProgramFiles(x86)%/', pf86],
  ];
  for (const [prefix, base] of prefixed) {
    if (rel.startsWith(prefix)) return [path.join(base, ...rel.slice(prefix.length).split('/'))];
  }
  return [local, pf, pf86].map((base) => path.join(base, ...rel.split('/')));
}

function resolveOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function readShim(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.includes(0)) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function decodeConsole(buf: Buffer): string {
  if (buf.length >= 2 && buf[1] === 0) return buf.toString('utf16le');
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function findExe(
  dir: string,
  names: ReadonlySet<string>,
  depth: number,
  budget: { left: number },
): string | null {
  if (depth < 0 || budget.left <= 0 || !isDirectory(dir)) return null;
  budget.left -= 1;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && names.has(entry.name.toLowerCase())) return path.join(dir, entry.name);
  }
  if (depth === 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
    const found = findExe(path.join(dir, entry.name), names, depth - 1, budget);
    if (found) return found;
  }
  return null;
}

function shortcutMatch(spec: WinGuiSpec): string | null {
  const hints = spec.shortcutHints ?? [];
  if (hints.length === 0) return null;
  const wanted = new Set(spec.exeNames.map((name) => name.toLowerCase()));
  let entries: { name: string; target: string }[];
  try {
    entries = startMenuShortcuts();
  } catch {
    return null;
  }
  for (const hint of hints) {
    const hintLower = hint.toLowerCase();
    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      if (name !== hintLower && !name.startsWith(`${hintLower} `)) continue;
      if (!wanted.has(path.win32.basename(entry.target).toLowerCase())) continue;
      if (isFile(entry.target)) return entry.target;
    }
  }
  return null;
}

function startMenuShortcuts(): { name: string; target: string }[] {
  if (shortcutCache) return shortcutCache;
  shortcutCache = [];
  const proc = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', START_MENU_SCRIPT],
    { timeout: 15000, windowsHide: true, encoding: 'utf8' },
  );
  if (proc.status !== 0 || !proc.stdout) return shortcutCache;
  shortcutCache = parseShortcutDump(proc.stdout);
  return shortcutCache;
}

/** 开始菜单快捷方式转储（脚本本体不含外部输入）。单对象和数组两种 JSON 都认。 */
export function parseShortcutDump(text: string): { name: string; target: string }[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  const entries: { name: string; target: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    const target = (item as { target?: unknown }).target;
    if (typeof name === 'string' && typeof target === 'string' && name && target) {
      entries.push({ name, target });
    }
  }
  return entries;
}

const START_MENU_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$shell = New-Object -ComObject WScript.Shell
$roots = @(
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs')
)
$items = @()
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $shortcut = $shell.CreateShortcut($_.FullName)
      if ($shortcut.TargetPath) {
        $items += [pscustomobject]@{ name = $_.BaseName; target = $shortcut.TargetPath }
      }
    } catch {}
  }
}
if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }
`.trim();

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
