import {
  type ChangeEventHandler,
  type ClipboardEventHandler,
  type CompositionEventHandler,
  forwardRef,
  type KeyboardEventHandler,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useI18n } from '../../i18n';
import type { Translate } from '../../i18n/translate';
import type {
  ContextUsageEvent,
  ModelProviderView,
  ModelSelection,
  PermissionMode,
} from '../../types';
import { DropdownTrigger } from '../DropdownTrigger';
import { IconButton } from '../IconButton';
import { ArrowUpIcon, StopIcon } from '../icons';
import { PermissionDropdown } from '../PermissionDropdown';
import { ContextUsageRing } from '../Timeline/ContextUsageRing';
import styles from './InputBar.module.css';

interface ComposerTextareaProps {
  variant: 'hero' | 'conversation';
  value: string;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  // 粘贴图片（截图）时拦截剪贴板中的图片项作为消息附件
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  // IME 组词生命周期：Enter 发送的三重保险判定依赖这两个信号
  onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

export const ComposerTextarea = forwardRef<HTMLTextAreaElement, ComposerTextareaProps>(
  function ComposerTextarea(
    {
      variant,
      value,
      onChange,
      onKeyDown,
      onPaste,
      onCompositionStart,
      onCompositionEnd,
      placeholder,
      disabled,
      autoFocus,
    },
    ref,
  ) {
    return (
      <textarea
        ref={ref}
        className={variant === 'hero' ? styles.heroInput : styles.conversationInput}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
        // biome-ignore lint/a11y/noAutofocus: 会话输入框自动聚焦为有意 UX（桌面单机应用）
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
  // v1.6 上下文预算环形指示器：当前 Run 最新 context_usage（无则不显示）
  contextUsage?: ContextUsageEvent;
  queuedCount?: number;
  permissionMode: PermissionMode;
  onSelectPermission: (mode: PermissionMode) => void;
}

function PermissionButton({
  mode,
  onSelect,
}: {
  mode: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
}) {
  return <PermissionDropdown mode={mode} onChange={onSelect} />;
}

// 下拉按 Provider 分组：组标题 = Provider 名，组内是其模型目录。
// 只展示已配置密钥且有模型的 provider——未配置的选项选中后也会被后端回退，展示即误导。
interface ModelOption {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface ModelGroup {
  providerId: string;
  providerName: string;
  models: ModelOption[];
}

function buildModelGroups(models: ModelProviderView[]): ModelGroup[] {
  return models
    .filter((p) => p.hasApiKey && p.models.length > 0)
    .map((p) => ({
      providerId: p.id,
      providerName: p.name,
      models: p.models.map((id) => ({ id, ...p.modelCapabilities?.[id] })),
    }));
}

// 能力摘要（上下文 / 输出上限）：K 为计数单位，文案跟随界面语言
function modelCapabilityLabel(
  model: Pick<ModelOption, 'contextWindow' | 'maxOutputTokens'>,
  t: Translate,
): string | null {
  if (model.contextWindow === undefined && model.maxOutputTokens === undefined) return null;
  const parts: string[] = [];
  if (model.contextWindow !== undefined) {
    parts.push(
      t('composer.model.contextWindow', { value: Math.round(model.contextWindow / 1000) }),
    );
  }
  if (model.maxOutputTokens !== undefined) {
    parts.push(t('composer.model.maxOutput', { value: Math.round(model.maxOutputTokens / 1000) }));
  }
  return parts.join(' · ');
}

function ModelButton({
  currentModel,
  models = [],
  onSelectModel,
}: {
  currentModel?: ModelSelection;
  models?: ModelProviderView[];
  onSelectModel?: (providerId: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

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
    ? currentModel.model.length > 18
      ? `${currentModel.model.slice(0, 16)}…`
      : currentModel.model
    : t('composer.model.select');
  const currentCapability = currentModel ? modelCapabilityLabel(currentModel, t) : null;

  return (
    <div className={styles.modelDropdown} ref={containerRef}>
      <DropdownTrigger
        label={label}
        title={
          currentModel
            ? `${t('composer.model.currentTitle', {
                provider: currentModel.providerName,
                model: currentModel.model,
              })}${currentCapability ? ` · ${currentCapability}` : ''}`
            : t('composer.model.select')
        }
        ariaLabel={
          currentModel
            ? t('composer.model.currentAria', {
                provider: currentModel.providerName,
                model: currentModel.model,
              })
            : t('composer.model.select')
        }
        open={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className={styles.modelDropdownMenu} role="listbox">
          {groups.length === 0 ? (
            <div className={styles.modelDropdownEmpty}>{t('composer.model.emptyApiKey')}</div>
          ) : (
            groups.map((group) => (
              <div key={group.providerId} className={styles.modelGroup}>
                <div className={styles.modelGroupTitle}>{group.providerName}</div>
                {group.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className={styles.modelDropdownItem}
                    role="option"
                    aria-selected={isSelected(group.providerId, model.id)}
                    title={`${group.providerName} · ${model.id}${modelCapabilityLabel(model, t) ? ` · ${modelCapabilityLabel(model, t)}` : ''}`}
                    onClick={() => {
                      onSelectModel?.(group.providerId, model.id);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.modelDropdownName}>{model.id}</span>
                    {modelCapabilityLabel(model, t) && (
                      <span className={styles.modelDropdownMeta}>
                        {modelCapabilityLabel(model, t)}
                      </span>
                    )}
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

function SubmitButton({
  canSend,
  isRunning,
  isStopping,
  queuedCount = 0,
  onSend,
  onStop,
}: Omit<ComposerFooterProps, 'variant'>) {
  const { t } = useI18n();
  if (isRunning) {
    if (canSend) {
      return (
        <IconButton
          buttonSize="lg"
          variant="brand"
          shape="circle"
          onClick={onSend}
          title={
            queuedCount > 0
              ? t('composer.submit.queueWithCount', { count: queuedCount })
              : t('composer.submit.queue')
          }
        >
          <ArrowUpIcon size={20} />
        </IconButton>
      );
    }

    return (
      <IconButton
        buttonSize="lg"
        variant="surface"
        shape="circle"
        onClick={onStop}
        disabled={isStopping}
        title={isStopping ? t('composer.submit.stopping') : t('composer.submit.stop')}
      >
        <StopIcon size={16} />
      </IconButton>
    );
  }

  return (
    <IconButton
      buttonSize="lg"
      variant="brand"
      shape="circle"
      onClick={onSend}
      disabled={!canSend}
      title={t('composer.submit.send')}
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
          <ModelButton
            currentModel={props.currentModel}
            models={props.models}
            onSelectModel={props.onSelectModel}
          />
        </div>
        <div className={styles.heroActions}>{action}</div>
      </div>
    );
  }

  return (
    <div className={styles.conversationFooter}>
      <PermissionButton mode={props.permissionMode} onSelect={props.onSelectPermission} />
      <div className={styles.conversationActions}>
        {props.contextUsage && <ContextUsageRing usage={props.contextUsage} />}
        <ModelButton
          currentModel={props.currentModel}
          models={props.models}
          onSelectModel={props.onSelectModel}
        />
        {action}
      </div>
    </div>
  );
}
