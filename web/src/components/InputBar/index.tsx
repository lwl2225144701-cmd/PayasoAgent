import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { listPromptCommands } from '../../api';
import type {
  ContextUsageEvent,
  ModelProviderView,
  ModelSelection,
  PermissionMode,
  PromptCommand,
} from '../../types';
import { ChevronDownIcon, CloseIcon, FolderIcon } from '../icons';
import { ComposerFooter, ComposerTextarea } from './ComposerParts';
import styles from './InputBar.module.css';

// 与 Host 侧约束保持一致（routes.ts：MAX_ATTACHMENTS / MAX_IMAGE_FILE_BYTES / ATTACHMENT_MIME）
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// 用户只发图不写字时的兜底任务文案（图片始终作为用户消息附件进入模型上下文）
const IMAGE_ONLY_TASK = '请分析附带的图片。';

interface PendingAttachment {
  id: string;
  file: File;
  /** object URL，仅用于发送前的本地预览 */
  url: string;
}

export interface QueuedComposerMessage {
  id: string;
  task: string;
  attachments?: File[];
}

interface InputBarProps {
  onSend: (text: string, attachments?: File[]) => void;
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
  // 当前模型是否支持图片输入（显式开关 > pi-ai 注册表）；粘贴了图片但不支持时给出警告
  visionSupported?: boolean;
  // 上下文预算环形指示器（当前 Run 最新 context_usage；无则不显示）
  contextUsage?: ContextUsageEvent;
  // 当前 Run 执行时，新提交的消息会进入会话发送队列
  queuedCount?: number;
  queuedMessages?: QueuedComposerMessage[];
  onSendQueuedNow?: (messageId: string) => void;
  onDeleteQueued?: (messageId: string) => void;
  permissionMode: PermissionMode;
  onSelectPermission: (mode: PermissionMode) => void;
}

