import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FolderIcon,
  KbdEnterIcon,
  PaperclipIcon,
  PlusIcon,
  ShieldIcon,
  StopIcon,
} from '../icons';
import { IconButton } from '../IconButton';
import styles from './InputBar.module.css';

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  isRunning?: boolean;
  disabled?: boolean;
  placeholder?: string;
  variant?: 'compact' | 'hero';
  workspaceName?: string;
  openingWorkspace?: boolean;
  onOpenWorkspace?: () => void;
}

export function InputBar({
  onSend,
  onStop,
  isRunning,
  disabled,
  placeholder = '输入任务…',
  variant = 'compact',
  workspaceName,
  openingWorkspace,
  onOpenWorkspace,
}: InputBarProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }, [text]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  }

  const canSend = text.trim().length > 0 && !disabled;

  if (variant === 'hero') {
    return (
      <div className={styles.heroComposer}>
        <div className={styles.heroMetaRow}>
          <button
            className={styles.metaButton}
            type="button"
            onClick={onOpenWorkspace}
            disabled={openingWorkspace}
            title={workspaceName ? '更换 Workspace' : '选择 Workspace'}
          >
            <FolderIcon size={17} />
            <span>{openingWorkspace ? '正在打开…' : workspaceName ?? '选择 Workspace'}</span>
            <ChevronDownIcon size={13} />
          </button>
        </div>

        <div className={styles.heroInputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.heroInput}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={2}
            disabled={disabled}
            autoFocus
          />

          <div className={styles.heroFooter}>
            <div className={styles.heroTools}>
              <IconButton
                buttonSize="lg"
                variant="surface"
                shape="circle"
                title="添加附件（即将上线）"
              >
                <PlusIcon size={20} />
              </IconButton>
              <button className={styles.permissionButton} type="button" title="当前 Workspace 权限">
                <ShieldIcon size={16} />
                <span>Workspace Write</span>
                <ChevronDownIcon size={13} />
              </button>
            </div>

            <div className={styles.heroActions}>
              <button className={styles.modelButton} type="button" title="当前 Agent">
                <span>Payaso Agent</span>
                <ChevronDownIcon size={13} />
              </button>
              <IconButton
                buttonSize="lg"
                variant="brand"
                shape="circle"
                onClick={handleSend}
                disabled={!canSend}
                title="发送（回车）"
              >
                <ArrowUpIcon size={20} />
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.inputBar}>
      <div className={styles.inputWrapper}>
        <IconButton buttonSize="sm" variant="ghost" shape="rounded" title="附件（即将上线）">
          <PaperclipIcon size={18} />
        </IconButton>
        <textarea
          ref={textareaRef}
          className={styles.input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
        />
        <div className={styles.actions}>
          {isRunning ? (
            <IconButton
              buttonSize="md"
              variant="surface"
              shape="circle"
              onClick={onStop}
              title="停止当前任务"
            >
              <StopIcon size={16} />
            </IconButton>
          ) : (
            <>
              <IconButton
                buttonSize="md"
                variant="brand"
                shape="circle"
                onClick={handleSend}
                disabled={!canSend}
                title="发送（回车）"
              >
                <ArrowUpIcon size={18} />
              </IconButton>
              <span className={styles.kbdHint} title="Enter to send · Shift+Enter for new line">
                <KbdEnterIcon size={18} />
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
