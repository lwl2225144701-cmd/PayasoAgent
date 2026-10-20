import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRightIcon, RefreshIcon } from '../../components/icons';
import { useI18n } from '../../i18n';
import { isHttpUrl, normalizeBrowserUrl } from '../browser-url';
import styles from './WebBrowser.module.css';

type GuestWebview = HTMLElement & {
  loadURL: (url: string) => void;
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

export function WebBrowser() {
  const { t } = useI18n();
  const guest = useState(guestWebviewAvailable)[0];
  const webviewRef = useRef<GuestWebview | null>(null);
  const setWebview = useCallback((node: HTMLElement | null) => {
    webviewRef.current = node as GuestWebview | null;
  }, []);
  const [draft, setDraft] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const frameHistory = useRef<string[]>([]);
  const frameIndex = useRef(-1);

  useEffect(() => {
    const el = webviewRef.current;
    if (!guest || !el || !current) return;
    let loaded = '';
    try {
      loaded = el.getURL();
    } catch {
      loaded = '';
    }
    if (loaded !== current) el.loadURL(current);
  }, [current, guest]);

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
      } catch {
        // 访客页还没挂上时 getURL 会抛，下一帧导航事件会再同步。
      }
    };
    const block = (event: Event) => {
      const url = (event as Event & { url?: string }).url ?? '';
      if (!isHttpUrl(url)) event.preventDefault();
    };
    const names = ['did-navigate', 'did-navigate-in-page', 'did-stop-loading'] as const;
    for (const name of names) el.addEventListener(name, sync);
    el.addEventListener('will-navigate', block);
    return () => {
      for (const name of names) el.removeEventListener(name, sync);
      el.removeEventListener('will-navigate', block);
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

  const open = (raw: string) => {
    const next = normalizeBrowserUrl(raw);
    if (!next) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(next);
    setCurrent(next);
    if (!guest) rememberFrame(next);
  };

  const goBack = () => {
    if (guest) {
      webviewRef.current?.goBack();
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
      webviewRef.current?.goForward();
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
            if (guest) webviewRef.current?.reload();
            else if (current) setFrameKey((value) => value + 1);
          }}
          disabled={!current}
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
      <div className={styles.stage}>
        {current && guest
          ? createElement('webview', {
              ref: setWebview,
              className: styles.guest,
              partition: 'persist:payaso-browser',
            })
          : null}
        {current && !guest ? (
          <iframe
            key={frameKey}
            className={styles.guest}
            title={t('preview.browser.frame')}
            src={current}
            sandbox="allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
          />
        ) : null}
        {!current && <p className={styles.empty}>{t('preview.browser.empty')}</p>}
      </div>
    </div>
  );
}
