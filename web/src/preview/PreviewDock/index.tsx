// PreviewDock：右侧停靠预览面板 —— 标签条（"开始"/"文件"标签 + 文件标签 + ＋）+ 首页 + viewer。
// 形态对齐 DSH 的右侧面板（交互序列见 docs/plans/preview-module-plan.md §9）：
//   ① 面板打开 → 空标签集，strip 只有"开始"入口（无胶囊/无 ×/无 ＋），正文是首页卡片；
//   ② 点"工作区文件"卡片 → 激活的"开始"标签转成"文件"标签（一棵独立目录树），strip = [文件 ×][＋]；
//   ③ 点 ＋ → 新建一个"开始"标签并激活（新标签默认落在开始页），strip = [文件][开始 ×]。
// 宽度可拖拽 + localStorage 持久化；窄屏退化为全屏覆盖层（见 CSS 媒体查询）。
// 状态提升约定：文件标签（tabsApi）由 App 持有，Timeline 点文件与面板内点文件写同一组。

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  CloseIcon,
  CompassIcon,
  ExpandIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
  ShrinkIcon,
} from '../../components/icons';
import { PanelToggleButton } from '../../components/PanelToggleButton';
import { useI18n } from '../../i18n';
import { PREVIEW_HOME_ACTIONS, type PreviewHomeActionId } from '../dock-home';
import {
  addStartTab,
  browserTabLabel,
  closeDockTab,
  type DockTabs,
  initialDockTabs,
  openFilesTab,
  openWebTab,
  webTabLabel,
} from '../dock-tabs';
import FileActionBar from '../FileActionBar';
import FileTree from '../FileTree';
import type { PreviewTabs } from '../hooks/usePreviewTabs';
import { FallbackViewer, FileIconFor, fileIconName, resolveViewer } from '../registry';
import { WebBrowser } from '../WebBrowser';
import styles from './PreviewDock.module.css';

const WIDTH_KEY = 'payaso.preview.width';
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;

function loadWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export interface PreviewDockProps {
  /** 收起面板只隐藏；组件继续持有标签和各视图的浏览状态。 */
  visible: boolean;
  /** M4 起标签状态由 App 持有（Timeline 点文件要往同一个标签集合里塞）。 */
  tabsApi: PreviewTabs;
  onClose: () => void;
  /** 未选择工作区时面板里"选择工作区"的出路（转交宿主的既有选择流程）。 */
  onRequestWorkspace?: () => void;
  /** 当前会话 Run：面板按它的工作区取文件（会话级浏览；空 = Host 当前工作区）。 */
  runId?: string | null;
  /** 宿主 toast（"在应用中打开"的成功/失败文案；缺省则不提示）。 */
  onToast?: (message: string) => void;
}

