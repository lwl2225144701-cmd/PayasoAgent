import { forwardRef, useState, useRef, useEffect, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import type { ModelProviderView, ModelSelection, PermissionMode } from '../../types';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CheckIcon,
  ShieldIcon,
  StopIcon,
} from '../icons';
import { IconButton } from '../IconButton';
import styles from './InputBar.module.css';

interface ComposerTextareaProps {
  variant: 'hero' | 'conversation';
  value: string;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

export const ComposerTextarea = forwardRef<HTMLTextAreaElement, ComposerTextareaProps>(
  function ComposerTextarea(
    { variant, value, onChange, onKeyDown, placeholder, disabled, autoFocus },
    ref,
  ) {
    return (
      <textarea
        ref={ref}
        className={variant === 'hero' ? styles.heroInput : styles.conversationInput}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
        autoFocus={autoFocus}
      />
    );
  },
);

interface ComposerFooterProps {
  variant: 'hero' | 'conversation';
  canSend: boolean;
  isRunning?: boolean;
  // v1.6 True cancellation：停止请求已发出，停止按钮禁用
  isStopping?: boolean;
  onSend: () => void;
  onStop?: () => void;
  currentModel?: ModelSelection;
  models?: ModelProviderView[];
  onSelectModel?: (providerId: string, model: string) => void;
  permissionMode: PermissionMode;
  onSelectPermission: (mode: PermissionMode) => void;
}

const PERMISSION_OPTIONS: Array<{ mode: PermissionMode; label: string; description: string }> = [
  { mode: 'read-only', label: 'Read Only', description: '只能读取 Workspace' },
  { mode: 'workspace-write', label: 'Workspace Write', description: '可以修改 Workspace' },
  { mode: 'full-access', label: 'Full access', description: '可以读写宿主文件系统' },
];

function PermissionButton({ mode, onSelect }: { mode: PermissionMode; onSelect: (mode: PermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const current = PERMISSION_OPTIONS.find(option => option.mode === mode) ?? PERMISSION_OPTIONS[1];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    if (!open) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const select = (next: PermissionMode) => {
    if (next === 'full-access' && mode !== 'full-access') {
      const confirmed = window.confirm(
        'Full access 允许 Agent 读取、修改和删除当前用户可访问的宿主文件。网络权限不会因此开放。\n\n确认启用 Full access？',
      );
      if (!confirmed) return;
    }
    onSelect(next);
    setOpen(false);
  };

  return (
    <div className={styles.permissionDropdown} ref={containerRef}>
      <button
        className={`${styles.permissionButton} ${mode === 'full-access' ? styles.permissionButtonDanger : ''}`}
        type="button"
        title={`当前文件系统权限：${current.label}`}
        aria-label={`${current.label} 权限`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <ShieldIcon size={16} />
        <span>{current.label}</span>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className={styles.permissionDropdownMenu} role="listbox" aria-label="文件系统权限">
          {PERMISSION_OPTIONS.map(option => (
            <button
              key={option.mode}
              type="button"
              className={`${styles.permissionDropdownItem} ${option.mode === 'full-access' ? styles.permissionDropdownItemDanger : ''}`}
              role="option"
              aria-selected={mode === option.mode}
              onClick={() => select(option.mode)}
            >
              <ShieldIcon size={17} />
              <span className={styles.permissionOptionText}>
                <span className={styles.permissionOptionLabel}>{option.label}</span>
                <span className={styles.permissionOptionDescription}>{option.description}</span>
              </span>
              {mode === option.mode && <CheckIcon size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 下拉按 Provider 分组：组标题 = Provider 名，组内是其模型目录。
// 只展示已配置密钥且有模型的 provider——未配置的选项选中后也会被后端回退，展示即误导。
function buildModelGroups(models: ModelProviderView[]): Array<{ providerId: string; providerName: string; models: string[] }> {
  return models
    .filter(p => p.hasApiKey && p.models.length > 0)
    .map(p => ({ providerId: p.id, providerName: p.name, models: p.models }));
}

function ModelButton({ currentModel, models = [], onSelectModel }: { currentModel?: ModelSelection; models?: ModelProviderView[]; onSelectModel?: (providerId: string, model: string) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const groups = buildModelGroups(models);
  const isSelected = (providerId: string, model: string) =>
    currentModel?.providerId === providerId && currentModel?.model === model;
  const label = currentModel
    ? (currentModel.model.length > 18 ? `${currentModel.model.slice(0, 16)}…` : currentModel.model)
    : '选择模型';

  return (
    <div className={styles.modelDropdown} ref={containerRef}>
      <button
        className={styles.modelButton}
        type="button"
        title={currentModel ? `当前模型：${currentModel.providerName} · ${currentModel.model}` : '选择模型'}
        aria-label={currentModel ? `${currentModel.providerName} ${currentModel.model} 模型` : '选择模型'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span>{label}</span>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div className={styles.modelDropdownMenu} role="listbox">
          {groups.length === 0 ? (
            <div className={styles.modelDropdownEmpty}>请先在设置中配置 API 密钥</div>
          ) : (
            groups.map(group => (
              <div key={group.providerId} className={styles.modelGroup}>
                <div className={styles.modelGroupTitle}>{group.providerName}</div>
                {group.models.map(model => (
                  <button
                    key={model}
                    type="button"
                    className={styles.modelDropdownItem}
                    role="option"
                    aria-selected={isSelected(group.providerId, model)}
                    onClick={() => {
                      onSelectModel?.(group.providerId, model);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.modelDropdownName}>{model}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SubmitButton({ canSend, isRunning, isStopping, onSend, onStop }: Omit<ComposerFooterProps, 'variant'>) {
  return isRunning ? (
    <IconButton
      buttonSize="lg"
      variant="surface"
      shape="circle"
      onClick={onStop}
      disabled={isStopping}
      title={isStopping ? '正在停止…' : '停止当前任务'}
    >
      <StopIcon size={16} />
    </IconButton>
  ) : (
    <IconButton
      buttonSize="lg"
      variant="brand"
      shape="circle"
      onClick={onSend}
      disabled={!canSend}
      title="发送（回车）"
    >
      <ArrowUpIcon size={20} />
    </IconButton>
  );
}

export function ComposerFooter(props: ComposerFooterProps) {
  const action = <SubmitButton {...props} />;

  if (props.variant === 'hero') {
    return (
      <div className={styles.heroFooter}>
        <div className={styles.heroTools}>
          <PermissionButton mode={props.permissionMode} onSelect={props.onSelectPermission} />
          <ModelButton currentModel={props.currentModel} models={props.models} onSelectModel={props.onSelectModel} />
        </div>
        <div className={styles.heroActions}>{action}</div>
      </div>
    );
  }

  return (
    <div className={styles.conversationFooter}>
      <PermissionButton mode={props.permissionMode} onSelect={props.onSelectPermission} />
      <div className={styles.conversationActions}>
        <ModelButton currentModel={props.currentModel} models={props.models} onSelectModel={props.onSelectModel} />
        {action}
      </div>
    </div>
  );
}
