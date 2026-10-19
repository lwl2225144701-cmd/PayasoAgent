import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useI18n } from '../../i18n';
import { portalRoot } from '../../portal-root';
import type { HostSession, WorkspaceView } from '../../types';
import { Collapse } from '../Collapse';
import { IconButton } from '../IconButton';
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '../icons';
import { Modal } from '../Modal';
import { SessionItem } from '../SessionItem';
import { filterWorkspaceGroupsForSearch, resolveSearchExpansionOverrides } from './task-search';
import styles from './WorkspaceSection.module.css';
import { isWorkspaceGroupExpanded, type WorkspaceGroup } from './workspace-expansion';

interface WorkspaceSectionProps {
  sessions: HostSession[];
  currentSessionId: string | null;
  workspace: WorkspaceView | null;
  openingWorkspace: boolean;
  onOpenWorkspace: () => void;
  onSelectSession: (sessionId: string) => void;
  onNewTaskInWorkspace: (workspaceName: string) => void;
  onRenameWorkspace: (fromName: string, toName: string) => Promise<void>;
  onDeleteWorkspace: (name: string) => Promise<void>;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onArchiveSession: (sessionId: string) => Promise<void>;
}

interface MenuState {
  name: string;
  x: number;
  y: number;
}

// 无工作区会话的分组哨兵名：它只参与分组与比较，不是展示文案；
// 渲染时由 groupLabel 翻成当前语言的「未选择工作区」。
const NO_WORKSPACE_GROUP = '\u0000no-workspace';

/** 分组名是不是「无工作区」哨兵：分组比较、搜索匹配都按哨兵走，展示时才翻译。 */
function isFallbackWorkspace(name: string): boolean {
  return name === NO_WORKSPACE_GROUP;
}

function groupSessionsByWorkspace(
  sessions: HostSession[],
  currentWorkspace: WorkspaceView | null,
): WorkspaceGroup[] {
  const map = new Map<string, HostSession[]>();
  for (const session of sessions) {
    const name = session.workspace?.name ?? NO_WORKSPACE_GROUP;
    const list = map.get(name) ?? [];
    list.push(session);
    map.set(name, list);
  }

  for (const list of map.values()) {
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  return Array.from(map.entries())
    .map(([name, sessions]) => ({ name, sessions }))
    .sort((a, b) => {
      const currentName = currentWorkspace?.name;
      if (a.name === currentName && b.name !== currentName) return -1;
      if (b.name === currentName && a.name !== currentName) return 1;
      return a.name.localeCompare(b.name);
    });
}

function WorkspaceFolderHeader({
  name,
  onOpenMenu,
  onNewTask,
}: {
  name: string;
  onOpenMenu: (x: number, y: number) => void;
  onNewTask: () => void;
}) {
  const { t } = useI18n();
  return (
    <span className={styles.folderHeader}>
      <span className={styles.folderIconSlot}>
        <FolderIcon size={15} className={styles.folderIcon} />
        <ChevronDownIcon size={13} className={styles.folderArrow} />
      </span>
      <span className={`${styles.folderName} truncate`}>{name}</span>
      <span className={styles.folderActions}>
        <button
          type="button"
          className={styles.actionBtn}
          title={t('shell.action.more')}
          aria-label={t('shell.action.moreFor', { name })}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.left, rect.bottom + 4);
          }}
        >
          <MoreIcon size={15} />
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          title={t('shell.action.newTask')}
          aria-label={t('shell.workspace.newTaskIn', { name })}
          onClick={(e) => {
            e.stopPropagation();
            onNewTask();
          }}
        >
          <PlusIcon size={15} />
        </button>
      </span>
    </span>
  );
}

function WorkspaceMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEscapeKey(true, onClose);
  useClickOutside(ref, true, onClose);

  const left = Math.max(8, Math.min(x + 22 - 160, window.innerWidth - 168));

  return createPortal(
    <div ref={ref} className={styles.menu} style={{ left, top: y }}>
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <PencilIcon size={14} />
        <span>{t('shell.action.rename')}</span>
      </button>
      <button
        type="button"
        className={`${styles.menuItem} ${styles.menuDanger}`}
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        <TrashIcon size={14} />
        <span>{t('shell.workspace.delete')}</span>
      </button>
    </div>,
    portalRoot(),
  );
}

