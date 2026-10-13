// open-in-app 客户端 controller —— 页面加载读一次、选择记 localStorage、
// 只做渲染与 POST：装机与否是 Host 的事实，这里不含任何平台逻辑。
import { jsonFetch } from '../api';

export interface OpenInApp {
  id: string;
  label: string;
}

const SELECTED_KEY = 'payaso.openInApp';
/** 按目标缓存（key = 路径；'' = 工作区根/文件夹语义）。 */
const appsCache = new Map<string, Promise<OpenInApp[]>>();

/**
 * 能打开目标的应用列表（Host 按目标过滤后返回）。
 * path 缺省 = 工作区根本身（ShellBar 入口胶囊的语义）；给出 = 工作区内的某个文件
 * （预览面板文件视图的"在应用中打开"——PDF 只会列出浏览器/预览/访达之流）。
 */
export function listOpenInApps(path?: string | null): Promise<OpenInApp[]> {
  const key = path ?? '';
  let loaded = appsCache.get(key);
  if (loaded === undefined) {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    loaded = jsonFetch<{ apps: OpenInApp[] }>(`/open-in-app/apps${query}`, {
      cache: 'no-store',
    }).then((resp) => resp.apps);
    appsCache.set(key, loaded);
  }
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
}

/** 打开目标：path 给出时开工作区内的某个文件，否则开工作区根。 */
export function openInApp(
  id: string,
  target: OpenInAppTarget = {},
): Promise<{ opened: boolean; id: string }> {
  return jsonFetch('/open-in-app/open', {
    method: 'POST',
    body: JSON.stringify({
      id,
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
