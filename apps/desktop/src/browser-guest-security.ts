// 内嵌网页的限制必须由主进程执行；webview DOM 事件的 preventDefault 不会阻止导航。
import type { Session, WebContents } from 'electron';

export const BROWSER_PARTITION = 'persist:payaso-browser';

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function installBrowserGuestSecurity(
  host: Pick<WebContents, 'on'>,
  guestSession: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
): void {
  // 只作用于访客分区；不修改主界面的权限处理。
  guestSession.setPermissionCheckHandler(() => false);
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  host.on('will-attach-webview', (event, preferences, params) => {
    if (params.partition !== BROWSER_PARTITION || !isWebUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.nodeIntegrationInWorker = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    preferences.allowRunningInsecureContent = false;
    preferences.webviewTag = false;
  });

  host.on('did-attach-webview', (_event, guest) => {
    const blockNonWebUrl = (event: { preventDefault(): void }, url: string) => {
      if (!isWebUrl(url)) event.preventDefault();
    };
    guest.on('will-navigate', blockNonWebUrl);
    guest.on('will-redirect', blockNonWebUrl);
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