export function InputBar({
  onSend,
  onStop,
  isRunning,
  isStopping,
  disabled,
  placeholder = '发消息或做任务... / Enter 换行，⌘/Ctrl+Enter 发送',
  variant = 'compact',
  workspaceName,
  openingWorkspace,
  onOpenWorkspace,
  currentModel,
  models = [],
  onSelectModel,
  visionSupported,
  contextUsage,
  queuedCount = 0,
  queuedMessages = [],
  onSendQueuedNow,
  onDeleteQueued,
  permissionMode,
  onSelectPermission,
}: InputBarProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 附件状态用 ref 镜像一份，粘贴事件回调里始终读到最新值
  const attachmentsRef = useRef<PendingAttachment[]>([]);

  // ===== Prompt 命令补全（/cmd 前缀） =====
  const [promptCommands, setPromptCommands] = useState<PromptCommand[]>([]);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptIndex, setPromptIndex] = useState(0);
  const promptLoadedRef = useRef(false);
  const suggestRef = useRef<HTMLDivElement>(null);

  // 命令列表懒加载一次（工作区级元数据，量小）
  useEffect(() => {
    if (promptLoadedRef.current) return;
    promptLoadedRef.current = true;
    listPromptCommands()
      .then(({ prompts }) => setPromptCommands(prompts))
      .catch(() => setPromptCommands([]));
  }, []);

  // 当前输入匹配的命令：第一个词以 / 开头且没有空格 → 进入补全模式
  const firstWord = text.split(/\s/)[0] ?? '';
  const isPromptPrefix = firstWord.startsWith('/') && firstWord.length > 1;
  const filteredPrompts = isPromptPrefix
    ? promptCommands.filter((c) => c.name.startsWith(firstWord.slice(1).toLowerCase()))
    : [];

  // 输入变化时同步 open / 重置高亮
  useEffect(() => {
    if (isPromptPrefix && filteredPrompts.length > 0) {
      setPromptOpen(true);
      setPromptIndex((i) => Math.min(i, filteredPrompts.length - 1));
    } else {
      setPromptOpen(false);
    }
  }, [isPromptPrefix, filteredPrompts.length]);

  // 点击外部关闭补全
  useEffect(() => {
    if (!promptOpen) return;
    const onClick = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node)) {
        setPromptOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [promptOpen]);

  function applyPromptSelection(cmd: PromptCommand) {
    // 把当前输入的第一个词替换为 /cmd + 空格，光标移到末尾
    const rest = text.slice(firstWord.length);
    setText(`/${cmd.name} ${rest.replace(/^\s/, '')}`);
    setPromptOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) ta.focus();
    });
  }

  // 在 handleSend 之前拦截：补全打开时 Enter 选中命令；↑↓ 导航；Esc 关闭
  function handlePromptKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!promptOpen || filteredPrompts.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPromptIndex((i) => (i + 1) % filteredPrompts.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPromptIndex((i) => (i - 1 + filteredPrompts.length) % filteredPrompts.length);
      return true;
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      applyPromptSelection(filteredPrompts[promptIndex] ?? filteredPrompts[0]);
      return true;
    }
    if (e.key === 'Escape') {
      setPromptOpen(false);
      return true;
    }
    return false;
  }

  // 卸载时释放全部 object URL，避免内存泄漏
  useEffect(() => {
    return () => {
      for (const item of attachmentsRef.current) URL.revokeObjectURL(item.url);
      attachmentsRef.current = [];
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 高度依赖 text（经 textarea.scrollHeight 间接使用），[text] 为必要语义
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
  }, [text]);

  function commitAttachments(next: PendingAttachment[]) {
    attachmentsRef.current = next;
    setAttachments(next);
  }

  function clearAttachments() {
    for (const item of attachmentsRef.current) URL.revokeObjectURL(item.url);
    commitAttachments([]);
  }

  function removeAttachment(id: string) {
    const target = attachmentsRef.current.find((item) => item.id === id);
    if (target) URL.revokeObjectURL(target.url);
    commitAttachments(attachmentsRef.current.filter((item) => item.id !== id));
  }

  // 粘贴截图：剪贴板里的图片项直接成为消息附件（不经过文件选择器）。
  // 纯文本粘贴不拦截，保持原有输入行为。
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();

    const accepted: PendingAttachment[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (attachmentsRef.current.length + accepted.length >= MAX_ATTACHMENTS) {
        rejected.push(`最多附带 ${MAX_ATTACHMENTS} 张图片`);
        break;
      }
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        rejected.push(`${file.name || '剪贴板图片'}：仅支持 PNG / JPEG / WebP / GIF`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejected.push(`${file.name || '剪贴板图片'}：超过 8MB 上限`);
        continue;
      }
      // 截图剪贴板通常没有文件名，兜底一个带时间戳的名字（后缀与 MIME 对齐）
      const ext = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] ?? 'png');
      const name = file.name?.trim() || `pasted-${Date.now()}.${ext}`;
      const blob = new File([file], name, { type: file.type });
      accepted.push({ id: crypto.randomUUID(), file: blob, url: URL.createObjectURL(blob) });
    }
    if (accepted.length > 0) commitAttachments([...attachmentsRef.current, ...accepted]);
    if (rejected.length > 0) alert(rejected.join('\n'));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // 补全下拉优先：打开时 Enter/↑↓/Esc 属于命令选择，不触发发送
    if (handlePromptKeyDown(e)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = text.trim();
    if (disabled) return;
    if (!trimmed && attachmentsRef.current.length === 0) return;
    const files = attachmentsRef.current.map((item) => item.file);
    onSend(
      trimmed || (files.length > 0 ? IMAGE_ONLY_TASK : ''),
      files.length > 0 ? files : undefined,
    );
    setText('');
    clearAttachments();
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  const attachmentStrip =
    attachments.length > 0 ? (
      <div className={styles.attachmentStrip}>
        {attachments.map((item) => (
          <div key={item.id} className={styles.attachmentChip}>
            <img
              src={item.url}
              alt={item.file.name}
              className={styles.attachmentThumb}
              title={item.file.name}
            />
            <button
              type="button"
              className={styles.attachmentRemove}
              title="移除图片"
              onClick={() => removeAttachment(item.id)}
            >
              <CloseIcon size={11} />
            </button>
          </div>
        ))}
      </div>
    ) : null;

  // 已粘贴图片但当前模型不支持视觉：图片发出去模型也看不到，发送前明确提示
  const visionWarning =
    attachments.length > 0 && visionSupported === false ? (
      <div className={styles.visionWarning}>
        当前模型未开启视觉能力，模型看不到图片。请在「设置 →
        模型」中为该模型打开「视觉」开关，或切换到支持图片的模型。
      </div>
    ) : null;

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
            <span>{openingWorkspace ? '正在打开…' : (workspaceName ?? '选择 Workspace')}</span>
            <ChevronDownIcon size={13} />
          </button>
        </div>

        <div className={styles.heroInputWrapper}>
          {attachmentStrip}
          {visionWarning}
          <ComposerTextarea
            ref={textareaRef}
            variant="hero"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus
          />
          {promptOpen && filteredPrompts.length > 0 && (
            <div ref={suggestRef} className={styles.promptSuggestMenu} role="listbox">
              {filteredPrompts.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  className={styles.promptSuggestItem}
                  role="option"
                  aria-selected={i === promptIndex}
                  onMouseEnter={() => setPromptIndex(i)}
                  onClick={() => applyPromptSelection(cmd)}
                >
                  <span className={styles.promptSuggestName}>/{cmd.name}</span>
                  {cmd.description && (
                    <span className={styles.promptSuggestDesc}>{cmd.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
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
    <div className={`${styles.inputBar} ${styles.conversationBar}`}>
      <div className={styles.conversationComposer}>
        {attachmentStrip}
        {visionWarning}
        {queuedMessages.length > 0 && (
          <div className={styles.queuePanel} role="status" aria-label="发送队列">
            <div className={styles.queueNotice}>
              已加入发送队列 · {queuedMessages.length} 条消息等待中
            </div>
            <div className={styles.queueList}>
              {queuedMessages.map((message, index) => (
                <div className={styles.queueItem} key={message.id}>
                  <div className={styles.queueItemContent}>
                    <span className={styles.queueItemIndex}>{index + 1}</span>
                    <span className={styles.queueItemText} title={message.task}>
                      {message.task}
                    </span>
                  </div>
                  <div className={styles.queueItemActions}>
                    <button
                      type="button"
                      className={styles.queueAction}
                      onClick={() => onSendQueuedNow?.(message.id)}
                      title="当前任务结束后优先发送"
                    >
                      立即发送
                    </button>
                    <button
                      type="button"
                      className={`${styles.queueAction} ${styles.queueDelete}`}
                      onClick={() => onDeleteQueued?.(message.id)}
                      title="从发送队列删除"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <ComposerTextarea
          ref={textareaRef}
          variant="conversation"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
        />
        {promptOpen && filteredPrompts.length > 0 && (
          <div ref={suggestRef} className={styles.promptSuggestMenu} role="listbox">
            {filteredPrompts.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                className={styles.promptSuggestItem}
                role="option"
                aria-selected={i === promptIndex}
                onMouseEnter={() => setPromptIndex(i)}
                onClick={() => applyPromptSelection(cmd)}
              >
                <span className={styles.promptSuggestName}>/{cmd.name}</span>
                {cmd.description && (
                  <span className={styles.promptSuggestDesc}>{cmd.description}</span>
                )}
              </button>
            ))}
          </div>
        )}
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
          contextUsage={contextUsage}
          queuedCount={queuedCount}
          permissionMode={permissionMode}
          onSelectPermission={onSelectPermission}
        />
      </div>
    </div>
  );
}
