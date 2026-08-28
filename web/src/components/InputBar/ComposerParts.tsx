import { forwardRef, useState, useRef, useEffect, type ChangeEventHandler, type KeyboardEventHandler } from 'react';
import type { ModelProviderView, ModelSelection } from '../../types';
import {
  ArrowUpIcon,
  ChevronDownIcon,
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
  onSend: () => void;
  onStop?: () => void;
  currentModel?: ModelSelection;
  models?: ModelProviderView[];
  onSelectModel?: (providerId: string, model: string) => void;
}

function PermissionButton() {
  return (
    <button
      className={styles.permissionButton}
      type="button"
      title="当前 Workspace 权限"
      aria-label="Workspace Write 权限"
    >
      <ShieldIcon size={16} />
      <span>Workspace Write</span>
      <ChevronDownIcon size={13} />
    </button>
  );
}

// 下拉按 provider × model 展平：每个可选条目是一个具体的 (provider, model) 组合。
// 只列出已配置密钥且有模型的 provider——未配置的选项选中后也会被后端回退，展示即误导。
function buildModelOptions(models: ModelProviderView[]): Array<{ providerId: string; providerName: string; model: string }> {
  return models
    .filter(p => p.hasApiKey && p.models.length > 0)
    .flatMap(p => p.models.map(model => ({ providerId: p.id, providerName: p.name, model })));
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

  const options = buildModelOptions(models);
  const isSelected = (option: { providerId: string; model: string }) =>
    currentModel?.providerId === option.providerId && currentModel?.model === option.model;
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
          {options.length === 0 ? (
            <div className={styles.modelDropdownEmpty}>请先在设置中配置 API 密钥</div>
          ) : (
            options.map(option => (
              <button
                key={`${option.providerId}:${option.model}`}
                type="button"
                className={styles.modelDropdownItem}
                role="option"
                aria-selected={isSelected(option)}
                onClick={() => {
                  onSelectModel?.(option.providerId, option.model);
                  setOpen(false);
                }}
              >
                <span className={styles.modelDropdownName}>{option.model}</span>
                <span className={styles.modelDropdownModel}>{option.providerName}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SubmitButton({ canSend, isRunning, onSend, onStop }: Omit<ComposerFooterProps, 'variant'>) {
  return isRunning ? (
    <IconButton
      buttonSize="lg"
      variant="surface"
      shape="circle"
      onClick={onStop}
      title="停止当前任务"
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
          <PermissionButton />
          <ModelButton currentModel={props.currentModel} models={props.models} onSelectModel={props.onSelectModel} />
        </div>
        <div className={styles.heroActions}>{action}</div>
      </div>
    );
  }

  return (
    <div className={styles.conversationFooter}>
      <PermissionButton />
      <div className={styles.conversationActions}>
        <ModelButton currentModel={props.currentModel} models={props.models} onSelectModel={props.onSelectModel} />
        {action}
      </div>
    </div>
  );
}
