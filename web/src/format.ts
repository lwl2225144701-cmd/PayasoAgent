import type { HostEvent } from './types';

export function formatTime(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

export function formatRelativeTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)}分钟`;
  if (diff < day) return `${Math.floor(diff / hour)}小时`;
  if (diff < 2 * day) return '昨天';
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}毫秒`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}秒`;
  const min = Math.floor(sec / 60);
  return `${min}分${Math.round(sec - min * 60)}秒`;
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
    const vals = Object.values(args as Record<string, unknown>)
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
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

export const TOOL_STATUS_LABELS: Record<'running' | 'completed' | 'failed', string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
};

/**
 * 检查一段 visible 文本是否与 final_answer 的内容高度相似（用于去重）。
 * 简单做法：比较 normalized 后的前 60 字符重合度。
 */
export function isDuplicateOfFinal(visible: string, finalContent: string | null): boolean {
  if (!finalContent) return false;
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/[，。,.!?！？、]/g, '').slice(0, 80);
  const a = norm(visible);
  const b = norm(finalContent);
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}
