// AppMenu：顶栏左侧的「应用」菜单（Windows 桌面壳专属）。
//
// 背景：Windows 的窗口是无边框的（titleBarStyle: 'hidden'），Electron 不挂原生菜单栏
// （实测 GetMenu(hwnd)=0），所以「关于 / 检查更新… / 退出」只能自绘。macOS 走系统菜单栏，
// 这里渲染前先用 canShowAppMenu() 判平台；浏览器直开时没有桥，整块不出现。
//
// 结构照搬 OpenInAppMenu 的既有配方：菜单 portal 到 portalRoot()、useLayoutEffect 定位、
// useClickOutside + useEscapeKey 关闭；「关于」复用 Modal。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type AppInfo,
  canShowAppMenu,
  checkForUpdates,
  quitApp,
  readAppInfo,
} from '../../app-menu';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useI18n } from '../../i18n';
import { portalRoot } from '../../portal-root';
import { IDLE_UPDATE_STATUS, subscribeUpdateStatus, type UpdateStatus } from '../../update-status';
import { Modal } from '../Modal';
import styles from './AppMenu.module.css';

const MENU_WIDTH = 208;

/**
 * `variant`：
 * - `window`：fixed 在窗口最顶一行、横跨整个窗口（侧栏展开时用；DSH 同款）；
 * - `row`：嵌在调用方给出的第一行容器里（侧栏收起时，与「展开侧栏」按钮同行）；
 * - `inline`：嵌在别的行里（默认）。
 */
export function AppMenu({ variant = 'inline' }: { variant?: 'window' | 'row' | 'inline' }) {
  const { t } = useI18n();
  const enabled = canShowAppMenu();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [status, setStatus] = useState<UpdateStatus>(IDLE_UPDATE_STATUS);
  const [info, setInfo] = useState<AppInfo | null>(null);

  // 更新状态与版本信息只在菜单可见时才需要，但钩子必须无条件调用（Hooks 规则）。
  useEffect(() => subscribeUpdateStatus(setStatus), []);
  useEffect(() => {
    let cancelled = false;
    void readAppInfo().then((value) => {
      if (!cancelled) setInfo(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEscapeKey(open, () => setOpen(false));
  // 触发按钮要忽略：点它自己交给 onClick 做 toggle，否则会先关再开。
  useClickOutside(menuRef, open, () => setOpen(false), anchorRef);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
    });
  }, [open]);

  if (!enabled) return null;

  const busy =
    status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'installing';
  const checkLabel =
    status.phase === 'checking' ? t('shell.menu.checking') : t('shell.menu.checkUpdate');
  const version = info?.version ? `v${info.version}` : '';

  return (
    <span
      className={`${styles.wrap} ${variant === 'window' ? styles.wrapWindow : ''} ${
        variant === 'row' ? styles.wrapRow : ''
      }`}
      {...(variant === 'window' ? { 'data-app-menu-bar': '' } : {})}
    >
      <button
        ref={anchorRef}
        type="button"
        className={`${styles.trigger} ${variant === 'window' || variant === 'row' ? styles.triggerWindow : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t('shell.menu.app')}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.menu}
            role="menu"
            aria-label={t('shell.menu.app')}
            style={
              pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }
            }
          >
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                setAboutOpen(true);
              }}
            >
              {t('shell.menu.about')}
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                void checkForUpdates();
              }}
            >
              {checkLabel}
            </button>
            <hr className={styles.separator} />
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                setOpen(false);
                quitApp();
              }}
            >
              {t('shell.menu.quit')}
            </button>
          </div>,
          portalRoot(),
        )}

      {aboutOpen && (
        <Modal
          onClose={() => setAboutOpen(false)}
          ariaLabel={t('shell.about.title')}
          width="400px"
          height="auto"
        >
          {' '}
          <div className={styles.about}>
            <h2 className={styles.aboutTitle}>PayasoAgent</h2>
            {version && (
              <p className={styles.aboutVersion}>{t('shell.about.version', { version })}</p>
            )}
            {info && (info.electron || info.node) ? (
              <p className={styles.aboutMeta}>
                {t('shell.about.runtime', { electron: info.electron, node: info.node })}
              </p>
            ) : null}
            <button type="button" className={styles.aboutOk} onClick={() => setAboutOpen(false)}>
              {t('shell.about.close')}
            </button>
          </div>
        </Modal>
      )}
    </span>
  );
}
