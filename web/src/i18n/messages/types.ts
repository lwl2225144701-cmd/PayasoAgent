// i18n 消息表条目：一个 key 对应全部支持语言的文案。
// 语言集合与 preferences.LanguageMode 保持一致；新增语言只需在 MessageEntry 上加一个字段，
// 类型检查会把所有缺翻译的条目一次性指出来。
export type MessageLanguage = 'zh-CN' | 'en-US';

export type MessageEntry = Record<MessageLanguage, string>;

/** 每个领域一份消息表（见同目录其它文件），key 以领域名做前缀避免跨文件撞车。 */
export type MessageTable = Record<string, MessageEntry>;
