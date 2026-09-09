// Enter 键行为判定的纯函数：组件层只负责把 React 合成事件映射为输入并执行动作，
// 判定表锁定在这里，方便确定性测试（tests/frontend-enter-key.test.ts）。
// 优先级从高到低（与需求规格一一对应）：
//   1) Shift+Enter 无条件换行（即使输入法组词中）
//   2) 输入法组词期的 Enter 一律吞掉（不发送、不换行，交还输入法选词）
//   3) 候选/补全菜单打开时 Enter = 选中高亮项（无高亮/无菜单才落到发送判定）
//   4) event.repeat === true 只认第一次（长按连发不重复触发）
//   5) 会话锁定或上一次发送还在进行中：吃掉但不发送
//   6) 普通 Enter：草稿 trim 后为空且无附件 → 不发送也不换行；否则发送
//   7) Ctrl/Cmd+Enter 留作备用（忙时插话等），不参与普通发送判定

export type EnterActionKind = 'pass' | 'swallow' | 'menu' | 'send';

export interface EnterKeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** 长按连发：只认第一次 */
  repeat: boolean;
  /** IME 三重保险合并结果（event.isComposing / keyCode 229 / compositionend 后时间窗） */
  isComposing: boolean;
  /** 补全菜单打开且有候选（打开即必有高亮项） */
  menuOpen: boolean;
  /** 会话锁定（disabled）或上一次发送还在进行中 */
  locked: boolean;
  /** 草稿 trim 后为空且无附件 */
  draftEmpty: boolean;
}

/**
 * pass：不拦截，交还浏览器默认行为（textarea 换行）；
 * swallow：preventDefault，不发送也不换行；
 * menu：交给补全菜单处理（选中高亮项）；
 * send：preventDefault + 发送。
 */
export function resolveEnterAction(input: EnterKeyInput): EnterActionKind {
  if (input.key !== 'Enter') return 'pass';
  // 1) Shift+Enter 无条件换行（即使输入法组词中）
  if (input.shiftKey) return 'pass';
  // 2) 输入法组词期的 Enter 一律吞掉
  if (input.isComposing) return 'swallow';
  // 3) 补全菜单打开：Enter 选中高亮项
  if (input.menuOpen) return 'menu';
  // 4) 长按连发只认第一次
  if (input.repeat) return 'swallow';
  // 7) Ctrl/Cmd+Enter 留作备用，不参与普通发送判定
  if (input.metaKey || input.ctrlKey) return 'swallow';
  // 5) 会话锁定或上一次发送还在进行中：吃掉但不发送
  if (input.locked) return 'swallow';
  // 6) 空草稿且无附件：不发送也不换行
  if (input.draftEmpty) return 'swallow';
  return 'send';
}

/**
 * IME 组词判定三重保险（缺一不可）：
 * - event.isComposing：标准字段，个别引擎可能缺省
 * - keyCode === 229：旧引擎在组词期对全部按键统一上报的遗留信号
 * - compositionUntil 时间窗：Safari 确认组词的收尾 keydown 在 compositionend 之后派发，
 *   此时 isComposing 已翻回 false，必须保留 10ms 窗口把那条 Enter 吞掉，否则选字回车会误发送
 * composing 为组件层维护的组词标志（compositionstart/compositionend），作为兜底一并并入。
 */
export function isImeComposing(
  event: { isComposing?: boolean; keyCode?: number },
  composing: boolean,
  compositionUntil: number,
  now: number,
): boolean {
  return composing || event.isComposing === true || event.keyCode === 229 || now < compositionUntil;
}
