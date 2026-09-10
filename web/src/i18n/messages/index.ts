// 消息表聚合：各领域一份，key 全局唯一（前缀即领域名）。
// `MessageKey` 由这份聚合导出 —— 组件里写错 key 会直接编译失败，
// 这是"没有漏翻译"的第一道闸门（第二道是 tests/frontend-i18n-coverage.test.ts
// 的"i18n 目录外不得残留用户可见中文"扫描）。

import { appMessages } from './app';
import { commonMessages } from './common';
import { composerMessages } from './composer';
import { settingsMessages } from './settings';
import { shellMessages } from './shell';
import { timelineMessages } from './timeline';
import { widgetsMessages } from './widgets';

export const MESSAGES = {
  ...commonMessages,
  ...appMessages,
  ...composerMessages,
  ...settingsMessages,
  ...shellMessages,
  ...timelineMessages,
  ...widgetsMessages,
} as const;

export type MessageKey = keyof typeof MESSAGES;

export type { MessageEntry, MessageLanguage, MessageTable } from './types';
