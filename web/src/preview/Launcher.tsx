// Launcher：ShellBar 上的预览入口 —— 分段胶囊（默认 app 图标 | ⌄）+ 侧栏开关。
// 图标段：用默认 app 打开工作区（Host 端点，controller 见 open-in-app.ts）；
// ⌄ 段：应用菜单（Host 探测的已装列表，真图标由 /open-in-app/icon/<id> 提供）；
// 侧栏 glyph：开/关右侧预览面板（与 ⌘P 同一动作）。
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, FileIcon, PanelRightIcon } from '../components/icons';
import { useClickOutside } from '../hooks/useClickOutside';
import { useI18n } from '../i18n';
import { portalRoot } from '../portal-root';
import styles from './Launcher.module.css';
import {
  getSelectedAppId,
  invalidateOpenInApps,
  listOpenInApps,
  type OpenInApp,
  openInApp,
  openInAppIconUrl,
  setSelectedAppId,
} from './open-in-app';

interface PreviewLauncherProps {
  /** 面板当前是否打开（侧栏开关的高亮依赖它）。 */
  open: boolean;
  /** 开/关右侧预览面板（侧栏 glyph 与 ⌘P 同一动作）。 */
  onToggle: () => void;
  /** 会话级作用域：在哪个 Run 的工作区里打开（缺省 = Host 当前工作区）。 */
  runId?: string | null;
  /** 提示条回调（成功/失败文案走宿主 toast）。 */
  onToast: (message: string) => void;
}

export default function PreviewLauncher({ open, onToggle, runId, onToast }: PreviewLauncherProps) {
  const { t } = useI18n();
  const pillRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [apps, setApps] = useState<OpenInApp[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // 图标 404（非 macOS / 提取失败）→ 回退字形芯片
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(new Set());
  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false));

  // 页载读一次（controller 约定）：胶囊要显示"当前选中应用"的图标
  useEffect(() => {
    if (apps === null && !loadFailed) {
      listOpenInApps()
        .then((list) => setApps(list))
        .catch(() => {
          invalidateOpenInApps();
          setLoadFailed(true);
        });
    }
  }, [apps, loadFailed]);

  const toggleMenu = () => {
    if (!menuOpen) {
      const rect = pillRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setMenuOpen((v) => !v);
  };

  const openWith = (id: string) => {
    setMenuOpen(false);
    setSelectedAppId(id);
    openInApp(id, runId)
      .then(() => onToast(t('preview.launcher.opened')))
      .catch((err: unknown) => onToast(err instanceof Error ? err.message : String(err)));
  };

  // 当前选中应用：localStorage 记忆优先，否则默认列表第一个（与 macOS「访达（默认）」同语义）
  const selectedId = getSelectedAppId();
  const effectiveSelectedId = selectedId ?? apps?.[0]?.id ?? null;
  const selectedApp = apps?.find((app) => app.id === effectiveSelectedId);
  const pillIcon =
    selectedApp && !brokenIcons.has(selectedApp.id) ? openInAppIconUrl(selectedApp.id) : null;

  return (
    <div className={styles.wrap} ref={pillRef}>
      <div className={styles.pill}>
        <button
          type="button"
          className={styles.seg}
          onClick={() => {
            if (selectedApp) openWith(selectedApp.id);
            else onToggle(); // 应用列表未就绪（旧 Host/加载失败）：退回面板开关
          }}
          title={
            selectedApp
              ? t('preview.launcher.openDefault', { app: selectedApp.label })
              : t('preview.dock.open')
          }
          aria-label={
            selectedApp
              ? t('preview.launcher.openDefault', { app: selectedApp.label })
              : t('preview.dock.open')
          }
        >
          {pillIcon ? (
            <img className={styles.pillIcon} src={pillIcon} alt="" />
          ) : (
            <FileIcon size={14} />
          )}
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <button
          type="button"
          className={styles.seg}
          onClick={toggleMenu}
          aria-label={t('preview.launcher.menu')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <ChevronDownIcon size={15} className={menuOpen ? styles.chevOpen : ''} />
        </button>
      </div>
      {/* 侧栏开关：面板关闭时显示（打开后 dock 头部自带关闭 glyph，不再重复） */}
      {!open && (
        <button
          type="button"
          className={styles.panelBtn}
          onClick={onToggle}
          title={t('preview.dock.open')}
          aria-label={t('preview.dock.open')}
        >
          <PanelRightIcon size={15} />
        </button>
      )}
      {menuOpen &&
        createPortal(
          <div
            className={styles.menu}
            role="menu"
            ref={menuRef}
            style={{ top: menuPos?.top, right: menuPos?.right } as CSSProperties}
          >
            {apps === null && !loadFailed && (
              <div className={styles.menuHint}>{t('preview.viewer.loading')}</div>
            )}
            {loadFailed && (
              <div className={styles.menuHint}>{t('preview.launcher.loadFailed')}</div>
            )}
            {apps !== null && apps.length === 0 && (
              <div className={styles.menuHint}>{t('preview.launcher.empty')}</div>
            )}
            {apps?.map((app) => {
              const iconBroken = brokenIcons.has(app.id);
              return (
                <button
                  key={app.id}
                  type="button"
                  role="menuitem"
                  className={`${styles.menuItem} ${app.id === effectiveSelectedId ? styles.menuItemActive : ''}`}
                  onClick={() => openWith(app.id)}
                >
                  {iconBroken ? (
                    <span className={styles.chip}>
                      <FileIcon size={15} />
                    </span>
                  ) : (
                    <img
                      className={styles.appIcon}
                      src={openInAppIconUrl(app.id)}
                      alt=""
                      onError={() => setBrokenIcons((prev) => new Set(prev).add(app.id))}
                    />
                  )}
                  <span className={styles.menuLabel}>
                    {app.label}
                    {app.id === effectiveSelectedId ? t('preview.launcher.defaultSuffix') : ''}
                  </span>
                </button>
              );
            })}
          </div>,
          portalRoot(),
        )}
    </div>
  );
}
