// Module: Tool Output Budget — the single source of truth for how much of a
// tool result may enter the Runtime state / model context, and how an
// over-budget payload is sliced.
//
// Why this module exists (v1.8):
// Before, the enforced budget lived in the Runtime guard (16KB, head 6KB + tail
// 4KB) while tools advertised their own unrelated limits (read claimed 64KB /
// 500 lines). The two drifted, so a tool could return "success" for content the
// Runtime silently removed from the middle. Every producer of large results
// (read / grep / shell / loadSkill) and the Runtime guard MUST use this module
// so the advertised contract and the enforced contract can never disagree.
//
// Design:
// - Pure functions over strings, byte-accurate (UTF-8), character-boundary safe.
// - Leaf module: imports nothing from tools/runtime/host, so both layers can
//   depend on it without creating a cycle or inverting the dependency direction.

/** Hard ceiling for a single tool result entering the model context. */
export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024; // 16KB
/** Bytes kept from the beginning of an over-budget payload. */
export const TOOL_OUTPUT_HEAD_BYTES = 6 * 1024;
/** Bytes kept from the end of an over-budget payload. */
export const TOOL_OUTPUT_TAIL_BYTES = 4 * 1024;
/** Marker inserted where content was removed. Stable: tests and tools rely on it. */
export const TOOL_OUTPUT_MARKER = '[OUTPUT TRUNCATED]';

/** UTF-8 byte length. Never `string.length`: that counts UTF-16 code units. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * First `maxBytes` bytes, never splitting a UTF-8 character.
 * A continuation byte has the form 10xxxxxx (0x80–0xBF); we back off to the
 * start of the character instead of emitting a replacement character.
 */
export function utf8Head(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Last `maxBytes` bytes, never splitting a UTF-8 character. */
export function utf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = Math.max(0, buf.length - maxBytes);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

export interface SlicedText {
  /** Content that may be returned to the model (with the marker if sliced). */
  content: string;
  truncated: boolean;
  originalBytes: number;
  returnedBytes: number;
  /** Bytes removed from the middle; 0 when not truncated. */
  omittedBytes: number;
}

export interface SliceBudget {
  maxBytes?: number;
  headBytes?: number;
  tailBytes?: number;
  marker?: string;
}

/**
 * Deterministic head+tail slicing. Under budget → identity (same string
 * instance semantics: callers may compare with `===` for the fast path).
 * Over budget → head + marker + tail, always <= maxBytes when the budget can
 * hold the marker, and never splitting a UTF-8 character.
 */
export function sliceTextToBudget(text: string, budget: SliceBudget = {}): SlicedText {
  const maxBytes = budget.maxBytes ?? TOOL_OUTPUT_MAX_BYTES;
  const headBytes = budget.headBytes ?? TOOL_OUTPUT_HEAD_BYTES;
  const tailBytes = budget.tailBytes ?? TOOL_OUTPUT_TAIL_BYTES;
  const marker = budget.marker ?? TOOL_OUTPUT_MARKER;

  const originalBytes = utf8ByteLength(text);
  if (originalBytes <= maxBytes) {
    return { content: text, truncated: false, originalBytes, returnedBytes: originalBytes, omittedBytes: 0 };
  }

  const markerBytes = utf8ByteLength(marker);
  const head = utf8Head(text, Math.max(0, headBytes));
  const tail = utf8Tail(text, Math.max(0, tailBytes));
  const content = `${head}${marker}${tail}`;
  const returnedBytes = utf8ByteLength(content);
  // Head/tail budgets are chosen so this cannot happen for the defaults; the
  // guard keeps the invariant true for custom budgets too.
  if (returnedBytes > maxBytes) {
    const hard = utf8Head(content, maxBytes);
    return {
      content: hard,
      truncated: true,
      originalBytes,
      returnedBytes: utf8ByteLength(hard),
      omittedBytes: originalBytes - utf8ByteLength(hard),
    };
  }
  return {
    content,
    truncated: true,
    originalBytes,
    returnedBytes,
    omittedBytes: originalBytes - returnedBytes + markerBytes,
  };
}
