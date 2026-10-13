// FileActionBar：文件预览视图顶部的操作条 —— 文件路径 + 刷新 + 在应用中打开。
// 对齐 DSH 的文件预览形态：一条窄栏交代"看的是哪个文件"，右侧两个动作。
//
// 路径只给**工作区相对路径**：宿主绝对路径不出前端（preview 域的安全立场，
// 与 /preview 路由一致）；要定位到机器上的位置，用右侧"在应用中打开"。
// 打开动作走 open-in-app：Host 装机探测 + 默认应用记忆 + 单条目重解析，
// 平台逻辑全在 Host；菜单与 ShellBar 入口共用 OpenInAppMenu。

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { ChevronDownIcon, FileIcon, RefreshIcon } from '../components/icons';
import styles from './FileActionBar.module.css';
import OpenInAppMenu from './OpenInAppMenu';
import {
  defaultAppId,
  listOpenInApps,
  type OpenInApp,
  openInApp,
  openInAppIconUrl,
} from './open-in-app';

export interface FileActionBarProps {
  /** 工作区相对路径（POSIX；即宿主上的相对位置）。 */
  path: string;
  /** 会话级作用域 Run（历史会话也能开它自己工作区里的文件）。 */
  runId?: string | null;
  /** 重新加载当前文件（viewer 重挂载重取）。 */
  onRefresh: () => void;
  /** toast 回调（成功/失败文案走宿主 toast）。 */
  onToast: (message: string) => void;
}

export default function FileActionBar({ path, runId, onRefresh, onToast }: FileActionBarProps) {
  const { t } = useI18n();
  const pillRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [apps, setApps] = useState<OpenInApp[] | null>(null);
  // 图标 404（非 macOS / 提取失败）→ 回退字形芯片
  const [brokenIcons, setBrokenIcons] = useState<ReadonlySet<string>>(new Set());

  // 与 Launcher 共用 controller 缓存（每页载只拉一次）；失败按空列表降级
  useEffect(() => {
    if (apps === null) {
      listOpenInApps()
        .then(setApps)
        .catch(() => setApps([]));
    }
  }, [apps]);

  const defaultApp =
    apps === null ? null : (apps.find((app) => app.id === defaultAppId(apps)) ?? null);
  const iconUrl =
    defaultApp && !brokenIcons.has(defaultApp.id) ? openInAppIconUrl(defaultApp.id) : null;
  const openTitle = defaultApp
    ? t('preview.fileBar.openWith', { app: defaultApp.label })
    : t('preview.fileBar.openIn');

  return (
    <div className={styles.bar}>
      <span className={styles.path} title={path}>
        {path}
      </span>
      <button
        type="button"
        className={styles.iconBtn}
        onClick={onRefresh}
        title={t('preview.tree.refresh')}
        aria-label={t('preview.tree.refresh')}
      >
        <RefreshIcon size={14} />
      </button>
      <div className={styles.pill} ref={pillRef}>
        <button
          type="button"
          className={styles.seg}
          onClick={() => {
            // 默认应用未就绪（列表加载中/失败/为空）：图标段退回展开菜单让人选
            if (!defaultApp) {
              setMenuOpen(true);
              return;
            }
            openInApp(defaultApp.id, { path, runId })
              .then(() => onToast(t('preview.launcher.opened')))
              .catch((err: unknown) => onToast(err instanceof Error ? err.message : String(err)));
          }}
          title={openTitle}
          aria-label={openTitle}
        >
          {iconUrl ? (
            <img
              className={styles.appIcon}
              src={iconUrl}
              alt=""
              onError={() =>
                defaultApp && setBrokenIcons((prev) => new Set(prev).add(defaultApp.id))
              }
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
          <ChevronDownIcon size={14} className={menuOpen ? styles.chevOpen : ''} />
        </button>
      </div>
      <OpenInAppMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={pillRef}
        path={path}
        runId={runId}
        onToast={onToast}
      />
    </div>
  );
}
