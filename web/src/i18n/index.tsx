// React 层：语言上下文 + useI18n()。
// 语言来源是 App 的 useGeneralSettings（localStorage 持久化 + <html lang> 同步），
// 这里只负责把它分发给整棵组件树，避免逐层传 prop。

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { LanguageMode } from '../preferences';
import { type Translate, translator } from './translate';

interface I18nValue {
  language: LanguageMode;
  t: Translate;
}

// 未包 Provider 时回退中文而不是抛错：界面整体可用性优先（漏包只会让那棵子树保持中文，
// 由 i18n 扫描测试与本文件的唯一挂载点约束）。
const FALLBACK: I18nValue = { language: 'zh-CN', t: translator('zh-CN') };

const I18nContext = createContext<I18nValue>(FALLBACK);

export function I18nProvider({
  language,
  children,
}: {
  language: LanguageMode;
  children: ReactNode;
}) {
  const value = useMemo<I18nValue>(() => ({ language, t: translator(language) }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
