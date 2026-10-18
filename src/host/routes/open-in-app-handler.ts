// open-in-app 路由 —— GET /open-in-app/apps、GET /open-in-app/icon/<id>、
// POST /open-in-app/open（detached 启动 + scrubbed 环境 + 早期失败观察窗）。
//
// 两种目标、两套数据源（对齐参考实现）：
//   - **文件**（path 给出）：每次现问操作系统（macOS LaunchServices，见 os-assoc.ts）——
//     文件与应用的关联是系统事实，静态清单只会猜错（PDF 菜单里出现 Cursor 那种）；
//   - **目录**（path 缺省）：编译期白名单（catalog.ts）——系统没有"用某 App 打开
//     目录"的统一关联机制。
//
// 边界：前端只传 target id 与工作区相对路径，工作区根由 Host 解析（当前工作区或
// 指定 Run 的工作区，与 /preview 同一套作用域）——前端拿不到也传不进宿主绝对路径。
import { spawn, spawnSync } from 'node:child_process';
import fs, { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildLaunchInvocation } from '../open-in-app/invocation.js';
import { filterAppsForTarget } from '../open-in-app/openable.js';
import { queryFileAssociations } from '../open-in-app/os-assoc.js';
import {
  type ResolvedApp,
  reresolveEntry,
  resolveEntryById,
  resolveInstalledApps,
} from '../open-in-app/resolver.js';
import { normalizeRelPath, resolveChecked } from '../preview/preview-service.js';
import { PreviewError } from '../preview/types.js';
import type { RunManager } from '../run-manager.js';
import { getWorkspace } from '../workspace.js';
import {
  bad,
  checkOrigin,
  notFound,
  RequestBodyTooLargeError,
  readBody,
  requireAuth,
  sendJson,
} from './route-context.js';

