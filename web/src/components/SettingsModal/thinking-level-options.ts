// 思考档次下拉的选项与文案（纯函数，无 DOM，便于 node 确定性测试）。
//
// 标签跟随界面语言偏好（preferences.LanguageMode），文案统一走 i18n 消息表：
// 中文沿用既有措辞，英文与 pi-ai 的档次名对齐（minimal / low / medium / high / xhigh / max），
// 便于对着供应商文档和请求体排查。

import type { MessageKey } from '../../i18n/messages';
import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';

export interface ThinkingLevelOption {
  /** 空串 = 「不设置」；其余为 pi-ai 的 ModelThinkingLevel 取值。 */
  value: string;
  label: string;
}

// 「不设置」选项文案。
const NOT_SET_KEY: MessageKey = 'settings.thinking.notSet';

// 全量档次 → 消息 key（off 不在下拉里出现——它与「不设置」在请求层完全等价，
// 列出等于暗示一个我们并不会发出的"关闭思考"指令；保留映射仅为完整覆盖）。
const LEVEL_KEYS: Record<string, MessageKey> = {
  off: 'settings.thinking.off',
  minimal: 'settings.thinking.minimal',
  low: 'settings.thinking.low',
  medium: 'settings.thinking.medium',
  high: 'settings.thinking.high',
  xhigh: 'settings.thinking.xhigh',
  max: 'settings.thinking.max',
};

// 自定义端点（无注册表）可选项：xhigh/max 会被 pi-ai clamp 成 high，
// 不提供会静默降级的选项。
const CUSTOM_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high'];

// 目录未加载（如编辑模式）时的兜底：全量档，避免丢掉用户已选的 xhigh/max。
const FULL_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const SELECT_TITLE_KEY: MessageKey = 'settings.thinking.selectTitle';

const SELECT_ARIA_LABEL_KEY: MessageKey = 'settings.thinking.selectAria';

/**
 * 某个模型可选的思考档次。
 *
 * - `supportedLevels` 有值（目录里找到了该模型）→ 只列它真正支持的档次（剔除 off）；
 *   非推理模型（注册表只给 off）便只剩「不设置」。
 * - 否则：`isPiProvider` → 全量档兜底；自定义端点 → 自定义档。
 */
export function thinkingLevelOptionsFor(input: {
  supportedLevels?: readonly string[];
  isPiProvider: boolean;
  language: LanguageMode;
}): ThinkingLevelOption[] {
  const { supportedLevels, isPiProvider, language } = input;
  const levels = supportedLevels
    ? supportedLevels.filter((level) => level !== 'off')
    : isPiProvider
      ? FULL_LEVELS
      : CUSTOM_LEVELS;
  return [
    { value: '', label: translate(language, NOT_SET_KEY) },
    // 未知档次值不丢：没有对应消息时回退为原值当文案
    ...levels.map((level) => {
      const key = LEVEL_KEYS[level];
      return { value: level, label: key ? translate(language, key) : level };
    }),
  ];
}

/** 下拉 title（悬停说明）：未设置 ≠ 关闭思考，必须说清。 */
export function thinkingLevelSelectTitle(language: LanguageMode): string {
  return translate(language, SELECT_TITLE_KEY);
}

/** 下拉 aria-label（给屏幕阅读器的最小可访问名称）。 */
export function thinkingLevelSelectAriaLabel(language: LanguageMode): string {
  return translate(language, SELECT_ARIA_LABEL_KEY);
}
