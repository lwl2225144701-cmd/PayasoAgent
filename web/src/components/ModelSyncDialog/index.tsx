import type { ProviderModelInfo } from '../../types';
import styles from './ModelSyncDialog.module.css';

interface ModelSyncDialogProps {
  open: boolean;
  models: ProviderModelInfo[];
  selectedIds: string[];
  resultModelCount: number;
  maxModels: number;
  error?: string | null;
  onToggle: (modelId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function formatContextWindow(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M 上下文`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K 上下文`;
  return `${value} 上下文`;
}

export function ModelSyncDialog({
  open,
  models,
  selectedIds,
  resultModelCount,
  maxModels,
  error,
  onToggle,
  onSelectAll,
  onClearAll,
  onCancel,
  onConfirm,
}: ModelSyncDialogProps) {
  if (!open) return null;

  const selectedCount = selectedIds.length;
  const allSelected = selectedCount === models.length;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 遮罩用于承接点击关闭，键盘关闭由 Escape 处理 */}
      <div
        className={styles.backdrop}
        role="presentation"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onCancel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      >
        <div
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-sync-title"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onCancel();
              return;
            }
            event.stopPropagation();
          }}
        >
          <div className={styles.header}>
            <div>
              <h2 id="model-sync-title" className={styles.title}>
                选择同步模型
              </h2>
              <p className={styles.subtitle}>
                检测到 {models.length} 个对话模型，勾选后才会加入当前提供方。
              </p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={onCancel}
              aria-label="关闭"
            >
              ×
            </button>
          </div>

          <div className={styles.toolbar}>
            <span className={styles.count}>
              已选择 <strong>{selectedCount}</strong> / {models.length}
            </span>
            <div className={styles.toolbarActions}>
              <button
                type="button"
                className={styles.textButton}
                onClick={onSelectAll}
                disabled={allSelected}
              >
                全选
              </button>
              <button
                type="button"
                className={styles.textButton}
                onClick={onClearAll}
                disabled={selectedCount === 0}
              >
                清空
              </button>
            </div>
          </div>

          <div className={styles.list}>
            {models.map((model) => {
              const checked = selectedIds.includes(model.id);
              const contextWindow = formatContextWindow(model.contextWindow);
              return (
                <label
                  key={model.id}
                  className={`${styles.item} ${checked ? styles.itemChecked : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => onToggle(model.id, event.target.checked)}
                  />
                  <span className={styles.itemBody}>
                    <span className={styles.modelId}>{model.id}</span>
                    <span className={styles.meta}>
                      {contextWindow ?? '上下文未提供'}
                      {model.vision ? ' · 视觉' : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div
            className={`${styles.summary} ${resultModelCount > maxModels ? styles.summaryWarning : ''}`}
          >
            {resultModelCount > maxModels
              ? `当前选择 ${resultModelCount} 个模型；保存上限为 ${maxModels} 个，请继续调整勾选。`
              : `确认后当前表单将保留 ${resultModelCount} 个模型。`}
          </div>
          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={onCancel}>
              取消
            </button>
            <button type="button" className={styles.primaryButton} onClick={onConfirm}>
              同步已选模型
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
