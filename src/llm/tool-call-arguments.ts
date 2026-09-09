// Module: Tool Call Raw Arguments — recover the model's *verbatim* argument
// text from a streaming provider response.
//
// Why this module exists (v1.10):
// pi-ai's native adapters (Anthropic Messages, Google, …) parse tool arguments
// incrementally and expose the result as an already-decoded object. An
// incomplete or malformed JSON body decodes to `{}`, and the Runtime then saw a
// perfectly valid empty argument object — so a truncated `{"path":` silently
// executed the tool with no arguments ("missing parameter path") instead of
// surfacing a recoverable invocation error. The OpenAI-compatible path never
// had this problem because it keeps the raw fragments.
//
// pi-ai emits every raw JSON fragment as a `toolcall_delta` event, so the
// adapter layer can reconstruct the verbatim text and hand it to the Runtime's
// unified parser. This module is the pure part of that: accumulate fragments,
// decide when the decoded object is untrustworthy, and attach the raw text to
// the right tool_call id.

/** Raw JSON text accumulated per assistant-content index. */
export type RawArgumentFragments = Map<number, string>;

/** Accumulates `toolcall_delta` fragments. Pure; no streaming knowledge. */
export class ToolArgumentAccumulator {
  private readonly fragments: RawArgumentFragments = new Map();

  push(contentIndex: number, delta: string): void {
    if (delta.length === 0) return;
    this.fragments.set(contentIndex, (this.fragments.get(contentIndex) ?? '') + delta);
  }

  snapshot(): RawArgumentFragments {
    return new Map(this.fragments);
  }
}

/**
 * True when the provider-decoded object must not be trusted and the raw text
 * should be used instead. Only the exact silent-failure shape is overridden:
 * the decoded object is empty, while the raw text says something other than an
 * intentional empty object. A provider that legitimately sends `{}` keeps its
 * decoded value, and a non-empty decode is always trusted.
 */
export function shouldPreferRawArguments(decoded: unknown, raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed.replace(/\s+/g, '') === '{}') return false;
  return isEmptyObject(decoded);
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

/** Structural subset of an assistant content block (no pi-ai dependency). */
export interface RawToolCallBlock {
  type: string;
  id?: string;
  arguments?: unknown;
}

/**
 * Map tool_call id → verbatim argument text, but only for calls whose decoded
 * arguments are untrustworthy. Blocks without a usable raw fragment keep their
 * decoded arguments (the caller falls back to JSON.stringify).
 */
export function rawArgumentsByToolCallId(
  blocks: readonly RawToolCallBlock[],
  fragments: RawArgumentFragments,
): Map<string, string> {
  const out = new Map<string, string>();
  blocks.forEach((block, index) => {
    if (block.type !== 'toolCall' || typeof block.id !== 'string') return;
    const raw = fragments.get(index);
    if (raw === undefined) return;
    if (!shouldPreferRawArguments(block.arguments, raw)) return;
    out.set(block.id, raw);
  });
  return out;
}

/**
 * Merge verbatim arguments into an existing map, never overwriting an entry the
 * transport already provided (the OpenAI-compatible path is authoritative).
 */
export function mergeRawArguments(
  existing: ReadonlyMap<string, string> | undefined,
  recovered: ReadonlyMap<string, string>,
): Map<string, string> | undefined {
  if (recovered.size === 0) return existing === undefined ? undefined : new Map(existing);
  const merged = new Map(existing ?? []);
  for (const [id, raw] of recovered) {
    if (!merged.has(id)) merged.set(id, raw);
  }
  return merged;
}
