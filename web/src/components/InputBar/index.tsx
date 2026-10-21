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
import {
  attachmentKind,
  attachmentSizeLabel,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_OFFICE_BYTES,
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
} from '../../../../src/attachment-policy';
import { listPromptCommands } from '../../api';
import {
  type CommandCandidate,
  matchBuiltinCommand,
  mergeCommandCandidates,
} from '../../commands/builtin-commands';
import { useI18n } from '../../i18n';
import type { ModelProviderView, ModelSelection, PermissionMode, PromptCommand } from '../../types';
import {
  ArrowUpIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  PencilIcon,
  TrashIcon,
} from '../icons';
import { ComposerFooter, ComposerTextarea } from './ComposerParts';
import {
  clearComposerDraft,
  mergeDraftOnSendFailure,
  readComposerDraft,
  saveComposerDraft,
} from './composer-draft';
import { isImeComposing, resolveEnterAction } from './enter-key';
import styles from './InputBar.module.css';
import { PromptPreview } from './PromptPreview';
import { QueueAttachments } from './QueueAttachments';

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
  /**
   * 草稿作用域：当前任务（会话）id。null/undefined = 新建任务页，用独立的 new-task 草稿。
   * 每个作用域一份文字草稿，切换任务与刷新页面后自动恢复；发送成功即清除。
   */
  sessionId?: string | null;
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
  // 当前 Run 执行时，新提交的消息会进入会话发送队列
  queuedCount?: number;
  queuedMessages?: QueuedComposerMessage[];
  onSendQueuedNow?: (messageId: string) => void;
  onDeleteQueued?: (messageId: string) => void;
  /** 行内编辑排队消息：把该条的文字改成 text（DSH 的队列是就地编辑，不是放回输入框）。 */
  onUpdateQueued?: (messageId: string, text: string) => void;
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
  sessionId,
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
  queuedCount = 0,
  queuedMessages = [],
  onSendQueuedNow,
  onDeleteQueued,
  onUpdateQueued,
  permissionMode,
  onSelectPermission,
  onBuiltinCommand,
  headerSlot,
  footerSlot,
}: InputBarProps) {
  const { t } = useI18n();
  // 未传 placeholder 时用跟随语言的默认占位符（传了就尊重调用方，如 hero 态的定制文案）。
  // 队列非空时换成"插话发送全部排队消息"——DSH 那句提示就是输入框 placeholder，
  // 不是队列下方的独立一行（曾误解成独立提示行，多出一行、结构就不对了）。
  const activePlaceholder =
    queuedMessages.length > 0
      ? t('composer.queue.steerPlaceholder')
      : (placeholder ?? t('composer.placeholder'));
  const [text, setText] = useState(() => readComposerDraft(sessionId));
  // ===== 草稿自动保存与恢复 =====
  // 时序要点（三个交错场景的共同基础，需求契约见 ./composer-draft.ts）：
  //   1. 发送等待期不清空持久化草稿：发送只清空输入框，草稿键继续保留「已发送文本 +
  //      期间新输入」——等待结果期间刷新、切走再回来，草稿都还在（场景 3）。
  //   2. 发送成功只清理「已交付」的那份：期间的新输入单独留在键里，不被误删（场景 1）。
  //   3. 发送失败只还原「原作用域」：已切换到别的任务时，失败草稿留在原任务的键里，
  //      绝不写进当前任务的输入框或存储（场景 2）。
  // sessionId 变化的那个提交里，text 还是上一个任务的草稿：必须先把旧作用域的文本
  // 落盘、再恢复新作用域的草稿，否则会把旧草稿写进新任务的键里（任务之间串用）。
  // 挂载时 initial state 已读过一次草稿，这里只负责「切换任务」的恢复。
  const draftScopeRef = useRef<string | null | undefined>(undefined);
  // 发送等待中的那次发送：作用域 + 已发送文本 + 期间新输入（成功清理 / 失败还原都靠它定位）
  const pendingSendRef = useRef<{
    scope: string | null | undefined;
    draftText: string;
    newerText: string;
  } | null>(null);
  useEffect(() => {
    const pending = pendingSendRef.current;
    if (draftScopeRef.current === sessionId) {
      // 同作用域：正常自动保存；发送等待期把「已发送文本 + 期间新输入」合并落盘，
      // 失败时原草稿不丢、成功时新输入可单独保留
      if (pending && pending.scope === sessionId) {
        pending.newerText = text;
        saveComposerDraft(sessionId, mergeDraftOnSendFailure(pending.draftText, text));
      } else {
        saveComposerDraft(sessionId, text);
      }
      return;
    }
    // 作用域切换：先把当前文本存回旧作用域，再恢复新作用域的草稿
    const prevScope = draftScopeRef.current;
    draftScopeRef.current = sessionId;
    if (prevScope !== undefined) {
      if (pending && pending.scope === prevScope) {
        pending.newerText = text;
        saveComposerDraft(prevScope, mergeDraftOnSendFailure(pending.draftText, text));
      } else {
        saveComposerDraft(prevScope, text);
      }
    }
    // 切回「发送等待中的作用域」时，输入框显示期间的新输入（不是含已发送文本的键内容）：
    // 既不会把已发送的文本重新灌进输入框，也不会在再次落盘时重复拼接
    setText(
      pending && pending.scope === sessionId ? pending.newerText : readComposerDraft(sessionId),
    );
  }, [sessionId, text]);

  // 队列面板的折叠态（对齐 DSH：>1 条时折叠成一行标题，默认折叠）
  const [queueCollapsed, setQueueCollapsed] = useState(true);
  // 行内编辑：正在编辑哪一条 + 草稿文本
  const [queueEditing, setQueueEditing] = useState<{ id: string; text: string } | null>(null);
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
  const suggestRef = useRef<HTMLDivElement>(null);

  // 切换工作区后刷新，避免沿用上一工作区的模板。
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceName 是触发器（效应体内不读它）：切工作区必须重拉模板
  useEffect(() => {
    let active = true;
    setPromptCommands([]);
    listPromptCommands()
      .then(({ prompts }) => {
        if (active) setPromptCommands(prompts);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [workspaceName]);

  // 当前输入匹配的命令：第一个词以 / 开头 → 进入补全模式（裸 / 即展示全量列表）
  // 内置命令优先，其后是工作区提示词模板
  const firstWord = text.split(/\s/)[0] ?? '';
  const isPromptPrefix = firstWord.startsWith('/');
  const filteredPrompts: CommandCandidate[] = isPromptPrefix
    ? mergeCommandCandidates(firstWord.slice(1), promptCommands)
    : [];
  const selectedTemplate =
    permissionMode === 'read-only'
      ? undefined
      : promptCommands.find((cmd) => `/${cmd.name}` === firstWord);
  const templatePreview = selectedTemplate && (
    <PromptPreview
      task={text}
      command={selectedTemplate}
      permissionMode={permissionMode}
      onApply={setText}
    />
  );
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
      const limit =
        kind === 'image'
          ? MAX_IMAGE_BYTES
          : kind === 'pdf'
            ? MAX_PDF_BYTES
            : kind === 'text'
              ? MAX_TEXT_BYTES
              : MAX_OFFICE_BYTES;
      if (file.size > limit) {
        rejected.push(
          t(
            kind === 'image'
              ? 'composer.attachment.tooLarge'
              : kind === 'pdf'
                ? 'composer.attachment.pdfTooLarge'
                : kind === 'text'
                  ? 'composer.attachment.textTooLarge'
                  : 'composer.attachment.officeTooLarge',
            { name: file.name || t('composer.attachment.clipboardName') },
          ),
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
    // 记录这次发送：等待结果期间草稿键保留「已发送文本 + 期间新输入」，
    // 刷新或切走再回来都能恢复（不清空持久化内容，见上方草稿效应注释）
    pendingSendRef.current = { scope: sessionId, draftText, newerText: '' };
    // 发送后立即清空输入框；object URL 暂不释放，失败还原时预览仍可用
    setText('');
    commitAttachments([]);

    let settled = false;
    const settle = (failed: boolean) => {
      if (settled) return;
      settled = true;
      sendingRef.current = false;
      const pending = pendingSendRef.current;
      pendingSendRef.current = null;
      if (!pending) return;
      if (failed) {
        // 失败还原：仍在原作用域 → 输入框还原（期间新输入接在后面），附件原样还回
        // （URL 未释放，预览仍可用）；已切换到别的任务 → 失败草稿留在原作用域的键里
        // （等待期一直在维护），绝不写进当前任务的输入框或存储
        if (draftScopeRef.current === pending.scope) {
          setText((prev) => mergeDraftOnSendFailure(pending.draftText, prev));
          commitAttachments([...sentAttachments, ...attachmentsRef.current]);
        } else {
          for (const item of sentAttachments) URL.revokeObjectURL(item.url);
        }
        return;
      }
      // 发送成功（或已加入发送队列）：已交付的那份草稿清掉；期间的新输入保留下来
      // （输入框里就是它，键也单独存一份，刷新后仍可恢复；组件随后卸载、效应来不及跑
      // 也不会丢）
      if (pending.newerText === '') {
        clearComposerDraft(pending.scope);
      } else {
        saveComposerDraft(pending.scope, pending.newerText);
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
          <div
            key={item.id}
            className={`${styles.attachmentChip} ${attachmentKind(item.file.name, item.file.type) !== 'image' ? styles.fileChip : ''}`}
          >
            {attachmentKind(item.file.name, item.file.type) !== 'image' ? (
              <div className={styles.fileInfo} title={item.file.name}>
                <span className={styles.fileName}>{item.file.name}</span>
                <span className={styles.fileMeta}>
                  {item.file.name.split('.').pop()?.toUpperCase()} ·{' '}
                  {attachmentSizeLabel(item.file.size)}
                </span>
              </div>
            ) : (
              <img
                src={item.url}
                alt={item.file.name}
                className={styles.attachmentThumb}
                title={item.file.name}
              />
            )}
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
    attachments.some((item) => attachmentKind(item.file.name, item.file.type) === 'image') &&
    visionSupported === false ? (
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

        {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖放落点容器，非交互控件，无键盘语义可给 */}
        <div className={styles.heroInputWrapper} onDragOver={handleDragOver} onDrop={handleDrop}>
          {attachmentStrip}
          {visionWarning}
          {templatePreview}
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
      {queuedMessages.length > 0 &&
        (() => {
          // 对齐 DSH 的 QueueDock：
          // - 面板是**菜单质感的一层**（底 + blur），只上方两角圆、无下边框，
          //   负 margin 贴在 composer 上方，视觉上与输入框连成一体；
          // - 只有 1 条时不显示标题行（行首直接带队列图标）；
          //   >1 条时折叠成「图标 + N 条排队消息 + chevron」，默认折叠；
          // - 编辑是**行内** textarea，动作换成 保存 / 取消。
          const rowCount = queuedMessages.length;
          const expanded = !queueCollapsed || queueEditing !== null;
          const listVisible = rowCount === 1 || expanded;
          return (
            <div className={styles.queueDock} data-queue-dock>
              <div className={styles.queuePanel}>
                {rowCount > 1 && (
                  <button
                    type="button"
                    className={styles.queueHeader}
                    aria-expanded={expanded}
                    disabled={queueEditing !== null}
                    onClick={() => setQueueCollapsed((v) => !v)}
                  >
                    <span className={styles.queueLead} aria-hidden="true">
                      <ChatIcon size={15} />
                    </span>
                    <span className={styles.queueCount}>
                      {t('composer.queue.count', { count: rowCount })}
                    </span>
                    <span className={styles.queueChevron} aria-hidden="true">
                      <ChevronDownIcon
                        size={14}
                        className={expanded ? styles.queueChevronOpen : ''}
                      />
                    </span>
                  </button>
                )}
                <ul className={styles.queueList} hidden={!listVisible}>
                  {listVisible &&
                    queuedMessages.map((message) => {
                      const editing = queueEditing?.id === message.id;
                      return (
                        <li className={styles.queueItem} key={message.id}>
                          {rowCount === 1 && (
                            <span className={styles.queueLead} aria-hidden="true">
                              <ChatIcon size={15} />
                            </span>
                          )}
                          {editing ? (
                            <textarea
                              className={styles.queueEditor}
                              value={queueEditing.text}
                              aria-label={t('composer.queue.edit')}
                              // biome-ignore lint/a11y/noAutofocus: 进入行内编辑即应聚焦
                              autoFocus
                              onChange={(e) =>
                                setQueueEditing({ id: message.id, text: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  const next = queueEditing.text.trim();
                                  if (next) {
                                    onUpdateQueued?.(message.id, next);
                                    setQueueEditing(null);
                                  }
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setQueueEditing(null);
                                }
                              }}
                            />
                          ) : (
                            <>
                              {/* 附件在文字之前（DSH 同序）：图片出缩略图、其余出文件卡 */}
                              {message.attachments && message.attachments.length > 0 && (
                                <QueueAttachments files={message.attachments} />
                              )}
                              <span className={styles.queueItemText} title={message.task}>
                                {message.task}
                              </span>
                            </>
                          )}
                          <div className={styles.queueItemActions}>
                            {editing ? (
                              <>
                                <button
                                  type="button"
                                  className={styles.queueAction}
                                  disabled={queueEditing.text.trim() === ''}
                                  onClick={() => {
                                    const next = queueEditing.text.trim();
                                    if (!next) return;
                                    onUpdateQueued?.(message.id, next);
                                    setQueueEditing(null);
                                  }}
                                  title={t('composer.queue.save')}
                                  aria-label={t('composer.queue.save')}
                                >
                                  <CheckIcon size={14} />
                                </button>
                                <button
                                  type="button"
                                  className={styles.queueAction}
                                  onClick={() => setQueueEditing(null)}
                                  title={t('composer.queue.cancelEdit')}
                                  aria-label={t('composer.queue.cancelEdit')}
                                >
                                  <CloseIcon size={14} />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className={styles.queueAction}
                                  onClick={() =>
                                    setQueueEditing({ id: message.id, text: message.task })
                                  }
                                  title={t('composer.queue.editHint')}
                                  aria-label={t('composer.queue.editHint')}
                                >
                                  <PencilIcon size={14} />
                                </button>
                                <button
                                  type="button"
                                  className={styles.queueAction}
                                  onClick={() => onDeleteQueued?.(message.id)}
                                  title={t('composer.queue.deleteHint')}
                                  aria-label={t('composer.queue.deleteHint')}
                                >
                                  <TrashIcon size={14} />
                                </button>
                                <button
                                  type="button"
                                  className={styles.queueAction}
                                  onClick={() => onSendQueuedNow?.(message.id)}
                                  title={t('composer.queue.sendNowHint')}
                                  aria-label={t('composer.queue.sendNowHint')}
                                >
                                  <ArrowUpIcon size={14} />
                                </button>
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                </ul>
              </div>
            </div>
          );
        })()}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 拖放落点容器，非交互控件，无键盘语义可给 */}
      <div className={styles.conversationComposer} onDragOver={handleDragOver} onDrop={handleDrop}>
        {attachmentStrip}
        {visionWarning}
        {templatePreview}
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
