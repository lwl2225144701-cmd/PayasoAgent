// open-in-app 客户端 controller —— 页面加载读一次、选择记 localStorage、
// 只做渲染与 POST：装机与否是 Host 的事实，这里不含任何平台逻辑。
import { jsonFetch } from '../api';

export interface OpenInApp {
  id: string;
  label: string;
}

const SELECTED_KEY = 'payaso.openInApp';
let appsPromise: Promise<OpenInApp[]> | null = null;

/** 应用列表（每页载只拉一次；失败后下次打开菜单会重试）。 */
export function listOpenInApps(): Promise<OpenInApp[]> {
  if (appsPromise === null) {
    const loaded = jsonFetch<{ apps: OpenInApp[] }>('/open-in-app/apps', {
      cache: 'no-store',
    }).then((resp) => resp.apps);
    appsPromise = loaded;
  }
  return appsPromise;
}

/** 失败后重置缓存（下次打开菜单重试）。 */
export function invalidateOpenInApps(): void {
  appsPromise = null;
}

/** 图标直链（macOS 由 Host 从 .app 提取 PNG；取不到 404，客户端回退字形芯片）。 */
export function openInAppIconUrl(id: string): string {
  return `/open-in-app/icon/${encodeURIComponent(id)}`;
}

export function openInApp(
  id: string,
  runId?: string | null,
): Promise<{ opened: boolean; id: string }> {
  return jsonFetch('/open-in-app/open', {
    method: 'POST',
    body: JSON.stringify({ id, ...(runId ? { runId } : {}) }),
    cache: 'no-store',
  });
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
