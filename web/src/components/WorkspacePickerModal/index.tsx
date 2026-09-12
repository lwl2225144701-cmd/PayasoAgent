import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browseDirectory,
  createWorkspaceDirectory,
  type DirectoryEntry,
  type DirectoryListing,
} from '../../api';
import { useI18n } from '../../i18n';
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
  const { t } = useI18n();
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
            error: err instanceof Error ? err.message : t('shell.picker.loadListFailed'),
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  // listing.path 变化（点击导航/编辑提交成功）且用户未在编辑输入时同步路径框
  useEffect(() => {
    if (!editingRef.current && state.listing) {
      setDraftPath(state.listing.path);
    }
  }, [state.listing?.path, state.listing]);

  const handleNavigate = useCallback(
    async (path: string) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const listing = await browseDirectory(path);
        setState((prev) => ({ ...prev, listing, loading: false }));
        editingRef.current = false;
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : t('shell.picker.loadFailed'),
        }));
      }
    },
    [t],
  );

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
        listing: {
          ...prev.listing!,
          path: createdPath,
        },
      }));
      await handleNavigate(createdPath);
    } catch (err) {
      setState((prev) => ({
        ...prev,
        creating: false,
        error: err instanceof Error ? err.message : t('shell.picker.createFailed'),
      }));
    }
  }, [state.newFolderName, state.listing, handleNavigate, t]);

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
    return state.listing.entries
      .filter((e) => !e.hidden)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [state.listing]);

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('shell.picker.title')}
      width="min(430px, calc(100vw - 48px))"
      height="min(380px, calc(100vh - 48px))"
    >
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>{t('shell.picker.title')}</div>
        </div>

        {state.error && <div className={styles.error}>{state.error}</div>}

        <div className={styles.pathEditor}>
          <input
            className={styles.pathInput}
            type="text"
            spellCheck={false}
            placeholder={t('shell.picker.pathPlaceholder')}
            value={draftPath}
            onChange={(e) => {
              setDraftPath(e.target.value);
              editingRef.current = true;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handlePathSubmit();
            }}
            aria-label={t('shell.picker.pathLabel')}
          />
          <button
            type="button"
            className={styles.pathGo}
            disabled={!draftPath.trim() || state.loading}
            onClick={() => void handlePathSubmit()}
          >
            {state.loading ? t('common.loading') : t('shell.picker.go')}
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
          {state.loading && <div className={styles.loading}>{t('common.loading')}</div>}
          {!state.loading && entries.length === 0 && (
            <div className={styles.empty}>{t('shell.picker.empty')}</div>
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
              title={
                state.listing?.path === ''
                  ? t('shell.picker.enterDrive')
                  : t('shell.picker.doubleClickSelect')
              }
            >
              <span className={styles.icon}>📁</span>
              <span className={styles.name}>{entry.name}</span>
              <span className={styles.hint}>{t('shell.picker.doubleClickHint')}</span>
            </button>
          ))}
        </div>

        <div className={styles.footer}>
          <div className={styles.createRow}>
            <input
              className={styles.input}
              type="text"
              placeholder={t('shell.picker.newFolderPlaceholder')}
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
              {state.creating ? t('shell.picker.creating') : t('shell.picker.create')}
            </button>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={styles.confirmBtn}
              disabled={!state.listing || state.listing.path === ''}
              onClick={() => state.listing && onSelect(state.listing.path)}
            >
              {t('shell.picker.selectCurrent')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
