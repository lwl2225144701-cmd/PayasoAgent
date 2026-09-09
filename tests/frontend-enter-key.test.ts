// 确定性测试：Enter 发送 + 输入法安全的键位判定表（web/src/components/InputBar/enter-key.ts）。
// React 合成事件 → 判定输入的映射由 tsc + build:web 保证；此处锁定优先级与 IME 三重保险。

import { isImeComposing, resolveEnterAction } from '../web/src/components/InputBar/enter-key.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const baseInput = {
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  repeat: false,
  isComposing: false,
  menuOpen: false,
  locked: false,
  draftEmpty: false,
};

// ---- 优先级 0：非 Enter 键不拦截 ----
check('非 Enter 键 → pass', resolveEnterAction({ ...baseInput, key: 'a' }) === 'pass');
check(
  'ArrowDown → pass（菜单导航由组件层喂给补全）',
  resolveEnterAction({ ...baseInput, key: 'ArrowDown' }) === 'pass',
);

// ---- 优先级 1：Shift+Enter 无条件换行 ----
check(
  'Shift+Enter → pass（换行）',
  resolveEnterAction({ ...baseInput, shiftKey: true }) === 'pass',
);
check(
  '组词期 Shift+Enter 仍无条件换行',
  resolveEnterAction({ ...baseInput, shiftKey: true, isComposing: true }) === 'pass',
);
check(
  '菜单打开时 Shift+Enter 仍换行',
  resolveEnterAction({ ...baseInput, shiftKey: true, menuOpen: true }) === 'pass',
);

// ---- 优先级 2：组词期 Enter 一律吞掉 ----
check(
  '组词期 Enter → swallow（不发送不换行）',
  resolveEnterAction({ ...baseInput, isComposing: true }) === 'swallow',
);
check(
  '组词期 + 菜单打开 → 仍吞掉（输入法优先于菜单）',
  resolveEnterAction({ ...baseInput, isComposing: true, menuOpen: true }) === 'swallow',
);
check(
  '组词期 + 有草稿 → 仍吞掉',
  resolveEnterAction({ ...baseInput, isComposing: true }) === 'swallow',
);

// ---- 优先级 3：菜单打开 Enter = 选中高亮项 ----
check('菜单打开 → menu', resolveEnterAction({ ...baseInput, menuOpen: true }) === 'menu');
check(
  '菜单打开 + 空草稿 → 仍 menu（选中命令后继续输入）',
  resolveEnterAction({ ...baseInput, menuOpen: true, draftEmpty: true }) === 'menu',
);

// ---- 优先级 4：长按连发只认第一次 ----
check('repeat Enter → swallow', resolveEnterAction({ ...baseInput, repeat: true }) === 'swallow');

// ---- 优先级 5(7)：Ctrl/Cmd+Enter 保留，不参与普通发送 ----
check(
  'Ctrl+Enter → swallow（留作备用）',
  resolveEnterAction({ ...baseInput, ctrlKey: true }) === 'swallow',
);
check(
  'Cmd+Enter → swallow（留作备用）',
  resolveEnterAction({ ...baseInput, metaKey: true }) === 'swallow',
);
check(
  'Ctrl+Enter + 有草稿 → 仍不发送',
  resolveEnterAction({ ...baseInput, ctrlKey: true }) === 'swallow',
);

// ---- 优先级 5：会话锁定 / 发送进行中 ----
check(
  'disabled → swallow（吃掉不发送）',
  resolveEnterAction({ ...baseInput, locked: true }) === 'swallow',
);
check(
  '上一次发送进行中 → swallow',
  resolveEnterAction({ ...baseInput, locked: true }) === 'swallow',
);
check(
  '锁定 + 空草稿 → swallow（锁判定优先于空草稿，行为一致）',
  resolveEnterAction({ ...baseInput, locked: true, draftEmpty: true }) === 'swallow',
);

// ---- 优先级 6：普通 Enter ----
check(
  '空草稿且无附件 → swallow（不发送也不换行）',
  resolveEnterAction({ ...baseInput, draftEmpty: true }) === 'swallow',
);
check(
  '空白草稿（trim 后为空）且无附件 → swallow',
  resolveEnterAction({ ...baseInput, draftEmpty: true }) === 'swallow',
);
check('有草稿 → send', resolveEnterAction(baseInput) === 'send');
check(
  '空文本但有附件 → send（走图片兜底任务）',
  resolveEnterAction({ ...baseInput, draftEmpty: false }) === 'send',
);

// ---- IME 三重保险 ----
const t0 = 1_000_000;
check(
  'event.isComposing = true → 组词中',
  isImeComposing({ isComposing: true, keyCode: 13 }, false, 0, t0),
);
check(
  'keyCode 229（旧引擎遗留信号）→ 组词中',
  isImeComposing({ isComposing: false, keyCode: 229 }, false, 0, t0),
);
check(
  'compositionend 后 10ms 窗口内（Safari 收尾 keydown）→ 组词中',
  isImeComposing({ isComposing: false, keyCode: 13 }, false, t0 + 10, t0 + 3),
);
check(
  '组件层 composing 标志兜底 → 组词中',
  isImeComposing({ isComposing: false, keyCode: 13 }, true, 0, t0),
);
check(
  '三重信号全部清晰 → 非组词',
  isImeComposing({ isComposing: false, keyCode: 13 }, false, 0, t0) === false,
);
check(
  '时间窗恰好到期（now === compositionUntil）→ 非组词',
  isImeComposing({ isComposing: false, keyCode: 13 }, false, t0 + 10, t0 + 10) === false,
);
check('字段缺省（个别引擎）但窗口在 → 组词中', isImeComposing({}, false, t0 + 10, t0 + 1));

console.log(`\nEnter key tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
