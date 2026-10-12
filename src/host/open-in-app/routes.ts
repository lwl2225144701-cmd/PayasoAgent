// open-in-app 三路由 —— GET /open-in-app/apps、GET /open-in-app/icon/<id>、
// POST /open-in-app/open（detached 启动 + scrubbed 环境 + 早期失败观察窗）。
//
// 边界：前端只传 target id（封闭清单），工作区路径由 Host 解析（当前工作区或
// 指定 Run 的工作区，与 /preview 同一套作用域）——前端拿不到也传不进宿主绝对路径。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  bad,
  checkOrigin,
  notFound,
  RequestBodyTooLargeError,
  readBody,
  requireAuth,
  sendJson,
} from '../routes/route-context.js';
import type { RunManager } from '../run-manager.js';
import { getWorkspace } from '../workspace.js';
import {
  type ResolvedApp,
  reresolveEntry,
  resolveEntryById,
  resolveInstalledApps,
} from './resolver.js';

/** 早期失败观察窗：spawn 后等这么久，ENOENT/立即退出都算失败（可触发单条目重解析）。 */
const EARLY_FAILURE_WINDOW_MS = 300;

export async function handleOpenInApp(
  s: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  manager: RunManager,
  port: number,
): Promise<void> {
  checkOrigin(req, port);
  requireAuth(req);

  // GET /open-in-app/apps —— 已装应用列表（只含证明过的）
  if (s.length === 2 && s[1] === 'apps' && method === 'GET') {
    const apps = resolveInstalledApps().map((app) => ({ id: app.id, label: app.label }));
    return sendJson(res, 200, { apps });
  }

  // GET /open-in-app/icon/<id> —— macOS 从 .app 提 PNG（plutil + sips），进程内缓存
  if (s.length === 3 && s[1] === 'icon' && method === 'GET') {
    const id = s[2];
    const app = resolveEntryById(id) ?? reresolveEntry(id);
    const png = app?.bundlePath ? extractIconPng(id, app.bundlePath) : null;
    if (!png) return notFound(res);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(png);
    return;
  }

  // POST /open-in-app/open {id, runId?}
  if (s.length === 2 && s[1] === 'open' && method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return sendJson(res, 413, { error: 'payload_too_large' });
      }
      throw err;
    }
    const id = typeof body.id === 'string' ? body.id : '';
    const runId = typeof body.runId === 'string' && body.runId ? body.runId : null;
    if (!id) return bad(res, '缺少 id');
    const root = resolveWorkspaceRoot(manager, runId);
    if (!root) return bad(res, '没有可打开的工作区（未选择工作区且会话不存在）');
    try {
      await openRootInApp(id, root);
      return sendJson(res, 200, { opened: true, id });
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  }

  return notFound(res);
}

function resolveWorkspaceRoot(manager: RunManager, runId: string | null): string | null {
  if (runId) return manager.getWorkspaceRoot(runId);
  return getWorkspace()?.rootPath ?? null;
}

async function openRootInApp(id: string, root: string): Promise<void> {
  const app = resolveEntryById(id);
  if (!app) throw new Error('应用未安装或已卸载');
  try {
    await launch(app, root);
  } catch (err) {
    // 早期失败（典型：启动瞬间发现可执行文件没了）→ 单条目重解析后重试一次
    const fresh = reresolveEntry(id);
    if (!fresh) throw err instanceof Error ? err : new Error(String(err));
    await launch(fresh, root);
  }
}

async function launch(app: ResolvedApp, root: string): Promise<void> {
  if (process.platform === 'darwin') {
    if (app.bundlePath) {
      await observe(spawn('open', ['-a', app.bundlePath, root], { env: scrubbedEnv() }));
      return;
    }
    if (app.executablePath) {
      await observe(spawn(app.executablePath, [root], { cwd: root, env: scrubbedEnv() }));
      return;
    }
    throw new Error('该应用未提供可执行定位方式');
  }
  if (app.executablePath) {
    await observe(spawn(app.executablePath, [root], { cwd: root, env: scrubbedEnv() }));
    return;
  }
  // linux desktop-entry：交系统默认文件管理器打开目录（文档化简化）
  if (process.platform === 'linux') {
    await observe(spawn('xdg-open', [root], { env: scrubbedEnv() }));
    return;
  }
  throw new Error('当前平台无法启动该应用');
}

/** detached + scrubbed 环境 + 早期失败观察窗：窗口内 error/非零退出 → 失败。 */
function observe(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    child.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))));
    child.on('exit', (code) => {
      if (code !== 0) settle(new Error(`启动失败（exit ${code}）`));
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve();
      }
    }, EARLY_FAILURE_WINDOW_MS);
  });
}

/** scrubbed 环境：只透传运行外部 GUI 应用所需的最小集合，不继承 Host 全量环境。 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'XDG_DATA_DIRS',
    'SystemRoot',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ComSpec',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ---- 图标提取（darwin：plutil + sips 从 .app 提 PNG；按 id 进程内缓存） ----

const iconCache = new Map<string, Buffer | null>();

function extractIconPng(id: string, bundlePath: string): Buffer | null {
  if (iconCache.has(id)) return iconCache.get(id) ?? null;
  const png = extractIconPngUncached(bundlePath);
  iconCache.set(id, png);
  return png;
}

function extractIconPngUncached(bundlePath: string): Buffer | null {
  if (process.platform !== 'darwin') return null;
  const resources = path.join(bundlePath, 'Contents', 'Resources');
  // 1) Info.plist 的 CFBundleIconFile（老式）；缺省再扫 Resources 下第一个 .icns
  let icns: string | null = null;
  const plist = path.join(bundlePath, 'Contents', 'Info.plist');
  try {
    const proc = spawnSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', plist], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (proc.status === 0) {
      const name = proc.stdout.trim();
      if (name) {
        const withExt = name.endsWith('.icns') ? name : `${name}.icns`;
        const candidate = path.join(resources, withExt);
        if (fs.existsSync(candidate)) icns = candidate;
      }
    }
  } catch {
    // plutil 失败 → 走扫描兜底
  }
  if (!icns) {
    try {
      const first = fs
        .readdirSync(resources)
        .filter((name) => name.endsWith('.icns'))
        .sort()[0];
      icns = first ? path.join(resources, first) : null;
    } catch {
      return null;
    }
  }
  if (!icns || !fs.existsSync(icns)) return null;
  // 2) sips 转 PNG（临时目录缓存）
  const cacheDir = path.join(os.tmpdir(), 'payaso-openin-icons');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const out = path.join(cacheDir, `${path.basename(bundlePath, '.app')}.png`);
    if (!fs.existsSync(out)) {
      const proc = spawnSync('sips', ['-s', 'format', 'png', icns, '--out', out], {
        timeout: 10000,
      });
      if (proc.status !== 0 || !fs.existsSync(out)) return null;
    }
    return fs.readFileSync(out);
  } catch {
    return null;
  }
}
