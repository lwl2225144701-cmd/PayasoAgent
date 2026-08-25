import type { HostEvent, ToolCallEvent, ToolErrorEvent, ToolResultEvent } from '../../types';

export interface ToolCardData {
  key: string;
  tool: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed';
  durationMs: number | null;
  result: string | null;
  error: string | null;
  attempt: number | null;
  exhausted: boolean;
}

export interface NoticeItem {
  key: string;
  kind: 'skip' | 'uncertain' | 'truncated' | 'invalid';
  tool: string;
  text: string;
}

function resultText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

export function buildToolCards(events: HostEvent[]): ToolCardData[] {
  const cards: ToolCardData[] = [];
  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const call = ev as ToolCallEvent;
      cards.push({
        key: `call-${call.step}-${cards.length}`,
        tool: call.tool,
        args: call.args,
        status: 'running',
        durationMs: null,
        result: null,
        error: null,
        attempt: null,
        exhausted: false,
      });
      continue;
    }
    if (ev.type === 'tool_result') {
      const res = ev as ToolResultEvent;
      const card = [...cards].reverse().find(c => c.tool === res.tool && c.status === 'running');
      if (card) {
        card.status = 'completed';
        card.durationMs = res.durationMs;
        card.result = resultText(res.result);
      }
      continue;
    }
    if (ev.type === 'tool_error') {
      const err = ev as ToolErrorEvent;
      const card = [...cards].reverse().find(c => c.tool === err.tool && c.status === 'running');
      if (card) {
        card.status = 'failed';
        card.error = err.error;
        card.attempt = err.attempt;
        card.exhausted = err.exhausted;
      }
    }
  }
  return cards;
}

export function buildNotices(events: HostEvent[]): NoticeItem[] {
  const notices: NoticeItem[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case 'side_effect_skip':
        notices.push({
          key: `skip-${ev.step}`,
          kind: 'skip',
          tool: ev.tool,
          text: ev.replayed
            ? `Replayed cached result for idempotent retry · ${ev.tool}`
            : `Skipped duplicate operation · ${ev.tool}`,
        });
        break;
      case 'side_effect_uncertain':
        notices.push({
          key: `uncertain-${ev.step}`,
          kind: 'uncertain',
          tool: ev.tool,
          text: `${ev.tool} crashed mid-execution, outcome uncertain — recovery will not blind-retry`,
        });
        break;
      case 'tool_output_truncated':
        notices.push({
          key: `truncated-${ev.step}`,
          kind: 'truncated',
          tool: ev.tool,
          text: `Output truncated ${formatBytesShort(ev.originalBytes)} → ${formatBytesShort(ev.returnedBytes)} · ${ev.tool}`,
        });
        break;
      case 'tool_result_invalid':
        notices.push({
          key: `invalid-${ev.step}`,
          kind: 'invalid',
          tool: ev.tool,
          text: `Invalid result (${ev.reason}) · ${ev.tool}`,
        });
        break;
      default:
        break;
    }
  }
  return notices;
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}
