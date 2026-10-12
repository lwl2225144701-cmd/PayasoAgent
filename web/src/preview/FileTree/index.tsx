// FileTree：面包屑 + 单层目录列表（对照截图 2 的形态）。
// 懒加载语义：只加载当前展示的这一层，点击目录才请求下一级，从不拉全树。

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon, CloseIcon, FolderIcon, SearchIcon } from '../../components/icons';
import { formatBytes } from '../../format';
import { useI18n } from '../../i18n';
import { useFileTree } from '../hooks/useFileTree';
import { FileIconFor, fileIconName } from '../registry';
import type { PreviewTreeError } from '../types';
import styles from './FileTree.module.css';

export interface FileTreeProps {
  /** 点击文件：在 dock 里打开标签。 */
  onOpenFile: (path: string, name: string) => void;
  /** 请求宿主打开/选择工作区（no_workspace 时面板里给出的出路；缺省不显示按钮）。 */
  onRequestWorkspace?: () => void;
  /** 预览作用域：当前会话 Run（见 PreviewDock）。 */
  runId?: string | null;
  /** 变更批次信号：>0 时刷新当前目录列表（值变化才触发，见内部守卫）。 */
  refreshSignal?: number;
}

function errorTextKey(code: PreviewTreeError | null): string {
  switch (code) {
    case 'no_workspace':
      return 'preview.tree.error.no_workspace';
    case 'not_found':
      return 'preview.tree.error.not_found';
    case 'outside_workspace':
      return 'preview.tree.error.outside_workspace';
    case 'invalid_path':
      return 'preview.tree.error.invalid_path';
    default:
      return 'preview.tree.error.generic';
  }
}

export default function FileTree({
  onOpenFile,
  onRequestWorkspace,
  runId,
  refreshSignal,
}: FileTreeProps) {
  const { t } = useI18n();
  const {
    currentPath,
    listing,
    loading,
    errorCode,
    includeIgnored,
    navigate,
    refresh,
    setIncludeIgnored,
  } = useFileTree(runId);
  const [filter, setFilter] = useState('');
  // 变更流信号 → 刷新当前目录（值变化守卫，避免 effect 依赖不稳定导致的空转）
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (refreshSignal && refreshSignal !== lastSignalRef.current) {
      lastSignalRef.current = refreshSignal;
      refresh();
    }
  }, [refreshSignal, refresh]);

  const segments = useMemo(
    () => (currentPath.length > 0 ? currentPath.split('/') : []),
    [currentPath],
  );

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    const needle = filter.trim().toLowerCase();
    const matched =
      needle.length === 0 ? all : all.filter((entry) => entry.name.toLowerCase().includes(needle));
    // 展示层混排（目录/文件按名称一起排，对齐 DSH 的面板列表）；后端契约仍是目录在前
    return [...matched].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [listing, filter]);

  return (
    <div className={styles.tree}>
      <div className={styles.toolbar}>
        <nav className={styles.crumbs} aria-label={t('preview.tree.root')}>
          <button
            type="button"
            className={`${styles.crumb} ${segments.length === 0 ? styles.crumbActive : ''}`}
            onClick={() => navigate('')}
          >
            {listing?.workspace || t('preview.tree.root')}
          </button>
          {segments.map((seg, i) => {
            const segPath = segments.slice(0, i + 1).join('/');
            const isLast = i === segments.length - 1;
            return (
              <span className={styles.crumbItem} key={segPath}>
                <ChevronRightIcon size={12} />
                <button
                  type="button"
                  className={`${styles.crumb} ${isLast ? styles.crumbActive : ''}`}
                  onClick={() => navigate(segPath)}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </nav>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={refresh}
          title={t('preview.tree.refresh')}
          aria-label={t('preview.tree.refresh')}
        >
          ⟳
        </button>
      </div>

      <div className={styles.filterRow}>
        <SearchIcon size={13} />
        <input
          className={styles.filterInput}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('preview.tree.filter')}
          aria-label={t('preview.tree.filter')}
        />
        {filter && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setFilter('')}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <CloseIcon size={12} />
          </button>
        )}
        <label className={styles.ignoredToggle}>
          <input
            type="checkbox"
            checked={includeIgnored}
            onChange={(event) => setIncludeIgnored(event.target.checked)}
          />
          {t('preview.tree.showIgnored')}
        </label>
      </div>

      <div className={styles.list}>
        {loading && <div className={styles.hint}>{t('preview.tree.loading')}</div>}
        {!loading && errorCode && (
          <div className={styles.hint}>
            {t(errorTextKey(errorCode) as 'preview.tree.error.generic')}
            {errorCode === 'no_workspace' && onRequestWorkspace && (
              <button type="button" className={styles.openWorkspace} onClick={onRequestWorkspace}>
                {t('preview.tree.selectWorkspace')}
              </button>
            )}
          </div>
        )}
        {!loading && !errorCode && entries.length === 0 && (
          <div className={styles.hint}>{t('preview.tree.empty')}</div>
        )}
        {!loading &&
          !errorCode &&
          entries.map((entry) => (
            <button
              type="button"
              key={entry.path}
              className={styles.row}
              onClick={() =>
                entry.kind === 'dir' ? navigate(entry.path) : onOpenFile(entry.path, entry.name)
              }
            >
              <span className={`${styles.rowIcon} ${entry.kind === 'dir' ? styles.dirIcon : ''}`}>
                {entry.kind === 'dir' ? (
                  <FolderIcon size={15} />
                ) : (
                  <FileIconFor name={fileIconName(entry.name)} size={15} />
                )}
              </span>
              <span className={`${styles.rowName} ${entry.hidden ? styles.rowHidden : ''}`}>
                {entry.name}
              </span>
              {entry.kind === 'file' && entry.size !== undefined && (
                <span className={styles.rowSize}>{formatBytes(entry.size)}</span>
              )}
            </button>
          ))}
        {listing?.truncated && (
          <div className={styles.hint}>{t('preview.tree.truncated', { max: 500 })}</div>
        )}
      </div>
    </div>
  );
}
