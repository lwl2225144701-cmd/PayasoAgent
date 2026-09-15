import type { HostEvent, StreamingEvent } from '../types';

function isStreamingEvent(event: HostEvent): event is StreamingEvent {
  return (
    event.type === 'assistant_delta' ||
    event.type === 'reasoning_delta' ||
    event.type === 'shell_output_delta'
  );
}

/**
 * Merge only adjacent chunks from the same logical streamed message.
 *
 * SSE remains the source of truth, but the UI does not need to retain one
 * React item per token-sized delta. Keeping the merge pure makes the behavior
 * deterministic and lets the hook batch state updates without changing event
 * order or terminal-event semantics.
 */
export function mergeStreamingEvents(existing: HostEvent[], incoming: HostEvent[]): HostEvent[] {
  const next = existing.slice();
  for (const event of incoming) {
    const previous = next[next.length - 1];
    if (
      previous &&
      isStreamingEvent(previous) &&
      isStreamingEvent(event) &&
      previous.type === event.type &&
      previous.messageId === event.messageId
    ) {
      next[next.length - 1] = {
        ...previous,
        delta: previous.delta + event.delta,
        timestamp: event.timestamp,
      };
    } else {
      next.push(event);
    }
  }
  return next;
}
