import {
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { listPromptCommands } from '../../api';
import {
  type CommandCandidate,
  matchBuiltinCommand,
  mergeCommandCandidates,
} from '../../commands/builtin-commands';
import { useI18n } from '../../i18n';
import type {
  ContextUsageEvent,
  ModelProviderView,
  ModelSelection,
  PermissionMode,
  PromptCommand,
} from '../../types';
import { ChevronDownIcon, CloseIcon, FolderIcon } from '../icons';
import { ComposerFooter, ComposerTextarea } from './ComposerParts';
import { isImeComposing, resolveEnterAction } from './enter-key';
import styles from './InputBar.module.css';

import { attachmentKind, attachmentSizeLabel, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from '../../../../src/attachment-policy';

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
  /** 返回 Promise<boolean> 时：resolve(false) = 创建失败（App 侧已提示），发送框据此还原草稿 */
  onSend: (text: string, attachments?: File[]) => Promise<boolean> | undefined;
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
  // 内置斜杠命令执行器：发送 /cmd 时被拦截调用（不作为任务发给模型）
  onBuiltinCommand?: (name: string, args: string) => void;
  // 输入框上方的附加内容（如"当前计划"面板）；宽度与输入框对齐，随输入区一起滚动/固定
  headerSlot?: ReactNode;
  // 输入框下方的附加内容（如会话统计条）；留在同一块底部 dock 内，复用其渐变底
  footerSlot?: ReactNode;
}

export function InputBar({
  onSend,
  onStop,
  isRunning,
  isStopping,
  disabled,
  placeholder,
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
  onBuiltinCommand,
  headerSlot,
  footerSlot,
}: InputBarProps) {
  const { t } = useI18n();
  // 未传 placeholder 时用跟随语言的默认占位符（传了就尊重调用方，如 hero 态的定制文案）
  const activePlaceholder = placeholder ?? t('composer.placeholder');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 附件状态用 ref 镜像一份，粘贴事件回调里始终读到最新值
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  // ===== 发送进行中标志：上一次 onSend 未落定前，再次 Enter/点击不重复发送 =====
  const sendingRef = useRef(false);
  // ===== IME 组词状态（Enter 发送的三重保险之一） =====
  const composingRef = useRef(false);
  // Safari 确认组词的收尾 keydown 在 compositionend 之后派发，记一个 10ms 时间窗吞掉它
  const compositionUntilRef = useRef(0);

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

  // 当前输入匹配的命令：第一个词以 / 开头 → 进入补全模式（裸 / 即展示全量列表）
  // 内置命令优先，其后是工作区提示词模板
  const firstWord = text.split(/\s/)[0] ?? '';
  const isPromptPrefix = firstWord.startsWith('/');
  const filteredPrompts: CommandCandidate[] = isPromptPrefix
    ? mergeCommandCandidates(firstWord.slice(1), promptCommands)
    : [];
  // 输入已与唯一候选完全一致 → 收起菜单（否则选中后菜单会一直挂在原命令上）
  const exactCommandTyped =
    filteredPrompts.length === 1 && filteredPrompts[0].name === firstWord.slice(1);

  // 输入变化时同步 open / 重置高亮
  useEffect(() => {
    if (isPromptPrefix && filteredPrompts.length > 0 && !exactCommandTyped) {
      setPromptOpen(true);
      setPromptIndex((i) => Math.min(i, filteredPrompts.length - 1));
    } else {
      setPromptOpen(false);
    }
  }, [isPromptPrefix, exactCommandTyped, filteredPrompts.length]);

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

  function applyPromptSelection(cmd: { name: string }) {
    // 把当前输入的第一个词替换为 /cmd + 空格，光标移到末尾。
    // 内置命令也在补全里展示：插入后由用户补参数，发送时被 onBuiltinCommand 拦截执行。
    const rest = text.slice(firstWord.length);
    setText(`/${cmd.name} ${rest.replace(/^\s/, '')}`);
    setPromptOpen(false);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) ta.focus();
    });
  }

  // 在 handleSend 之前拦截：补全打开时 Enter 选中命令；↑↓ 导航；Esc 关闭。
  // 组词期的按键（含 ↑↓/Esc）属于输入法候选操作，一律交还输入法，不导航菜单。
  function handlePromptKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeComposingEvent(e)) return false;
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
    if (e.key === 'Enter') {
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

  // IME 三重保险：isComposing / keyCode 229（旧引擎）/ compositionend 后 Safari 收尾 keydown 的时间窗
  function isImeComposingEvent(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    return isImeComposing(
      e.nativeEvent,
      composingRef.current,
      compositionUntilRef.current,
      Date.now(),
    );
  }

  function handleCompositionStart(_e: CompositionEvent<HTMLTextAreaElement>) {
    composingRef.current = true;
  }

  function handleCompositionEnd(_e: CompositionEvent<HTMLTextAreaElement>) {
    composingRef.current = false;
    // Safari：确认组词的那条 Enter 在 compositionend 之后才派发，留 10ms 窗口把它吞掉
    compositionUntilRef.current = Date.now() + 10;
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

  function removeAttachment(id: string) {
    const target = attachmentsRef.current.find((item) => item.id === id);
    if (target) URL.revokeObjectURL(target.url);
    commitAttachments(attachmentsRef.current.filter((item) => item.id !== id));
  }

  // 粘贴文件和拖放共用接收逻辑；纯文本和文本拖动不拦截。
  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    if (!disabled) acceptFiles(files);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (disabled) return;
    const items = Array.from(e.dataTransfer.items);
    if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      alert(t('composer.attachment.directory'));
      return;
    }
    acceptFiles(Array.from(e.dataTransfer.files));
  }

  function acceptFiles(files: File[]) {
    const accepted: PendingAttachment[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (attachmentsRef.current.length + accepted.length >= MAX_ATTACHMENTS) {
        rejected.push(t('composer.attachment.tooMany', { count: MAX_ATTACHMENTS }));
        break;
      }
      const kind = attachmentKind(file.name, file.type);
      if (!kind) {
        rejected.push(
          t('composer.attachment.unsupportedType', {
            name: file.name || t('composer.attachment.clipboardName'),
          }),
        );
        continue;
      }
      if (file.size > (kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES)) {
        rejected.push(
          t(kind === 'image' ? 'composer.attachment.tooLarge' : 'composer.attachment.textTooLarge', {
            name: file.name || t('composer.attachment.clipboardName'),
          }),
        );
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

  // Enter 发送 + 输入法安全的键位判定：优先级表见 ./enter-key.ts（有确定性测试锁定）
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const action = resolveEnterAction({
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      repeat: e.repeat,
      isComposing: isImeComposingEvent(e),
      menuOpen: promptOpen && filteredPrompts.length > 0,
      locked: disabled === true || sendingRef.current,
      draftEmpty: !text.trim() && attachmentsRef.current.length === 0,
    });

    switch (action) {
      case 'pass':
        // 非 Enter（↑↓/Esc 仍需喂给补全菜单）与 Shift+Enter：不拦截，浏览器默认行为（换行）
        if (e.key !== 'Enter') handlePromptKeyDown(e);
        return;
      case 'swallow':
        // 组词期 / 长按连发 / Ctrl+Cmd 保留键 / 会话锁定 / 空草稿：吃掉，不发送也不换行
        e.preventDefault();
        return;
      case 'menu':
        // 补全菜单打开：Enter 选中高亮项（内部 preventDefault；无候选时不会进入此分支）
        handlePromptKeyDown(e);
        return;
      case 'send':
        e.preventDefault();
        handleSend();
        return;
    }
  }

  function handleSend() {
    const trimmed = text.trim();
    if (disabled) return;
    // 内置斜杠命令拦截：/cmd 由客户端执行，不作为任务发给模型
    const builtin = matchBuiltinCommand(trimmed);
    if (builtin) {
      onBuiltinCommand?.(builtin.name, builtin.args);
      setText('');
      setPromptOpen(false);
      return;
    }
    if (!trimmed && attachmentsRef.current.length === 0) return;
    // 上一次发送还在进行中：忽略本次触发，避免重复发送/重复入队
    if (sendingRef.current) return;

    // 失败还原用：发送前的原始草稿与附件
    const draftText = text;
    const sentAttachments = attachmentsRef.current;
    const files = sentAttachments.map((item) => item.file);
    // 用户只发图不写字时的兜底任务文案（图片始终作为用户消息附件进入模型上下文）
    const sentText = trimmed || (files.length > 0 ? t('composer.attachmentOnlyTask') : '');

    sendingRef.current = true;
    // 发送后立即清空草稿；object URL 暂不释放，失败还原时预览仍可用
    setText('');
    commitAttachments([]);

    let settled = false;
    const settle = (failed: boolean) => {
      if (settled) return;
      settled = true;
      sendingRef.current = false;
      if (failed) {
        // 失败还原草稿：期间用户新输入的内容保留在后面，附件原样还回（URL 未释放，预览仍可用）
        setText((prev) => (prev.length === 0 ? draftText : `${draftText}\n${prev}`));
        commitAttachments([...sentAttachments, ...attachmentsRef.current]);
        return;
      }
      // 发送成功（或已加入发送队列）：预览不再需要，释放 object URL
      for (const item of sentAttachments) URL.revokeObjectURL(item.url);
    };

    let outcome: Promise<boolean> | undefined;
    try {
      outcome = onSend(sentText, files.length > 0 ? files : undefined);
    } catch (err) {
      console.error('Send failed:', err);
      settle(true);
      return;
    }
    if (outcome instanceof Promise) {
      // App 约定：resolve(false) = 创建失败（App 侧已 alert）；reject = 异常失败
      outcome.then(
        (ok) => settle(ok === false),
        () => settle(true),
      );
    } else {
      settle(false);
    }
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  const attachmentStrip =
    attachments.length > 0 ? (
      <div className={styles.attachmentStrip}>
        {attachments.map((item) => (
          <div key={item.id} className={`${styles.attachmentChip} ${attachmentKind(item.file.name, item.file.type) === 'text' ? styles.fileChip : ''}`}>
            {attachmentKind(item.file.name, item.file.type) === 'text' ? (
              <div className={styles.fileInfo} title={item.file.name}>
                <span className={styles.fileName}>{item.file.name}</span>
                <span className={styles.fileMeta}>{item.file.name.split('.').pop()?.toUpperCase()} · {attachmentSizeLabel(item.file.size)}</span>
              </div>
            ) : <img
              src={item.url}
              alt={item.file.name}
              className={styles.attachmentThumb}
              title={item.file.name}
            />}
            <button
              type="button"
              className={styles.attachmentRemove}
              title={t('composer.attachment.remove')}
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
    attachments.some((item) => attachmentKind(item.file.name, item.file.type) === 'image') && visionSupported === false ? (
      <div className={styles.visionWarning}>{t('composer.visionWarning')}</div>
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
            title={workspaceName ? t('composer.workspace.change') : t('composer.workspace.select')}
          >
            <FolderIcon size={17} />
            <span>
              {openingWorkspace
                ? t('composer.workspace.opening')
                : (workspaceName ?? t('composer.workspace.select'))}
            </span>
            <ChevronDownIcon size={13} />
          </button>
        </div>

        <div className={styles.heroInputWrapper} onDragOver={handleDragOver} onDrop={handleDrop}>
          {attachmentStrip}
          {visionWarning}
          <ComposerTextarea
            ref={textareaRef}
            variant="hero"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder={activePlaceholder}
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
                  {cmd.builtin && (
                    <span className={styles.promptSuggestBadge}>
                      {t('composer.command.builtinBadge')}
                    </span>
                  )}
                  {(cmd.descriptionKey ?? cmd.description) && (
                    <span className={styles.promptSuggestDesc}>
                      {cmd.descriptionKey ? t(cmd.descriptionKey) : cmd.description}
                    </span>
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
      {headerSlot && <div className={styles.inputBarHeader}>{headerSlot}</div>}
      <div className={styles.conversationComposer} onDragOver={handleDragOver} onDrop={handleDrop}>
        {attachmentStrip}
        {visionWarning}
        {queuedMessages.length > 0 && (
          <div className={styles.queuePanel} role="status" aria-label={t('composer.queue.title')}>
            <div className={styles.queueNotice}>
              {t('composer.queue.notice', { count: queuedMessages.length })}
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
                      title={t('composer.queue.sendNowHint')}
                    >
                      {t('composer.queue.sendNow')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.queueAction} ${styles.queueDelete}`}
                      onClick={() => onDeleteQueued?.(message.id)}
                      title={t('composer.queue.deleteHint')}
                    >
                      {t('common.delete')}
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
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          placeholder={activePlaceholder}
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
                {cmd.builtin && (
                  <span className={styles.promptSuggestBadge}>
                    {t('composer.command.builtinBadge')}
                  </span>
                )}
                {(cmd.descriptionKey ?? cmd.description) && (
                  <span className={styles.promptSuggestDesc}>
                    {cmd.descriptionKey ? t(cmd.descriptionKey) : cmd.description}
                  </span>
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
      {/* 输入框下方的附加内容（当前会话统计条）：留在同一块底部 dock 里，
          复用它的渐变底与左右内边距，不另起一层背景。 */}
      {footerSlot && <div className={styles.inputBarFooter}>{footerSlot}</div>}
    </div>
  );
}