export default function PreviewDock({
  visible,
  tabsApi,
  onClose,
  onRequestWorkspace,
  runId,
  onToast,
}: PreviewDockProps) {
  const { t } = useI18n();
  const { tabs, activePath, open, close, setActive } = tabsApi;
  const [width, setWidth] = useState(loadWidth);
  // 停靠标签（"开始"/"文件"）：空数组 = 首页占位（strip 只显示"开始"入口）。
  // 文件标签不在这里（tabsApi，App 层）；strip 顺序 = 停靠标签 + 文件标签 + ＋。
  const [dockTabs, setDockTabs] = useState<DockTabs>(initialDockTabs);
  // 面板当前视图：首页卡片 / 某个停靠标签 / 某个文件标签。
  const [activeKind, setActiveKind] = useState<'home' | 'browser' | 'web' | 'file'>('home');
  // 手动重载令牌：操作栏"刷新"按下即 +1，viewer 的 key 带上它 → 重挂载重取
  const [manualReload, setManualReload] = useState(0);
  // 全屏：面板铺满整个窗口（窄屏媒体查询本来就是全屏，这里给宽屏手动开关）
  const [fullscreen, setFullscreen] = useState(false);

  // 文件被打开（含 Timeline/附件入口）→ 自动切到该文件标签；
  // 最后一个文件标签被关掉 → 回到刚才的停靠标签（没有则首页）。
  // 只依赖 activePath：dockTabs 变化（如"正在看文件时点＋"）不得把视图拽回文件。
  const dockTabsRef = useRef(dockTabs);
  dockTabsRef.current = dockTabs;
  useEffect(() => {
    if (activePath !== null) {
      setActiveKind('file');
      return;
    }
    setActiveKind((kind) => {
      if (kind !== 'file') return kind;
      const active = dockTabsRef.current.tabs.find(
        (tab) => tab.id === dockTabsRef.current.activeId,
      );
      return active ? active.kind : 'home';
    });
  }, [activePath]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // 隐私模式等写不进的场景：宽度不持久化但不影响使用
    }
  }, [width]);

  // 拖拽分隔条：window-splitter 模式 —— pointer 拖拽 + 方向键，宽度钳制在 [MIN, MAX]
  const nudge = useCallback((delta: number) => {
    setWidth((w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + delta)));
  }, []);

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const move = (e: PointerEvent) => {
        const next = startWidth + (startX - e.clientX); // 向左拖变宽
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [width],
  );

  const onHandleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 48 : 16;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        nudge(step);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        nudge(-step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setWidth(MIN_WIDTH);
      } else if (event.key === 'End') {
        event.preventDefault();
        setWidth(MAX_WIDTH);
      }
    },
    [nudge],
  );

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;

  // —— 变更流：外部写入 / agent 写入 → 预览自动刷新（版本失效即重载）——
  const [reloadNonce, setReloadNonce] = useState<Record<string, number>>({});
  const [treeSignal, setTreeSignal] = useState(0);
  const treeScopeRef = useRef(runId);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    const scopeChanged = treeScopeRef.current !== runId;
    treeScopeRef.current = runId;
    // 面板关着不订阅；runId 变化（切会话）→ 重建订阅
    if (!visible) return;
    // 隐藏期间停止监听；重开时刷新当前目录，不重置目录/筛选/滚动状态。
    // 切换作用域由 useFileTree 加载新根目录，不能又用旧目录发刷新请求抢占它。
    if (!scopeChanged) setTreeSignal((n) => n + 1);
    const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
    const source = new EventSource(`/preview/changes${query}`);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; paths?: string[] };
        if (data.type !== 'changed' || !Array.isArray(data.paths)) return;
        const changedPaths = data.paths;
        setReloadNonce((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const p of changedPaths) {
            if (tabsRef.current.some((tab) => tab.path === p)) {
              next[p] = (prev[p] ?? 0) + 1;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        setTreeSignal((n) => n + 1); // 目录列表统一刷新（当前目录只多一次 GET）
      } catch {
        // 非 JSON 帧（心跳注释行不会进 onmessage）——忽略
      }
    };
    source.onerror = () => {
      // 409（无工作区）/断连：不自动重连，重开面板或切会话时重建
      source.close();
    };
    return () => source.close();
  }, [visible, runId]);

  // 以下 handler 直接读当前 render 的 dockTabs（事件闭包），不做函数式更新——
  // 状态迁移里要同步决定 activeKind，拆成两段 setState 反而难追。
  // ＋：新建一个"开始"标签并激活（新标签默认落在开始页，对齐截图 ③）
  const addTab = () => {
    setDockTabs(addStartTab(dockTabs));
    setActiveKind('home');
  };

  const closeDock = (id: number) => {
    const next = closeDockTab(dockTabs, id);
    setDockTabs(next);
    if (next.activeId === null) {
      setActiveKind('home'); // 关光 → 首页占位
      return;
    }
    setActiveKind((kind) => {
      if (kind === 'file') return kind; // 正在看文件：关后台标签不打扰
      const active = next.tabs.find((tab) => tab.id === next.activeId);
      return active ? active.kind : kind;
    });
  };

  // 首页卡片 → 文件视图或内嵌浏览器。
  const openHomeAction = (id: PreviewHomeActionId) => {
    if (id === 'workspace-files') {
      setDockTabs(openFilesTab(dockTabs));
      setActiveKind('browser');
      return;
    }
    if (id === 'browser') {
      setDockTabs(openWebTab(dockTabs));
      setActiveKind('web');
    }
  };

  return (
    <aside
      hidden={!visible}
      className={`${styles.dock} ${fullscreen ? styles.dockFullscreen : ''}`}
      style={{ '--dock-width': `${width}px` } as React.CSSProperties}
      aria-label={t('preview.dock.title')}
    >
      {/* window-splitter 模式（WAI-ARIA APG）：可聚焦、可拖拽、带 value 的
          separator 没有语义 HTML 等价物，<hr> 无法承载指针/键盘交互 */}
      {/* biome-ignore lint/a11y/useSemanticElements: window splitter（ARIA APG）无语义等价元素 */}
      <div
        className={styles.resizeHandle}
        onPointerDown={onHandlePointerDown}
        onKeyDown={onHandleKeyDown}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
      />
      <header className={styles.header} data-window-drag data-preview-header>
        <div className={styles.tabStrip} role="tablist">
          {/* 空态"开始"入口：不是标签（无激活胶囊、无 ×）；点首页卡片才产生第一个真标签 */}
          {dockTabs.tabs.length === 0 && (
            <button
              type="button"
              className={styles.homeEntry}
              onClick={() => setActiveKind('home')}
              role="tab"
              aria-selected={activeKind === 'home'}
            >
              <CompassIcon size={13} />
              <span className={styles.tabName}>{t('preview.dock.home.title')}</span>
            </button>
          )}
          {/* 停靠标签："开始"（首页）/ "文件"（一棵独立目录树），各带 × */}
          {dockTabs.tabs.map((tab) => {
            const active = activeKind !== 'file' && dockTabs.activeId === tab.id;
            const isHome = tab.kind === 'home';
            const isWeb = tab.kind === 'web';
            const label = isHome
              ? null
              : isWeb
                ? webTabLabel(
                    dockTabs.tabs
                      .filter((item) => item.kind === 'web')
                      .findIndex((item) => item.id === tab.id),
                  )
                : browserTabLabel(
                    dockTabs.tabs
                      .filter((item) => item.kind === 'browser')
                      .findIndex((item) => item.id === tab.id),
                  );
            return (
              <div key={tab.id} className={`${styles.tab} ${active ? styles.tabActive : ''}`}>
                {/* role=tab 放在可聚焦按钮上（ARIA tab 模式：tablist > tab） */}
                <button
                  type="button"
                  className={styles.tabMain}
                  onClick={() => setActiveKind(tab.kind)}
                  role="tab"
                  aria-selected={active}
                >
                  {isHome ? (
                    <CompassIcon size={13} />
                  ) : isWeb ? (
                    <GlobeIcon size={13} />
                  ) : (
                    <FolderIcon size={12} />
                  )}
                  <span className={styles.tabName}>
                    {isHome
                      ? t('preview.dock.home.title')
                      : label && ('n' in label ? t(label.key, { n: label.n }) : t(label.key))}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  onClick={() => closeDock(tab.id)}
                  title={t('preview.dock.closeTab')}
                  aria-label={t('preview.dock.closeTab')}
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            );
          })}
          {tabs.map((tab) => {
            const active = activeKind === 'file' && tab.path === activePath;
            return (
              <div key={tab.path} className={`${styles.tab} ${active ? styles.tabActive : ''}`}>
                <button
                  type="button"
                  className={styles.tabMain}
                  onClick={() => {
                    setActive(tab.path);
                    setActiveKind('file');
                  }}
                  title={tab.path}
                  role="tab"
                  aria-selected={active}
                >
                  <FileIconFor kind={fileIconName(tab.name)} size={13} />
                  <span className={styles.tabName}>{tab.name}</span>
                </button>
                <button
                  type="button"
                  className={styles.tabClose}
                  onClick={() => close(tab.path)}
                  title={t('preview.dock.closeTab')}
                  aria-label={t('preview.dock.closeTab')}
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            );
          })}
          {/* ＋：纯空态不显示；点首页卡片才产生第一个真标签 */}
          {(dockTabs.tabs.length > 0 || tabs.length > 0) && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={addTab}
              title={t('preview.dock.newTab')}
              aria-label={t('preview.dock.newTab')}
            >
              <PlusIcon size={15} />
            </button>
          )}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? t('preview.dock.restore') : t('preview.dock.fullscreen')}
            aria-label={fullscreen ? t('preview.dock.restore') : t('preview.dock.fullscreen')}
            aria-pressed={fullscreen}
          >
            {fullscreen ? <ShrinkIcon size={17} /> : <ExpandIcon size={17} />}
          </button>
          <PanelToggleButton
            side="right"
            onClick={onClose}
            title={t('preview.dock.close')}
            aria-label={t('preview.dock.close')}
          />
        </div>
      </header>

      <div className={styles.body}>
        {activeKind === 'home' ? (
          <div className={styles.home}>
            <div className={styles.homeGrid}>
              {PREVIEW_HOME_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={styles.homeTile}
                  onClick={() => openHomeAction(action.id)}
                >
                  <span className={styles.homeTileIcon}>{homeTileIcon(action.id)}</span>
                  <span className={styles.homeTileLabel}>{t(action.titleKey)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : activeKind === 'file' && activeTab ? (
          <div className={styles.fileView}>
            {/* 操作条：路径（工作区相对）+ 刷新 + 在应用中打开（对齐 DSH 文件预览形态） */}
            <FileActionBar
              path={activeTab.path}
              runId={runId}
              onRefresh={() => setManualReload((n) => n + 1)}
              onToast={onToast ?? (() => undefined)}
            />
            <Suspense
              fallback={<div className={styles.loading}>{t('preview.viewer.loading')}</div>}
            >
              <ViewerHost
                key={`${activeTab.path}@${reloadNonce[activeTab.path] ?? 0}@${manualReload}`}
                path={activeTab.path}
                name={activeTab.name}
                runId={runId}
              />
            </Suspense>
          </div>
        ) : null}
        {dockTabs.tabs
          .filter((tab) => tab.kind === 'web')
          .map((tab) => {
            const paneActive = activeKind === 'web' && dockTabs.activeId === tab.id;
            return (
              <div
                key={tab.id}
                className={`${styles.browserPane} ${paneActive ? '' : styles.paneHidden}`}
                aria-hidden={!paneActive}
              >
                <WebBrowser />
              </div>
            );
          })}
        {dockTabs.tabs
          .filter((tab) => tab.kind === 'browser')
          .map((tab) => {
            // 所有"文件"标签保持挂载（各自的浏览位置/过滤词不丢），非激活的仅隐藏。
            const paneActive = activeKind === 'browser' && dockTabs.activeId === tab.id;
            return (
              <div
                key={tab.id}
                className={`${styles.browserPane} ${paneActive ? '' : styles.paneHidden}`}
                aria-hidden={!paneActive}
              >
                <FileTree
                  onOpenFile={open}
                  onRequestWorkspace={onRequestWorkspace}
                  runId={runId}
                  refreshSignal={treeSignal}
                />
              </div>
            );
          })}
      </div>
    </aside>
  );
}

function homeTileIcon(id: PreviewHomeActionId) {
  if (id === 'browser') return <GlobeIcon size={22} />;
  return <FileIcon size={22} />;
}

/** viewer 分发：registry 解析 → 懒加载组件；解析不到走 FallbackViewer。 */
function ViewerHost({ path, name, runId }: { path: string; name: string; runId?: string | null }) {
  const spec = resolveViewer(name);
  const Component = spec?.Component ?? FallbackViewer;
  return <Component path={path} name={name} runId={runId} />;
}
