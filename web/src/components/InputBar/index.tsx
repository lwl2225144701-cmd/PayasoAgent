import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { ChevronDownIcon, FolderIcon } from '../icons';
import { ComposerFooter, ComposerTextarea } from './ComposerParts';
import type { ModelProviderView, ModelSelection, PermissionMode } from '../../types';
import styles from './InputBar.module.css';

interface InputBarProps {
  onSend: (text: string) => void;
  onStop?: () => void;
  isRunning?: boolean;
  // v1.6 True cancellation：停止请求已发出、执行尚未真正退出；停止按钮禁用
  isStopping?: boolean;
  disabled?: boolean;
  placeholder?: string;
  variant?: 'compact' | 'hero';
  workspaceName?: string;
  openingWorkspace?: boolean;
  onOpenWorkspace?: () => void;
  currentModel?: ModelSelection;
  models?: ModelProviderView[];
  onSelectModel?: (providerId: string, model: string) => void;
  permissionMode: PermissionMode;
  onSelectPermission: (mode: PermissionMode) => void;
}

export function InputBar({
  onSend,
  onStop,
  isRunning,
  isStopping,
  disabled,
  placeholder = '发消息或做任务... / 调用指令 @ 文件或对话',
  variant = 'compact',
  workspaceName,
  openingWorkspace,
  onOpenWorkspace,
  currentModel,
  models = [],
  onSelectModel,
  permissionMode,
  onSelectPermission,
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
          <ComposerTextarea
            ref={textareaRef}
            variant="hero"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus
          />
          <ComposerFooter
            variant="hero"
            canSend={canSend}
            onSend={handleSend}
            currentModel={currentModel}
            models={models}
            onSelectModel={onSelectModel}
            permissionMode={permissionMode}
            onSelectPermission={onSelectPermission}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.inputBar}>
      <div className={styles.conversationComposer}>
        <ComposerTextarea
          ref={textareaRef}
          variant="conversation"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
        />
        <ComposerFooter
          variant="conversation"
          canSend={canSend}
          isRunning={isRunning}
          isStopping={isStopping}
          onSend={handleSend}
          onStop={onStop}
          currentModel={currentModel}
          models={models}
          onSelectModel={onSelectModel}
          permissionMode={permissionMode}
          onSelectPermission={onSelectPermission}
        />
      </div>
    </div>
  );
}