export function WorkspaceSection({
  sessions,
  currentSessionId,
  workspace,
  openingWorkspace,
  onOpenWorkspace,
  onSelectSession,
  onNewTaskInWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onRenameSession,
  onArchiveSession,
}: WorkspaceSectionProps) {
  const { t } = useI18n();
  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, workspace),
    [sessions, workspace],
  );

  // ---- 历史任务搜索：按「工作区名 + 任务标题」过滤分组 ----
  //
  // 交互（对齐 DSH）：默认不占地方，点工作区行上的放大镜才展开输入框；再点 × 收起并
  // 清空。因此这里持有两份状态：
  //   - searchOpen   —— 输入框是否展开（纯 UI，不影响过滤结果）；
  //   - searchKeyword—— 关键词（真正参与过滤的那一份）。
  // 收起 = 关键词一并清空，用户不会看到「框没了但列表还筛着」的割裂状态。
  //
  // 数据流：sessions → groupSessionsByWorkspace → 过滤（task-search.ts）。
  // 会话列表是 App 的单一数据源，重命名 / 归档后它更新，搜索结果随之更新 —— 无需
  // 额外订阅或本地缓存。搜索不切换当前会话、不动文件预览。
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 展开时立即聚焦：点一下放大镜就能直接打字，省一次点击
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchKeyword('');
  }, []);

  // Esc 收起搜索。**不要用 document 级的 useEscapeKey**：本组件里还有删除确认弹窗，
  // 用户按 Esc 是想关那个弹窗，document 级监听会顺手把关键词一起清掉 —— 那是误伤。
  // 挂在输入框自己的键盘事件上，只有焦点在搜索框里时才响应。
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') closeSearch();
  };

  const untitledTitle = t('shell.session.untitled');
  const { groups: visibleGroups } = useMemo(
    () =>
      filterWorkspaceGroupsForSearch(groups, searchKeyword, {
        // 哨兵分组名是内部标识，展示文案（「未选择工作区」）才是用户会拿来搜索的词
        groupDisplayName: (name) => (isFallbackWorkspace(name) ? untitledTitle : name),
        untitledTitle,
      }),
    [groups, searchKeyword, untitledTitle],
  );
  const searchActive = searchKeyword.trim().length > 0;

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- 分组展开：派生自动判定 + 用户显式覆盖（判定规则见 workspace-expansion.ts）----
  //
  // 不用 Collapse 的 defaultExpanded：它只在**挂载那一刻**生效，而「当前会话属于哪个
  // 工作区」在刷新场景是等会话清单回来才知道的 —— 结果是当前会话所在分组一直收着，
  // 用户看不到自己在哪。改成受控后，判定随数据变化自动重算。
  const [groupOverrides, setGroupOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const currentWorkspaceName = workspace?.name ?? NO_WORKSPACE_GROUP;

  // 搜索期间命中分组一律展开，但**用户显式覆盖优先**（搜索中手动收起就保持收起）。
  // 合成覆盖不写进 groupOverrides：清空搜索后它自然消失，展开态回到搜索前的判定结果 ——
  // 因此不需要为「恢复」额外存一份快照。规则见 task-search.ts。
  const expansionOverrides = useMemo(
    () =>
      resolveSearchExpansionOverrides({
        searchActive,
        visibleGroups,
        userOverrides: groupOverrides,
      }),
    [searchActive, visibleGroups, groupOverrides],
  );

  const isGroupExpanded = (group: WorkspaceGroup): boolean =>
    isWorkspaceGroupExpanded(group, {
      currentSessionId,
      currentWorkspaceName,
      overrides: expansionOverrides,
    });

  const handleToggleGroup = useCallback((name: string, next: boolean) => {
    setGroupOverrides((prev) => new Map(prev).set(name, next));
  }, []);

  // 分组名可能是内部哨兵，展示前统一翻成当前语言
  const groupLabel = (name: string) =>
    isFallbackWorkspace(name) ? t('shell.workspace.none') : name;

  const openRename = () => {
    if (!menu) return;
    setRenaming(menu.name);
    setRenameValue(menu.name);
  };

  const openDelete = () => {
    if (!menu) return;
    setDeleting(menu.name);
  };

  const submitRename = async () => {
    if (!renaming || busy) return;
    const toName = renameValue.trim();
    if (!toName || toName === renaming) return;
    setBusy(true);
    try {
      await onRenameWorkspace(renaming, toName);
      setRenaming(null);
    } catch {
      // 错误提示由 App 层负责
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await onDeleteWorkspace(deleting);
      setDeleting(null);
    } catch {
      // 错误提示由 App 层负责
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.section}>
      {/* 标题行与搜索条叠在同一个网格单元里：展开时搜索条原地"盖"住标题行（"工作区"
          字样与两个图标一起隐去），收起时标题行原样回来。这样既不用为两套布局
          各留一份高度（列表不会跳动），又能给"覆盖"做过渡动画。 */}
      <div className={styles.header} data-search-open={searchOpen ? 'true' : 'false'}>
        <div className={styles.headerSlot}>
          <div className={styles.headerBar}>
            <span className={styles.label}>{t('shell.workspace.label')}</span>
            <div className={styles.headerActions}>
              {/* 搜索开关：点一下展开搜索条（覆盖本行），再点 = 收起并清空。
                  aria-expanded 让读屏软件知道这是展开控件。 */}
              <IconButton
                buttonSize="sm"
                variant="ghost"
                shape="rounded"
                title={t('shell.search.toggle')}
                aria-label={t('shell.search.toggle')}
                aria-expanded={searchOpen}
                data-sidebar-search-toggle
                onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              >
                <SearchIcon size={15} />
              </IconButton>
              <IconButton
                buttonSize="sm"
                variant="ghost"
                shape="rounded"
                title={workspace ? t('shell.workspace.change') : t('shell.workspace.open')}
                aria-label={workspace ? t('shell.workspace.change') : t('shell.workspace.open')}
                onClick={onOpenWorkspace}
                disabled={openingWorkspace}
              >
                <FolderIcon size={15} />
              </IconButton>
            </div>
          </div>

          {/* 历史任务搜索条：范围 = 任务标题 + 工作区名（规则见同目录 task-search.ts）。
              输入即时筛选；点右侧 ×（或按 Esc）收起并清空，列表与分组展开态随之复原。 */}
          <div
            className={styles.searchBar}
            // 收起态**不能**用 hidden 属性 / display:none：那会让元素直接离开渲染树，
            // 收起动画没有起始帧，只能硬切。这里靠 CSS 的 visibility + opacity + scaleX
            // 过渡（见 .searchBar 收起态），元素始终在 DOM 里，动画才可能发生。
            // aria-hidden 与 tabIndex=-1 是双保险：visibility:hidden 本就把节点移出
            // 无障碍树和 Tab 顺序，显式声明让意图不依赖浏览器细节。
            aria-hidden={!searchOpen}
            data-sidebar-search-bar
          >
            <span className={styles.searchIcon} aria-hidden="true">
              <SearchIcon size={13} />
            </span>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              type="text"
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('shell.search.placeholder')}
              aria-label={t('shell.search.placeholder')}
              data-sidebar-search-input
              tabIndex={searchOpen ? undefined : -1}
            />
            <button
              type="button"
              className={styles.searchClear}
              onClick={closeSearch}
              title={t('common.close')}
              aria-label={t('common.close')}
              data-sidebar-search-close
              tabIndex={searchOpen ? undefined : -1}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className={styles.empty}>{t('shell.workspace.empty')}</div>
      ) : searchActive && visibleGroups.length === 0 ? (
        // 有历史任务但关键词没命中：明确告诉用户「搜过了、没结果」,
        // 与「暂无历史任务」分开 —— 后者是空列表，不该用同一句糊过去。
        <div className={styles.empty} role="status">
          {t('shell.search.noResults', { keyword: searchKeyword.trim() })}
        </div>
      ) : (
        <nav className={styles.tree} aria-label={t('shell.workspace.tree')}>
          {visibleGroups.map((group) => {
            const fallback = isFallbackWorkspace(group.name);
            return (
              <Collapse
                key={group.name}
                header={
                  <WorkspaceFolderHeader
                    name={groupLabel(group.name)}
                    onOpenMenu={fallback ? () => {} : (x, y) => setMenu({ name: group.name, x, y })}
                    onNewTask={fallback ? () => {} : () => onNewTaskInWorkspace(group.name)}
                  />
                }
                expanded={isGroupExpanded(group)}
                onToggle={(next) => handleToggleGroup(group.name, next)}
                headerClassName={styles.headerButton}
                arrow={false}
                contentClassName={styles.folderContent}
              >
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.sessionId}
                    session={session}
                    active={session.sessionId === currentSessionId}
                    onClick={() => onSelectSession(session.sessionId)}
                    onRename={onRenameSession}
                    onArchive={onArchiveSession}
                  />
                ))}
              </Collapse>
            );
          })}
        </nav>
      )}

      {menu && !isFallbackWorkspace(menu.name) && (
        <WorkspaceMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onRename={openRename}
          onDelete={openDelete}
        />
      )}

      {renaming && (
        <Modal onClose={() => setRenaming(null)} ariaLabel={t('shell.workspace.rename')}>
          <div className={styles.dialog}>
            <div className={styles.dialogTitle}>{t('shell.workspace.rename')}</div>
            <input
              className={styles.dialogInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitRename();
              }}
              maxLength={120}
              // biome-ignore lint/a11y/noAutofocus: 重命名输入框自动聚焦为有意 UX
              autoFocus
            />
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setRenaming(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${styles.dialogBtn} ${styles.primaryBtn}`}
                disabled={busy || !renameValue.trim() || renameValue.trim() === renaming}
                onClick={() => void submitRename()}
              >
                {t('common.ok')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal onClose={() => setDeleting(null)} ariaLabel={t('shell.workspace.delete')}>
          <div className={styles.dialog}>
            <div className={styles.dialogTitle}>{t('shell.workspace.delete')}</div>
            <p className={styles.dialogText}>
              {t('shell.workspace.deleteConfirm', { name: deleting })}
            </p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.dialogBtn} onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={`${styles.dialogBtn} ${styles.dangerBtn}`}
                disabled={busy}
                onClick={() => void submitDelete()}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
