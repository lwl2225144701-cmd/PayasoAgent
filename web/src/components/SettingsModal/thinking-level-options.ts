// 思考档次下拉的选项与文案（纯函数，无 DOM，便于 node 确定性测试）。
//
// 标签跟随界面语言偏好（preferences.LanguageMode），不写死单语：中文沿用既有措辞，
// 英文与 pi-ai 的档次名对齐（minimal / low / medium / high / xhigh / max），
// 便于对着供应商文档和请求体排查。

import type { LanguageMode } from '../../preferences';

export interface ThinkingLevelOption {
  /** 空串 = 「不设置」；其余为 pi-ai 的 ModelThinkingLevel 取值。 */
  value: string;
  label: string;
}

// 「不设置」选项文案。
const NOT_SET_LABEL: Record<LanguageMode, string> = {
  'zh-CN': '默认（不设置）',
  'en-US': 'Default (not set)',
};

// 全量档次文案（off 不在下拉里出现——它与「不设置」在请求层完全等价，
// 列出等于暗示一个我们并不会发出的"关闭思考"指令；保留文案仅为完整映射）。
const LEVEL_LABELS: Record<LanguageMode, Record<string, string>> = {
  'zh-CN': {
    off: '无思考',
    minimal: '最低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '最高',
    max: '最强',
  },
  'en-US': {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
  },
};

// 自定义端点（无注册表）可选项：xhigh/max 会被 pi-ai clamp 成 high，
// 不提供会静默降级的选项。
const CUSTOM_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high'];

// 目录未加载（如编辑模式）时的兜底：全量档，避免丢掉用户已选的 xhigh/max。
const FULL_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const SELECT_TITLE: Record<LanguageMode, string> = {
  'zh-CN':
    '思考档次（可选）：未设置时不发送任何思考参数，由端点默认行为决定；设置后按厂商协议发送（pi 内置模型按注册表映射，自定义端点发 reasoning_effort）',
  'en-US':
    'Thinking level (optional): when unset, no thinking parameters are sent and the endpoint default applies; when set, parameters follow the vendor protocol (registry mapping for built-in models, reasoning_effort for custom endpoints)',
};

const SELECT_ARIA_LABEL: Record<LanguageMode, string> = {
  'zh-CN': '思考档次',
  'en-US': 'Thinking level',
};

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
  const labels = LEVEL_LABELS[language];
  const levels = supportedLevels
    ? supportedLevels.filter((level) => level !== 'off')
    : isPiProvider
      ? FULL_LEVELS
      : CUSTOM_LEVELS;
  return [
    { value: '', label: NOT_SET_LABEL[language] },
    ...levels.map((level) => ({ value: level, label: labels[level] ?? level })),
  ];
}

/** 下拉 title（悬停说明）：未设置 ≠ 关闭思考，必须说清。 */
export function thinkingLevelSelectTitle(language: LanguageMode): string {
  return SELECT_TITLE[language];
}

/** 下拉 aria-label（给屏幕阅读器的最小可访问名称）。 */
export function thinkingLevelSelectAriaLabel(language: LanguageMode): string {
  return SELECT_ARIA_LABEL[language];
}
