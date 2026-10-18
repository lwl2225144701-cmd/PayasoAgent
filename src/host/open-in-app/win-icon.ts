// 从 Windows exe 提取关联图标（32px PNG）。菜单要的是真图标，不是字形芯片。
// 路径只经环境变量进 PowerShell，不拼进命令行。按 id 进程内缓存，失败记 null。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cache = new Map<string, Buffer | null>();

export function extractWinIconPng(id: string, executablePath: string): Buffer | null {
  if (process.platform !== 'win32') return null;
  if (cache.has(id)) return cache.get(id) ?? null;
  const png = extractUncached(executablePath);
  cache.set(id, png);
  return png;
}

function extractUncached(executablePath: string): Buffer | null {
  const out = path.join(os.tmpdir(), `payaso-openin-icon-${process.pid}-${Date.now()}.png`);
  try {
    const proc = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', EXTRACT_SCRIPT],
      {
        timeout: 8000,
        windowsHide: true,
        env: {
          ...process.env,
          PAYASO_ICON_EXE: executablePath,
          PAYASO_ICON_OUT: out,
        },
      },
    );
    if (proc.status !== 0 || !fs.existsSync(out)) return null;
    return fs.readFileSync(out);
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      // 临时文件留在 tmp 也无害
    }
  }
}

const EXTRACT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$exe = $env:PAYASO_ICON_EXE
$out = $env:PAYASO_ICON_OUT
if ([string]::IsNullOrWhiteSpace($exe) -or [string]::IsNullOrWhiteSpace($out)) { exit 2 }
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
if ($null -eq $icon) { exit 3 }
$bmp = $icon.ToBitmap()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$icon.Dispose()
`.trim();
