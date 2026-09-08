import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { browseDirectory, createWorkspaceDirectory, type DirectoryEntry, type DirectoryListing } from '../../api';
import { Modal } from '../Modal';
import styles from './WorkspacePickerModal.module.css';

interface WorkspacePickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

interface PickerState {
  listing: DirectoryListing | null;
  loading: boolean;
  error: string | null;
  creating: boolean;
  newFolderName: string;
}

const INITIAL_STATE: PickerState = {
  listing: null,
  loading: true,
  error: null,
  creating: false,
  newFolderName: '',
};

export function WorkspacePickerModal({ open, onClose, onSelect }: WorkspacePickerModalProps) {
  const [state, setState] = useState<PickerState>(INITIAL_STATE);
  // Edit path（直填绝对路径，仿 dsh）：受控输入 + 编辑标记，导航成功后回填规范化路径
  const [draftPath, setDraftPath] = useState('');
  const editingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setState(INITIAL_STATE);
      setDraftPath('');
      editingRef.current = false;
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    browseDirectory()
      .then((listing) => {
        if (!cancelled) setState((prev) => ({ ...prev, listing, loading: false }));
      })
      .catch((err) => {
        if (!cancelled) {
          setState((prev) => ({
            ...prev,
            loading: false,
            error: err instanceof Error ? err.message : '无法加载目录列表',
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // listing.path 变化（点击导航/编辑提交成功）且用户未在编辑输入时同步路径框
  useEffect(() => {
    if (!editingRef.current && state.listing) {
      setDraftPath(state.listing.path);
    }
  }, [state.listing?.path, state.listing]);

  const handleNavigate = useCallback(async (path: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const listing = await browseDirectory(path);
      setState((prev) => ({ ...prev, listing, loading: false }));
      editingRef.current = false;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : '无法加载目录',
      }));
    }
  }, []);

  // Edit path 提交：直填/粘贴绝对路径回车即直达（无匹配目录则提示错误保留输入）
  const handlePathSubmit = useCallback(async () => {
    const raw = draftPath.trim();
    if (!raw) return;
    editingRef.current = true;
    await handleNavigate(raw);
  }, [draftPath, handleNavigate]);

  const handleCreateFolder = useCallback(async () => {
    const name = state.newFolderName.trim();
    if (!name || !state.listing) return;
    setState((prev) => ({ ...prev, creating: true, error: null }));
    try {
      const created = await createWorkspaceDirectory(state.listing.path, name);
      const createdPath = typeof created === 'string' ? created : created.path;
      setState((prev) => ({
        ...prev,
        creating: false,
        newFolderName: '',
        listing: { ...prev.listing!, path: createdPath, home: prev.listing!.home, crumbs: prev.listing!.crumbs, entries: prev.listing!.entries, truncated: prev.listing!.truncated },
      }));
      await handleNavigate(createdPath);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        creating: false,
        error: err instanceof Error ? err.message : '创建文件夹失败',
      }));
    }
  }, [state.newFolderName, state.listing, handleNavigate]);

  const handleSelect = useCallback(
    (entry: DirectoryEntry) => {
      onSelect(entry.path);
      onClose();
    },
    [onSelect, onClose],
  );

  const crumbs = useMemo(() => {
    if (!state.listing) return [];
    return state.listing.crumbs;
  }, [state.listing]);

  const entries = useMemo(() => {
    if (!state.listing) return [];
    return state.listing.entries.filter((e) => !e.hidden).sort((a, b) => a.name.localeCompare(b.name));
  }, [state.listing]);

  return (
    <Modal
      onClose={onClose}
      ariaLabel="选择文件夹"
      width="min(430px, calc(100vw - 48px))"
      height="min(380px, calc(100vh - 48px))"
    >
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>选择文件夹</div>
        </div>

        {state.error && <div className={styles.error}>{state.error}</div>}

        <div className={styles.pathEditor}>
          <input
            className={styles.pathInput}
            type="text"
            spellCheck={false}
            placeholder="输入或粘贴绝对路径后回车，直达该目录"
            value={draftPath}
            onChange={(e) => {
              setDraftPath(e.target.value);
              editingRef.current = true;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handlePathSubmit();
            }}
            aria-label="编辑路径"
          />
          <button
            type="button"
            className={styles.pathGo}
            disabled={!draftPath.trim() || state.loading}
            onClick={() => void handlePathSubmit()}
          >
            {state.loading ? '加载中…' : '前往'}
          </button>
        </div>

        <div className={styles.crumbs}>
          {crumbs.map((crumb, idx) => (
            <button
              key={crumb.path}
              type="button"
              className={styles.crumb}
              onClick={() => handleNavigate(crumb.path)}
            >
              {idx === crumbs.length - 1 ? (
                <span className={styles.crumbCurrent}>{crumb.name}</span>
              ) : (
                <span>{crumb.name}</span>
              )}
              {idx < crumbs.length - 1 && <span className={styles.crumbSep}>/</span>}
            </button>
          ))}
        </div>

        <div className={styles.list}>
          {state.loading && <div className={styles.loading}>加载中…</div>}
          {!state.loading && entries.length === 0 && (
            <div className={styles.empty}>此文件夹为空</div>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={styles.row}
              onClick={() => handleNavigate(entry.path)}
              onDoubleClick={() => {
                // 虚拟"此电脑"层（path===''）上双击 = 进入该盘；真实目录双击 = 采纳
                if (state.listing?.path === '') {
                  void handleNavigate(entry.path);
                } else {
                  handleSelect(entry);
                }
              }}
              title={state.listing?.path === '' ? '进入此盘符' : '双击选择此文件夹'}
            >
              <span className={styles.icon}>📁</span>
              <span className={styles.name}>{entry.name}</span>
              <span className={styles.hint}>双击选择</span>
            </button>
          ))}
        </div>

        <div className={styles.footer}>
          <div className={styles.createRow}>
            <input
              className={styles.input}
              type="text"
              placeholder="新建文件夹名称"
              value={state.newFolderName}
              onChange={(e) => setState((prev) => ({ ...prev, newFolderName: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateFolder();
              }}
            />
            <button
              type="button"
              className={styles.createBtn}
              onClick={() => handleCreateFolder()}
              disabled={state.creating || !state.newFolderName.trim()}
            >
              {state.creating ? '创建中…' : '新建'}
            </button>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className={styles.confirmBtn}
              disabled={!state.listing || state.listing.path === ''}
              onClick={() => state.listing && onSelect(state.listing.path)}
            >
              选择当前文件夹
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
