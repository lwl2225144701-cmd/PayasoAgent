// open-in-app 客户端 controller —— 页面加载读一次、选择记 localStorage、
// 只做渲染与 POST：装机与否是 Host 的事实，这里不含任何平台逻辑。
import { jsonFetch } from '../api';

export interface OpenInApp {
  id: string;
  label: string;
  /** 32px PNG data URL（系统关联来源才有；白名单来源走 /icon/<id> 端点）。 */
  icon?: string;
  /** 是否默认应用（系统默认，或白名单来源的本地记忆）。 */
  isDefault?: boolean;
}

const SELECTED_KEY = 'payaso.openInApp';
/**
 * 按目标缓存（key = runId + 路径；'' = 工作区根/文件夹语义）。
 * TTL 让"展开菜单重查"成立：新装/改默认的应用很快能出现（对齐参考实现），
 * 同时同一文件连续打开不重复跑系统查询。
 */
const appsCache = new Map<string, { at: number; loaded: Promise<OpenInApp[]> }>();
const APPS_TTL_MS = 10_000;

/**
 * 能打开目标的应用列表（Host 按目标过滤后返回）。
 * path 缺省 = 工作区根本身（ShellBar 入口胶囊的语义）；给出 = 工作区内的某个文件
 * （预览面板文件视图的"在应用中打开"——PDF 只会列出浏览器/预览/访达之流）。
 */
export function listOpenInApps(path?: string | null, runId?: string | null): Promise<OpenInApp[]> {
  const key = `${runId ?? ''}|${path ?? ''}`;
  const cached = appsCache.get(key);
  if (cached && Date.now() - cached.at < APPS_TTL_MS) return cached.loaded;
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (runId) params.set('runId', runId);
  const query = params.toString();
  const loaded = jsonFetch<{ apps: OpenInApp[] }>(`/open-in-app/apps${query ? `?${query}` : ''}`, {
    cache: 'no-store',
  }).then((resp) => resp.apps);
  appsCache.set(key, { at: Date.now(), loaded });
  return loaded;
}

/** 失败后清缓存（下次打开重试）。 */
export function invalidateOpenInApps(): void {
  appsCache.clear();
}

/** 图标直链（macOS 由 Host 从 .app 提取 PNG；取不到 404，客户端回退字形芯片）。 */
export function openInAppIconUrl(id: string): string {
  return `/open-in-app/icon/${encodeURIComponent(id)}`;
}

export interface OpenInAppTarget {
  /** 要打开的目标：工作区相对路径（缺省 = 工作区根本身）。 */
  path?: string | null;
  /** 会话级作用域 Run（历史会话也能开它自己工作区里的文件）。 */
  runId?: string | null;
  /** 'reveal' = 在文件管理器里显示目标（不打开）。 */
  action?: 'reveal';
}

/**
 * 打开目标：path 给出时开工作区内的某个文件（id = 系统关联列表里的 .app 路径，
 * 宿主打开前会用最新列表复验），否则开工作区根（id = 白名单应用 id）。
 * `action: 'reveal'` = 在文件管理器里显示该文件而不打开它。
 */
export function openInApp(
  id: string,
  target: OpenInAppTarget = {},
): Promise<{ opened: boolean; id: string }> {
  return jsonFetch('/open-in-app/open', {
    method: 'POST',
    body: JSON.stringify({
      id,
      ...(target.action ? { action: target.action } : {}),
      ...(target.path ? { path: target.path } : {}),
      ...(target.runId ? { runId: target.runId } : {}),
    }),
    cache: 'no-store',
  });
}

/** 默认应用：localStorage 记忆优先，否则列表第一个（与 macOS「访达（默认）」同语义）。 */
export function defaultAppId(apps: readonly OpenInApp[]): string | null {
  return getSelectedAppId() ?? apps[0]?.id ?? null;
}

export function getSelectedAppId(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export function setSelectedAppId(id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    // 隐私模式等写不进场景：选择不持久化，功能不受影响
  }
}
