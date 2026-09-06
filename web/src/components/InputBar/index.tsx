import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ContextUsageEvent, ModelProviderView, ModelSelection, PermissionMode } from '../../types';
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
  permissionMode: PermissionMode;
  onSelectPermission: (mode: PermissionMode) => void;
}

export function InputBar({
  onSend,
  onStop,
  isRunning,
  isStopping,
  disabled,
  placeholder = '发消息或做任务... / 直接粘贴截图即可附带图片',
  variant = 'compact',
  workspaceName,
  openingWorkspace,
  onOpenWorkspace,
  currentModel,
  models = [],
  onSelectModel,
  visionSupported,
  contextUsage,
  permissionMode,
  onSelectPermission,
}: InputBarProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 附件状态用 ref 镜像一份，粘贴事件回调里始终读到最新值
  const attachmentsRef = useRef<PendingAttachment[]>([]);

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
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
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
      const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1] ?? 'png';
      const name = file.name?.trim() || `pasted-${Date.now()}.${ext}`;
      const blob = new File([file], name, { type: file.type });
      accepted.push({ id: crypto.randomUUID(), file: blob, url: URL.createObjectURL(blob) });
    }
    if (accepted.length > 0) commitAttachments([...attachmentsRef.current, ...accepted]);
    if (rejected.length > 0) alert(rejected.join('\n'));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
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
        当前模型未开启视觉能力，模型看不到图片。请在「设置 → 模型」中为该模型打开「视觉」开关，或切换到支持图片的模型。
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
          permissionMode={permissionMode}
          onSelectPermission={onSelectPermission}
        />
      </div>
    </div>
  );
}
