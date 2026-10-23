import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRightIcon, RefreshIcon } from '../../components/icons';
import { useI18n } from '../../i18n';
import { isHttpUrl, normalizeBrowserUrl } from '../browser-url';
import styles from './WebBrowser.module.css';

type GuestWebview = HTMLElement & {
  loadURL: (url: string) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
};

function guestWebviewAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('webview');
  return typeof (probe as Partial<GuestWebview>).loadURL === 'function';
}

// 访客页方法（goBack/goForward/reload）在 dom-ready 之前调用同样会抛
// （Electron 契约，内部走 getWebContentsId）。按钮操作失败只是没反应，
// 但不能让它冒到 React 外把整棵树带崩。
function guestCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // 访客页还没就绪；did-navigate/did-stop-loading 会同步按钮状态
  }
}

/** Host / 快捷键注入一次导航；nonce 变化即再导航（同 URL 也生效）。 */
export type BrowserLaunch = { url: string; nonce: number };

export function WebBrowser({ launch = null }: { launch?: BrowserLaunch | null }) {
  const { t } = useI18n();
  const guest = useState(guestWebviewAvailable)[0];
  const webviewRef = useRef<GuestWebview | null>(null);
  const setWebview = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as GuestWebview | null;
  }, []);
  const [draft, setDraft] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const appliedLaunch = useRef(0);
  const [invalid, setInvalid] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const frameHistory = useRef<string[]>([]);
  const frameIndex = useRef(-1);

  // 导航模型（Electron 44.6.0 实测）：
  //   1. <webview> 必须带 src 属性才会创建访客页 —— 无 src 的 webview 永远
  //      不初始化（dom-ready 不发），“先建空 webview 再 loadURL”是死路。
  //   2. src 属性随 current 走：创建即加载；current 变化 → React 更新属性
  //      → Electron 自动导航。这是主通道，别再在 effect 里 loadURL（双加载）。
  //   3. loadURL 只服务一个边角：访客内部跳转后 current 滞后、用户又输入
  //      原网址（值没变 React 不会更新属性）—— 见 open()。
  //   4. 访客方法（goBack/goForward/reload/loadURL）一律走 guestCall：
  //      dom-ready 前调用会抛，异常冒泡曾把整棵树崩进 ErrorBoundary。

  // current 必须留在依赖里：webview 只有打开网址后才挂上，只写 guest 会在节点出现前返回。
  // biome-ignore lint/correctness/useExhaustiveDependencies: webview 节点随 current 才挂载
  useEffect(() => {
    const el = webviewRef.current;
    if (!guest || !el) return;
    const sync = () => {
      try {
        const url = el.getURL();
        if (url && isHttpUrl(url)) setDraft(url);
        setCanBack(el.canGoBack());
        setCanForward(el.canGoForward());
        setReady(true);
      } catch {
        // 访客页还没挂上时 getURL 会抛，下一帧导航事件会再同步。
      }
    };
    const start = () => setLoadFailed(false);
    const fail = (event: Event) => {
      const failure = event as Event & { errorCode?: number; isMainFrame?: boolean };
      // -3 是用户切换地址/前后导航造成的取消，不当作加载失败。
      if (failure.isMainFrame !== false && failure.errorCode !== -3) setLoadFailed(true);
    };
    const names = [
      'dom-ready',
      'did-navigate',
      'did-navigate-in-page',
      'did-stop-loading',
    ] as const;
    for (const name of names) el.addEventListener(name, sync);
    el.addEventListener('did-start-loading', start);
    el.addEventListener('did-fail-load', fail);
    return () => {
      for (const name of names) el.removeEventListener(name, sync);
      el.removeEventListener('did-start-loading', start);
      el.removeEventListener('did-fail-load', fail);
    };
  }, [guest, current]);

  const rememberFrame = (url: string) => {
    const history = frameHistory.current.slice(0, frameIndex.current + 1);
    history.push(url);
    frameHistory.current = history;
    frameIndex.current = history.length - 1;
    setCanBack(frameIndex.current > 0);
    setCanForward(false);
  };

  // Host / 快捷键注入的地址：nonce 变化即导航（同 URL 再推也要生效）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: rememberFrame 只写 ref
  useEffect(() => {
    if (!launch || launch.nonce === appliedLaunch.current) return;
    appliedLaunch.current = launch.nonce;
    const next = normalizeBrowserUrl(launch.url);
    if (!next) return;
    setInvalid(false);
    setLoadFailed(false);
    setDraft(next);
    setCurrent(next);
    if (!guest) rememberFrame(next);
  }, [launch, guest]);

  const open = (raw: string) => {
    const next = normalizeBrowserUrl(raw);
    if (!next) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setLoadFailed(false);
    setDraft(next);
    if (guest) {
      // 访客页的真实地址才是事实：内部跳转（点链接）后 current 会滞后，
      // 拿 state 判断“是不是已经在目标址”会误判。
      let actual = '';
      try {
        actual = webviewRef.current?.getURL() ?? '';
      } catch {
        // 访客页还没就绪时 getURL 会抛 —— 按“不在目标址”处理
      }
      if (next === actual) {
        // 就在目标址上（浏览器习惯：回车 = 刷新）。state 滞后就让 src 属性
        // 追平（Electron 据此导航）；已平则主动 reload。
        if (next !== current) setCurrent(next);
        else guestCall(() => webviewRef.current?.reload());
        return;
      }
      if (next === current) {
        // 输入等于 state 但访客实际不在该址 —— 等 src 属性变化是等不来的
        // （值没变 React 不会更新属性），直接加载。
        guestCall(() => webviewRef.current?.loadURL(next));
        return;
      }
      setCurrent(next);
      return;
    }
    // iframe 降级路径：跨域 sandbox iframe 的内部位置父页拿不到，输入等于
    // current 时换 key 重挂载 —— 既刷新，也修“内部跳转后输原网址不动”。
    if (next === current) {
      setFrameKey((value) => value + 1);
      return;
    }
    setCurrent(next);
    rememberFrame(next);
  };

  const goBack = () => {
    if (guest) {
      guestCall(() => webviewRef.current?.goBack());
      return;
    }
    if (frameIndex.current <= 0) return;
    frameIndex.current -= 1;
    const url = frameHistory.current[frameIndex.current] ?? null;
    setCurrent(url);
    if (url) setDraft(url);
    setCanBack(frameIndex.current > 0);
    setCanForward(frameIndex.current < frameHistory.current.length - 1);
  };

  const goForward = () => {
    if (guest) {
      guestCall(() => webviewRef.current?.goForward());
      return;
    }
    if (frameIndex.current >= frameHistory.current.length - 1) return;
    frameIndex.current += 1;
    const url = frameHistory.current[frameIndex.current] ?? null;
    setCurrent(url);
    if (url) setDraft(url);
    setCanBack(frameIndex.current > 0);
    setCanForward(frameIndex.current < frameHistory.current.length - 1);
  };

  return (
    <div className={styles.root}>
      <form
        className={styles.toolbar}
        onSubmit={(event) => {
          event.preventDefault();
          open(draft);
        }}
      >
        <button
          type="button"
          className={styles.toolBtn}
          onClick={goBack}
          disabled={!canBack}
          aria-label={t('preview.browser.back')}
        >
          <ChevronRightIcon size={16} className={styles.backIcon} />
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={goForward}
          disabled={!canForward}
          aria-label={t('preview.browser.forward')}
        >
          <ChevronRightIcon size={16} />
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() => {
            if (guest) guestCall(() => webviewRef.current?.reload());
            else if (current) setFrameKey((value) => value + 1);
          }}
          disabled={!current || (guest && !ready)}
          aria-label={t('preview.browser.reload')}
        >
          <RefreshIcon size={15} />
        </button>
        <input
          className={styles.address}
          value={draft}
          placeholder={t('preview.browser.addressPlaceholder')}
          aria-label={t('preview.browser.address')}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
        />
      </form>
      {invalid && <p className={styles.error}>{t('preview.browser.invalid')}</p>}
      {loadFailed && <p className={styles.error}>{t('preview.browser.loadFailed')}</p>}
      <div className={styles.stage}>
        {current && guest
          ? createElement('webview', {
              ref: setWebview,
              className: styles.guest,
              partition: 'persist:payaso-browser',
              src: current,
            })
          : null}
        {current && !guest ? (
          <iframe
            key={frameKey}
            className={styles.guest}
            title={t('preview.browser.frame')}
            src={current}
            // allow-same-origin 必须有：没有它沙箱 iframe 是不透明源（origin=null），
            // Vite 产物的 <script crossorigin>/<link crossorigin> 会被 CORS 拦死 ——
            // 项目自己的 Web 端、任何 Vite dev server 在里面都打不开（打不开 =
            // 只有 HTML 骨架，无样式无脚本）。仍然不给 allow-top-navigation
            // （页面不能把整个应用导航走）/ allow-modals / allow-downloads。
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
          />
        ) : null}
        {!current && <p className={styles.empty}>{t('preview.browser.empty')}</p>}
      </div>
    </div>
  );
}
