// OpenInAppMenu：open-in-app 的应用下拉菜单（Launcher 与文件预览操作栏共用）。
//
// 只负责"选哪个应用"：列表由调用方按目标取好再传入（useOpenInApps → Host 过滤），
// 真图标由 /open-in-app/icon/<id> 提供（404 回退字形芯片）；点击即 POST 打开，
// 选择记 localStorage（默认应用）。平台逻辑全在 Host，这里零平台判断。
//
// 菜单 portal 到 portalRoot()：index.css 把 body 直接子元素 display:none，
// 挂在组件树里会被误伤（与 Timeline 的 Modal 同因）。

import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileIcon, FolderIcon } from '../components/icons';
import { useI18n } from '../i18n';
import { portalRoot } from '../portal-root';
import styles from './OpenInAppMenu.module.css';
import type { OpenInApp } from './open-in-app';
import { defaultAppId, openInApp, openInAppIconUrl, setSelectedAppId } from './open-in-app';

export interface OpenInAppMenuProps {
  /** 菜单是否展开（由触发按钮一侧持有状态）。 */
  open: boolean;
  /** 关闭回调（点外部 / 选中一项后）。 */
  onClose: () => void;
  /** 锚点（触发按钮）：菜单定位到它下方、右缘对齐；点在锚点上不算"外部"。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 已按目标过滤的应用列表（null = 加载中；空数组 = 没有应用能打开这个目标）。 */
  apps: OpenInApp[] | null;
  /** 列表加载失败（端点不可达 / 旧 Host）。 */
  loadFailed?: boolean;
  /** 打开目标：工作区相对路径（缺省 = 工作区根）。 */
  path?: string | null;
  /** 会话级作用域 Run（历史会话也能开它自己工作区里的文件）。 */
  runId?: string | null;
  /** toast 回调（成功/失败文案）。 */
  onToast: (message: string) => void;
}

const MENU_WIDTH = 236;

export default function OpenInAppMenu({
  open,
  onClose,
  anchorRef,
  apps,
  loadFailed = false,
  path,
  runId,
  onToast,
}: OpenInAppMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // 图标 404（非 macOS / 提取失败）→ 该项回退字形芯片
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(new Set());

  // 定位：锚点下方 + 右缘对齐，视口内钳制。
  // useLayoutEffect：首帧前算完，不出现"先闪在左上角"。
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
    });
  }, [open, anchorRef]);

  if (!open) return null;

  const openWith = (id: string) => {
    onClose();
    setSelectedAppId(id);
    openInApp(id, { path, runId })
      .then(() => onToast(t('preview.launcher.opened')))
      .catch((err: unknown) => onToast(err instanceof Error ? err.message : String(err)));
  };

  // 默认应用：系统给的 isDefault 优先（文件目标），否则本地记忆/列表首个（目录目标）
  const effectiveSelectedId =
    apps === null ? null : (apps.find((app) => app.isDefault === true)?.id ?? defaultAppId(apps));

  return createPortal(
    <div
      className={styles.menu}
      role="menu"
      ref={menuRef}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      {apps === null && !loadFailed && (
        <div className={styles.menuHint}>{t('preview.viewer.loading')}</div>
      )}
      {loadFailed && <div className={styles.menuHint}>{t('preview.launcher.loadFailed')}</div>}
      {apps !== null && apps.length === 0 && (
        <div className={styles.menuHint}>{t('preview.launcher.empty')}</div>
      )}
      {apps?.map((app) => {
        // 图标：系统关联来源带 32px PNG data URL；白名单来源（非 macOS）回退端点
        const iconUrl =
          brokenIcons.has(app.id) || (app.icon === undefined && app.id.startsWith('/'))
            ? null
            : (app.icon ?? openInAppIconUrl(app.id));
        return (
          <button
            key={app.id}
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${app.id === effectiveSelectedId ? styles.menuItemActive : ''}`}
            onClick={() => openWith(app.id)}
          >
            <span className={styles.chip}>
              {iconUrl === null ? (
                <FileIcon size={15} />
              ) : (
                <img
                  className={styles.appIcon}
                  src={iconUrl}
                  alt=""
                  onError={() => setBrokenIcons((prev) => new Set(prev).add(app.id))}
                />
              )}
            </span>
            <span className={styles.menuLabel}>
              {app.label}
              {app.id === effectiveSelectedId ? t('preview.launcher.defaultSuffix') : ''}
            </span>
          </button>
        );
      })}
      {/* 文件目标专属：在文件管理器里显示位置（不打开文件本身） */}
      {path ? (
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={() => {
            onClose();
            openInApp('', { action: 'reveal', path, runId })
              .then(() => onToast(t('preview.fileBar.revealed')))
              .catch((err: unknown) => onToast(err instanceof Error ? err.message : String(err)));
          }}
        >
          <span className={styles.chip}>
            <FolderIcon size={15} />
          </span>
          <span className={styles.menuLabel}>{t('preview.fileBar.reveal')}</span>
        </button>
      ) : null}
    </div>,
    portalRoot(),
  );
}
