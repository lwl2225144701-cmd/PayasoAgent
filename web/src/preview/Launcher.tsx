// Launcher：ShellBar 上的预览入口 —— 分段胶囊（默认 app 图标 | ⌄）+ 侧栏开关。
// 图标段：用默认 app 打开工作区（Host 端点，controller 见 open-in-app.ts）；
// ⌄ 段：应用菜单（OpenInAppMenu，Host 探测的已装列表，真图标由 /open-in-app/icon/<id> 提供）；
// 侧栏 glyph：开/关右侧预览面板（与 ⌘P 同一动作）。
import { useRef, useState } from 'react';
import { ChevronDownIcon, FileIcon } from '../components/icons';
import { PanelToggleButton } from '../components/PanelToggleButton';
import { useI18n } from '../i18n';
import { useOpenInApps } from './hooks/useOpenInApps';
import styles from './Launcher.module.css';
import OpenInAppMenu from './OpenInAppMenu';
import { effectiveDefaultId, openInApp, openInAppItemIconUrl } from './open-in-app';

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
  const [menuOpen, setMenuOpen] = useState(false);
  // 工作区根（文件夹）语义：列表 = 能打开文件夹的应用
  const { apps, loadFailed, brokenIcons, markIconBroken } = useOpenInApps();

  // 当前选中应用：系统默认/本地记忆优先，否则列表第一个（与 macOS「访达（默认）」同语义）
  const selectedApp =
    apps === null
      ? null
      : (apps.find((app) => app.id === effectiveDefaultId(apps, 'folder')) ?? null);
  const pillIcon =
    selectedApp === null
      ? null
      : openInAppItemIconUrl(selectedApp, brokenIcons.has(selectedApp.id));

  const openWorkspaceWith = (id: string) => {
    openInApp(id, { runId })
      .then(() => onToast(t('preview.launcher.opened')))
      .catch((err: unknown) => onToast(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className={styles.wrap} ref={pillRef}>
      <div className={styles.pill}>
        <button
          type="button"
          className={styles.seg}
          onClick={() => {
            if (selectedApp) openWorkspaceWith(selectedApp.id);
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
            <img
              className={styles.pillIcon}
              src={pillIcon}
              alt=""
              onError={() => selectedApp && markIconBroken(selectedApp.id)}
            />
          ) : (
            <FileIcon size={14} />
          )}
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <button
          type="button"
          className={styles.seg}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={t('preview.launcher.menu')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <ChevronDownIcon size={15} className={menuOpen ? styles.chevOpen : ''} />
        </button>
      </div>
      {/* 侧栏开关：面板关闭时显示（打开后 dock 头部自带关闭 glyph，不再重复） */}
      {!open && (
        <PanelToggleButton
          side="right"
          onClick={onToggle}
          title={t('preview.dock.open')}
          aria-label={t('preview.dock.open')}
        />
      )}
      <OpenInAppMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={pillRef}
        apps={apps}
        loadFailed={loadFailed}
        runId={runId}
        onToast={onToast}
      />
    </div>
  );
}
