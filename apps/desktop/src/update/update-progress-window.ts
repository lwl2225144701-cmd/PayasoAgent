// 安装器启动前的过渡窗（Windows）。
//
// 背景（v0.4.23 实机验收，2026-10-29）：静默 NSIS 安装实测要 3 分 48 秒。这期间
// Electron 已经退出、桌面图标在位，但屏幕上没有任何反馈 —— 用户等不到一分钟就
// 认定更新失败并手动启动，而手动启动也成功，于是"自动重启"被记成"没生效"。
// 本模块在 spawn 安装器之前弹出 update-progress.ps1 过渡窗补上这段可见状态。
//
// 不 import electron：本模块会被 src/update/windows-installer.ts 带入纯 Node 单测
// （tests/desktop-update.test.ts），那里 process.resourcesPath 是 undefined，
// 正好当作"未打包/无脚本"的门禁。locale 用 Intl 取，不依赖 app.getLocale()。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface UpdateProgressMessages {
  title: string;
  message: string;
  caption: string;
}

const MESSAGES: Record<string, UpdateProgressMessages> = {
  'zh-cn': {
    title: '正在安装更新',
    message: '更新即将完成，应用将自动重启，请稍候...',
    caption: '正在安装...',
  },
  'zh-tw': {
    title: '正在安裝更新',
    message: '更新即將完成，應用將自動重啟，請稍候...',
    caption: '正在安裝...',
  },
  'en-us': {
    title: 'Installing Update',
    message: 'The update is almost done. The app will restart automatically...',
    caption: 'Installing...',
  },
};

const FALLBACK = MESSAGES['en-us'];

/** 中文系统用中文文案，其余用英文；locale 缺省时按系统区域推断。 */
export function updateProgressMessages(locale?: string): UpdateProgressMessages {
  const tag = (locale ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase();
  return MESSAGES[tag] ?? (tag.startsWith('zh') ? MESSAGES['zh-cn'] : FALLBACK);
}

/** 过渡窗脚本位于 <resourcesPath>/scripts/；未打包或资源缺失时返回 null。 */
export function resolveUpdateProgressScripts(
  resourcesPath: string | undefined,
): { script: string; launcher: string } | null {
  if (!resourcesPath) return null;
  const dir = path.join(resourcesPath, 'scripts');
  const script = path.join(dir, 'update-progress.ps1');
  const launcher = path.join(dir, 'launch-update-progress.vbs');
  return existsSync(script) && existsSync(launcher) ? { script, launcher } : null;
}

function resolveWscriptPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'wscript.exe');
  if (existsSync(candidate)) return candidate;
  return 'wscript.exe';
}

export interface SpawnUpdateProgressWindowOptions {
  /** 正在启动的安装器路径，仅用于轮询它的进程名判断安装是否结束。 */
  installerPath: string;
  /** process.resourcesPath；缺省（未打包）时直接跳过。 */
  resourcesPath?: string;
  /** 新应用的进程名（不含 .exe），用于识别"新主窗口已就绪"。 */
  appProcessName?: string;
  /** 旧应用 PID，避免把还没退干净的旧窗口当成新就绪。 */
  oldAppProcessId?: number;
  locale?: string;
  spawnProcess?: typeof spawn;
  log?: (message: string) => void;
}

/**
 * 弹出过渡窗。任何失败只记录不抛出：它是体验增强，不能反过来阻断更新安装。
 */
export function spawnUpdateProgressWindow(options: SpawnUpdateProgressWindowOptions): void {
  const log = options.log ?? (() => {});
  if (process.platform !== 'win32') return;
  const scripts = resolveUpdateProgressScripts(options.resourcesPath);
  if (!scripts) {
    log('[update-progress] scripts not packaged, skipping transition window');
    return;
  }
  const appProcessName =
    options.appProcessName ?? path.basename(process.execPath, path.extname(process.execPath));
  const messages = updateProgressMessages(options.locale);
  const args = [
    scripts.script,
    '-InstallerPath',
    options.installerPath,
    '-AppProcessName',
    appProcessName,
    '-OldAppProcessId',
    String(options.oldAppProcessId ?? process.pid),
    '-Title',
    messages.title,
    '-Message',
    messages.message,
    '-Caption',
    messages.caption,
    '-TimeoutSeconds',
    '120',
  ];
  try {
    const child = (options.spawnProcess ?? spawn)(
      resolveWscriptPath(),
      [scripts.launcher, ...args],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: os.tmpdir(),
      },
    );
    child.on('error', (error: Error) => log(`[update-progress] spawn failed: ${error.message}`));
    child.unref();
    log(`[update-progress] transition window spawned pid=${child.pid ?? 'unknown'}`);
  } catch (error) {
    log(`[update-progress] spawn threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
