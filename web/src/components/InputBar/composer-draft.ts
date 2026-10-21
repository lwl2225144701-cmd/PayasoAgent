// 消息输入框的草稿自动保存与恢复（纯函数模块，无 DOM 依赖）。
//
// 需求契约：
//   1. 每个任务（会话）独立保存文字草稿；新建任务页（还没有会话 id）也有独立草稿，
//      两者互不串用 —— 键里带作用域，互不覆盖。
//   2. 切换任务、刷新页面后自动恢复：键稳定（只由 sessionId 决定），刷新后读同一把键。
//   3. 发送成功清除对应草稿；发送失败保留，且不能覆盖用户后来输入的内容
//      （失败还原时把「期间新输入」接在旧草稿后面，见 mergeDraftOnSendFailure）。
//   4. 仅保存文字：附件不进草稿，保持现有行为（object URL 不可持久化）。
//   5. 本地存储不可用（隐私模式 / 配额 / 非浏览器环境）时读写全部安静降级，
//      输入与发送不受影响。
//
// 为什么单独成文件：判定与存取逻辑要能被确定性测试（tests/frontend-composer-draft.test.ts）
// 直接调用，不依赖 React 渲染。

/** 新建任务页（还没有会话 id）的草稿作用域。 */
export const NEW_TASK_DRAFT_SCOPE = 'new-task';

/** 草稿存储键前缀。 */
const DRAFT_KEY_PREFIX = 'payaso.composerDraft.';

/** 单份草稿的字符上限：localStorage 配额通常 5MB，留足余量给其它偏好设置。 */
export const MAX_DRAFT_CHARS = 20000;

/**
 * 草稿存储键：sessionId 为空（新建任务页）时落到独立的 new-task 作用域。
 * 键只由作用域决定，因此刷新后仍能命中同一份草稿。
 */
export function composerDraftKey(sessionId: string | null | undefined): string {
  const scope = sessionId && sessionId.trim() !== '' ? sessionId.trim() : NEW_TASK_DRAFT_SCOPE;
  return `${DRAFT_KEY_PREFIX}${scope}`;
}

/** 草稿是否值得落盘：空白草稿不入库，避免留下大量无意义键。 */
export function isDraftWorthSaving(text: string): boolean {
  return text.trim() !== '';
}

/** 超长草稿截断到上限（宁失尾部，不因配额写失败而丢整份草稿）。 */
export function clampDraftText(text: string): string {
  return text.length > MAX_DRAFT_CHARS ? text.slice(0, MAX_DRAFT_CHARS) : text;
}

/**
 * 发送失败时的草稿合并：旧草稿在前，期间用户新输入的内容接在后面。
 * 用户新输入的内容永远不被丢弃（需求 3 的后半句）。
 */
export function mergeDraftOnSendFailure(draftText: string, currentText: string): string {
  if (draftText === '') return currentText;
  if (currentText === '') return draftText;
  return `${draftText}\n${currentText}`;
}

/** localStorage 的最小接口：测试用假实现、真实环境用 window.localStorage。 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveStorage(): DraftStorage | null {
  try {
    const storage = (globalThis as { window?: { localStorage?: DraftStorage } }).window
      ?.localStorage;
    return storage ?? null;
  } catch {
    // 访问 window.localStorage 本身被禁用（隐私模式）时同样降级
    return null;
  }
}

/** 读取草稿：存储不可用 / 抛错 / 无记录都返回空串（绝不抛）。 */
export function readComposerDraft(sessionId: string | null | undefined): string {
  const storage = resolveStorage();
  if (!storage) return '';
  try {
    return storage.getItem(composerDraftKey(sessionId)) ?? '';
  } catch {
    return '';
  }
}

/** 写入草稿：空白草稿直接清键；存储不可用/抛错时安静降级。 */
export function saveComposerDraft(sessionId: string | null | undefined, text: string): void {
  const storage = resolveStorage();
  if (!storage) return;
  const key = composerDraftKey(sessionId);
  try {
    if (isDraftWorthSaving(text)) {
      storage.setItem(key, clampDraftText(text));
    } else {
      storage.removeItem(key);
    }
  } catch {
    // 配额写满等：本次不落盘即可，输入与发送照常工作
  }
}

/** 清除草稿（发送成功时调用）：存储不可用/抛错时安静降级。 */
export function clearComposerDraft(sessionId: string | null | undefined): void {
  const storage = resolveStorage();
  if (!storage) return;
  try {
    storage.removeItem(composerDraftKey(sessionId));
  } catch {
    // 同上：清不掉也不影响本次会话内的行为
  }
}
