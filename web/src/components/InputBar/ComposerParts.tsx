import {
  forwardRef,
  type ChangeEventHandler,
  type KeyboardEventHandler,
} from 'react';
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
}

function PermissionButton() {
  return (
    <button className={styles.permissionButton} type="button" title="当前 Workspace 权限">
      <ShieldIcon size={16} />
      <span>Workspace Write</span>
      <ChevronDownIcon size={13} />
    </button>
  );
}

function ModelButton() {
  return (
    <button className={styles.modelButton} type="button" title="当前 Agent">
      <span>step-3.7-flash High</span>
      <ChevronDownIcon size={13} />
    </button>
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
          <ModelButton />
        </div>
        <div className={styles.heroActions}>{action}</div>
      </div>
    );
  }

  return (
    <div className={styles.conversationFooter}>
      <PermissionButton />
      <div className={styles.conversationActions}>
        <ModelButton />
        {action}
      </div>
    </div>
  );
}
