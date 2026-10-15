import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ProviderModelInfo } from '../../types';
import { chatCatalogById, MAX_SYNC_MODELS, type ModelTag, mergeSyncSelection } from './helpers';

interface UseModelSyncOptions {
  /** 弹窗是否打开：关闭时复位对话框（避免下次打开残留上次的选择）。 */
  open: boolean;
  /** 当前表单标签：用于计算"保留的手工添加项"与同步后的模型总数。 */
  tags: ModelTag[];
  /** 用合并后的标签替换表单标签。 */
  onApplyTags: (tags: ModelTag[]) => void;
  /** 表单级错误位（目录为空 / 合并成功后清空）。 */
  setFormError: Dispatch<SetStateAction<string | null>>;
}

/** 模型目录同步对话框的状态与操作（探测结果在此呈现，确认后合并回表单）。 */
export interface ModelSyncState {
  syncDialogOpen: boolean;
  syncCatalog: ProviderModelInfo[];
  syncSelectedIds: string[];
  syncError: string | null;
  syncResultModelCount: number;
  setSyncError: Dispatch<SetStateAction<string | null>>;
  setSyncSelectedIds: Dispatch<SetStateAction<string[]>>;
  setSyncDialogOpen: Dispatch<SetStateAction<boolean>>;
  openSyncDialog: (catalog: ProviderModelInfo[], notice?: string | null) => void;
  applySyncSelection: () => void;
}

export function useModelSync({
  open,
  tags,
  onApplyTags,
  setFormError,
}: UseModelSyncOptions): ModelSyncState {
  const { t } = useI18n();
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncCatalog, setSyncCatalog] = useState<ProviderModelInfo[]>([]);
  const [syncSelectedIds, setSyncSelectedIds] = useState<string[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSyncDialogOpen(false);
      setSyncCatalog([]);
      setSyncSelectedIds([]);
      setSyncError(null);
    }
  }, [open]);

  const openSyncDialog = (catalog: ProviderModelInfo[], notice?: string | null) => {
    const chatCatalog = chatCatalogById(catalog);
    if (chatCatalog.length === 0) {
      setFormError(t('settings.models.noChatModels'));
      return;
    }
    // notice 用于"远端刷新失败已回退到内置目录"这类非阻断提示：随对话框一起呈现，
    // 不占用表单级错误位（表单级错误在对话框后面，用户看不到）。
    setSyncError(notice ?? null);
    setSyncCatalog(chatCatalog);
    setSyncSelectedIds(chatCatalog.map((model) => model.id));
    setSyncDialogOpen(true);
  };

  const syncResultModelCount = (() => {
    if (!syncDialogOpen) return tags.length;
    const syncedIds = new Set(syncCatalog.map((model) => model.id));
    const existingManualCount = tags.filter((tag) => !syncedIds.has(tag.value)).length;
    return existingManualCount + syncSelectedIds.length;
  })();

  const applySyncSelection = () => {
    const merged = mergeSyncSelection(tags, syncCatalog, syncSelectedIds, t, MAX_SYNC_MODELS);
    if ('error' in merged) {
      setSyncError(merged.error);
      return;
    }
    onApplyTags(merged.tags);
    setSyncDialogOpen(false);
    setSyncError(null);
    setFormError(null);
  };

  return {
    syncDialogOpen,
    syncCatalog,
    syncSelectedIds,
    syncError,
    syncResultModelCount,
    setSyncError,
    setSyncSelectedIds,
    setSyncDialogOpen,
    openSyncDialog,
    applySyncSelection,
  };
}
