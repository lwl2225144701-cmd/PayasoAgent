// 纯翻译函数：不依赖 React，供纯函数模块（format.ts / plan-state.ts / context-gauge.ts …）
// 与组件层共用同一份消息表与同一套插值规则。
//
// 为什么不做成模块级全局语言：这些模块是确定性测试的对象，语言必须是入参而不是隐藏状态，
// 否则测试要改全局、并行用例互相污染。

import type { LanguageMode } from '../preferences';
import { MESSAGES, type MessageKey } from './messages';

export type Language = LanguageMode;

/** 插值参数：`{ 'common.time.minutes' }` 里的 `{count}` 用这里同名的值替换。 */
export type MessageParams = Record<string, string | number>;

export type Translate = (key: MessageKey, params?: MessageParams) => string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * 取文案并插值。语言缺失的条目回退中文（类型上不允许缺，运行时兜底），
 * 未知 key 回退 key 本身 —— 绝不抛错、绝不渲染空白，故障可见但不炸界面。
 */
export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const entry: Record<string, string> | undefined = MESSAGES[key];
  const template = entry?.[language] ?? entry?.['zh-CN'] ?? key;
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    // 同名占位符才替换；缺参时保留 `{name}` 原文，避免渲染出 "undefined"
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** 绑定语言的翻译函数（组件层用 useI18n 拿到的就是它）。 */
export function translator(language: Language): Translate {
  return (key, params) => translate(language, key, params);
}