function queryParams(req: IncomingMessage): URLSearchParams {
  return new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
}

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

  // GET /open-in-app/apps[?path=<rel>[&runId=<id>]] —— 能打开目标的应用列表。
  // path 给出 = 文件目标：问操作系统（LaunchServices），拿到"真能打开它"的应用；
  //   系统不可用/非 macOS → 回落白名单（openable.ts 按后缀过滤）。
  // path 缺省 = 目录目标（工作区根）：编译期白名单里能打开文件夹的应用。
  if (s.length === 2 && s[1] === 'apps' && method === 'GET') {
    const params = queryParams(req);
    const rel = params.get('path');
    const target = rel !== null && rel.length > 0 ? rel : null;
    const root = resolveWorkspaceRoot(manager, paramRunId(params));

    if (target !== null && root !== null) {
      const abs = resolveInside(root, target);
      if (abs !== null) {
        const osApps = await queryFileAssociations(abs);
        if (osApps !== null) {
          return sendJson(res, 200, {
            source: 'os',
            apps: osApps.map((app) => ({
              id: app.id,
              label: app.label,
              icon: app.icon,
              isDefault: app.isDefault,
            })),
          });
        }
      }
    }

    const apps = filterAppsForTarget(resolveInstalledApps(), target).map((app) => ({
      id: app.id,
      label: app.label,
      opens: app.opens,
    }));
    return sendJson(res, 200, { source: 'catalog', apps });
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

  // POST /open-in-app/open {id?, path?, runId?, action?}
  //   action: 'reveal'  = 在文件管理器里显示该文件（path 必填；不打开文件本身）
  //   path 给出          = 打开工作区内的某个文件：id 必须是**最新**系统关联列表里的
  //                       .app 路径（打开前复验，伪造/陈旧的 id 拒掉）
  //   path 缺省          = 打开工作区根：id 是白名单（catalog）里的应用 id
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
    const action = body.action === 'reveal' ? 'reveal' : null;
    const rel = typeof body.path === 'string' ? body.path.trim() : '';
    if (!id && action === null) return bad(res, '缺少 id');
    if (action === 'reveal' && !rel) return bad(res, '显示文件位置需要 path');
    const root = resolveWorkspaceRoot(manager, paramRunId(body));
    if (!root) return bad(res, '没有可打开的工作区（未选择工作区且会话不存在）');
    // 目标路径：与 /preview 读文件同一套越界校验（单一实现，防 symlink/穿越）
    let target = root;
    if (rel) {
      const abs = resolveInside(root, rel);
      if (abs === null) return bad(res, '路径越出工作区或无效');
      target = abs;
    }
    try {
      if (action === 'reveal') {
        await revealPath(target);
        return sendJson(res, 200, { opened: true });
      }
      if (rel) {
        // 文件目标：用最新系统列表复验 id（应用可能已卸载/关联已变）
        const fresh = await queryFileAssociations(target);
        const match = fresh?.find((app) => app.id === id);
        if (!match) return bad(res, '该应用不能打开此文件（或已卸载）');
        await launch({ bundlePath: match.id }, target);
        return sendJson(res, 200, { opened: true, id });
      }
      await openPathInApp(id, target);
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

/** 查询串 / 请求体里的 runId（空串按缺省处理）。 */
function paramRunId(source: URLSearchParams | Record<string, unknown>): string | null {
  const raw = source instanceof URLSearchParams ? source.get('runId') : source.runId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** 工作区内相对路径 → 绝对路径；越界/无效返回 null（不抛，供 GET 端点静默回落）。 */
function resolveInside(root: string, rel: string): string | null {
  try {
    return resolveChecked(root, normalizeRelPath(rel));
  } catch (err) {
    if (err instanceof PreviewError) return null;
    throw err;
  }
}

/** 在文件管理器里显示目标（不打开它）。explorer 的退出码不可靠，只认 spawn 错误。 */
async function revealPath(target: string): Promise<void> {
  if (process.platform === 'darwin') {
    await observe(spawn('open', ['-R', target], { env: scrubbedEnv() }));
    return;
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('explorer', [`/select,${target}`], { env: scrubbedEnv() });
      child.on('error', reject);
      child.on('spawn', resolve);
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('xdg-open', [path.dirname(target)], { env: scrubbedEnv() });
    child.on('error', reject);
    child.on('spawn', resolve);
  });
}

/** 用指定应用打开一个路径（工作区根本身，或工作区内的某个文件）。 */
async function openPathInApp(id: string, target: string): Promise<void> {
  const app = resolveEntryById(id);
  if (!app) throw new Error('应用未安装或已卸载');
  try {
    await launch(app, target);
  } catch (err) {
    // 早期失败（典型：启动瞬间发现可执行文件没了）→ 单条目重解析后重试一次
    const fresh = reresolveEntry(id);
    if (!fresh) throw err instanceof Error ? err : new Error(String(err));
    await launch(fresh, target);
  }
}

/**
 * 启动目标路径（结构最小化：只有定位方式参与启动，白名单/系统 id 都满足）。
 *
 * 参数与 cwd 的推导走 `buildLaunchInvocation`（纯函数，套件覆盖）：Windows Terminal
 * 把裸路径当命令执行会报 0x80070005（真机踩过），且文件目标不能拿文件当 cwd。
 */
async function launch(
  app: { id?: string; bundlePath?: string; executablePath?: string },
  target: string,
): Promise<void> {
  if (process.platform === 'darwin' && app.bundlePath) {
    await observe(spawn('open', ['-a', app.bundlePath, target], { env: scrubbedEnv() }));
    return;
  }
  if (app.executablePath) {
    const targetIsDirectory = isDirectory(target);
    const { args, cwd } = buildLaunchInvocation({
      appId: app.id ?? '',
      executablePath: app.executablePath,
      target,
      platform: process.platform,
      targetIsDirectory,
    });
    await observe(spawn(app.executablePath, args, { cwd, env: scrubbedEnv() }));
    return;
  }
  if (process.platform === 'darwin') throw new Error('该应用未提供可执行定位方式');
  // linux desktop-entry：交系统默认文件管理器打开目录（文档化简化）
  if (process.platform === 'linux') {
    await observe(spawn('xdg-open', [target], { env: scrubbedEnv() }));
    return;
  }
  throw new Error('当前平台无法启动该应用');
}

/** stat 判定目录；失败一律按"不是目录"（宁可 cwd 取父目录，也不要传个不存在的目录）。 */
function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
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
