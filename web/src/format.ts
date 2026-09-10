// 时间/时长/状态词跟随界面语言：语言是末位可选入参（默认 zh-CN），
// 既有调用点与测试不传也保持原有中文输出。

import type { MessageKey } from './i18n/messages';
import { translate } from './i18n/translate';
import type { LanguageMode } from './preferences';

export function formatTime(
  iso: string | undefined | null,
  language: LanguageMode = 'zh-CN',
): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(language, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '';
  }
}

export function formatRelativeTime(
  iso: string | undefined | null,
  language: LanguageMode = 'zh-CN',
): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return translate(language, 'common.time.justNow');
  if (diff < hour) {
    return translate(language, 'common.time.minutes', { count: Math.floor(diff / minute) });
  }
  if (diff < day) {
    return translate(language, 'common.time.hours', { count: Math.floor(diff / hour) });
  }
  if (diff < 2 * day) return translate(language, 'common.time.yesterday');
  return new Date(iso).toLocaleDateString(language, { month: 'numeric', day: 'numeric' });
}

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationMs(ms: number, language: LanguageMode = 'zh-CN'): string {
  if (ms < 1000) {
    return translate(language, 'common.time.milliseconds', {
      value: Math.max(0, Math.round(ms)),
    });
  }
  const sec = ms / 1000;
  if (sec < 60) return translate(language, 'common.time.seconds', { value: sec.toFixed(1) });
  const min = Math.floor(sec / 60);
  return translate(language, 'common.time.minutesSeconds', {
    min,
    sec: Math.round(sec - min * 60),
  });
}

export function stripThinkTags(text: string): { visible: string; thinking: string | null } {
  const thinkingParts: string[] = [];
  let visible = text.replace(/<think[^>]*>([\s\S]*?)<\/think>/gi, (_match, content: string) => {
    if (content.trim()) thinkingParts.push(content.trim());
    return '';
  });

  // Streaming responses can expose an opening tag before the closing tag has
  // arrived. Treat the unfinished suffix as thinking instead of leaking the
  // literal tag and private process text into the answer.
  const unfinished = visible.match(/<think[^>]*>/i);
  if (unfinished?.index != null) {
    const start = unfinished.index;
    const content = visible.slice(start + unfinished[0].length).trim();
    if (content) thinkingParts.push(content);
    visible = visible.slice(0, start);
  }

  visible = visible.replace(/<\/?think[^>]*>/gi, '').trim();
  const thinking = thinkingParts.join('\n\n').trim();
  return { visible, thinking: thinking || null };
}

export function previewArgs(args: unknown): string {
  if (args && typeof args === 'object') {
    const vals = Object.values(args as Record<string, unknown>).filter(
      (v): v is string | number => typeof v === 'string' || typeof v === 'number',
    );
    if (vals.length > 0) {
      const first = String(vals[0]).replace(/\s+/g, ' ').trim();
      return first.length > 80 ? `${first.slice(0, 80)}...` : first;
    }
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** 工具状态词 → 消息 key（文案本体在 common 消息表，跨领域复用）。 */
const TOOL_STATUS_KEY: Record<'running' | 'completed' | 'failed', MessageKey> = {
  running: 'common.status.running',
  completed: 'common.status.completed',
  failed: 'common.status.failed',
};

/** 工具状态词（跟随 language；未传则中文，与 TOOL_STATUS_LABELS 一致）。 */
export function toolStatusLabel(
  status: 'running' | 'completed' | 'failed',
  language: LanguageMode = 'zh-CN',
): string {
  return translate(language, TOOL_STATUS_KEY[status]);
}

// 兼容常量：保留导出名与形状（既有消费方按 zh-CN 取值），文案改由消息表提供。
export const TOOL_STATUS_LABELS: Record<'running' | 'completed' | 'failed', string> = {
  running: toolStatusLabel('running'),
  completed: toolStatusLabel('completed'),
  failed: toolStatusLabel('failed'),
};

/**
 * 检查一段 visible 文本是否与 final_answer 的内容高度相似（用于去重）。
 * 简单做法：比较 normalized 后的前 60 字符重合度。
 */
export function isDuplicateOfFinal(visible: string, finalContent: string | null): boolean {
  if (!finalContent) return false;
  const norm = (s: string) =>
    s
      .replace(/\s+/g, '')
      .replace(/[，。,.!?！？、]/g, '')
      .slice(0, 80);
  const a = norm(visible);
  const b = norm(finalContent);
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}
