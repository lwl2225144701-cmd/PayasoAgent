// Module: Instruction Composer — ordered system prompt segments with budgets.
// Replaces ad-hoc string concatenation with a registry of named segments,
// each with a priority, budget and mutability. Static segments come first
// (prompt-cache friendly); dynamic segments refresh per turn.
//
// Design principles:
// - Static first, dynamic last: maximizes upstream prompt cache hits
// - Hard budgets per segment; overflow truncates the segment in place
// - Total overflow: lowest-priority segments are dropped entirely
// - kernel.base is never dropped (we'd rather exceed budget than lose rules)

import { estimateTextTokens } from './model-context.js';

export type SegmentMutability = 'static' | 'per_run' | 'dynamic';

export interface SystemSegment {
  /** Unique id, e.g. 'kernel.base' */
  id: string;
  /** Lower = comes first in the final prompt. */
  priority: number;
  /** Segment body text (English by convention). */
  content: string;
  /** Hard token budget for this segment; excess is truncated. */
  budgetTokens: number;
  /** How often the content changes — affects cache strategy. */
  mutability: SegmentMutability;
}

export interface SegmentDiagnostic {
  id: string;
  priority: number;
  mutability: SegmentMutability;
  originalTokens: number;
  budgetTokens: number;
  returnedTokens: number;
  truncated: boolean;
  dropped: boolean;
}

export interface ComposedResult {
  content: string;
  totalTokens: number;
  diagnostics: SegmentDiagnostic[];
}

const TRUNCATION_MARKER = '\n…[truncated]';

/**
 * Truncate text to fit within maxTokens, appending a marker if cut.
 * Uses binary search on string length (cheap) against the same token estimator
 * used everywhere in the harness — consistent, not precise.
 */
function truncateToTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean; tokens: number } {
  const originalTokens = estimateTextTokens(text);
  if (originalTokens <= maxTokens) {
    return { text, truncated: false, tokens: originalTokens };
  }
  const markerTokens = estimateTextTokens(TRUNCATION_MARKER);
  const bodyBudget = Math.max(0, maxTokens - markerTokens);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(text.slice(0, mid)) <= bodyBudget) low = mid;
    else high = mid - 1;
  }
  const result = text.slice(0, low) + TRUNCATION_MARKER;
  return { text: result, truncated: true, tokens: estimateTextTokens(result) };
}

export class InstructionComposer {
  private segments = new Map<string, SystemSegment>();
  /** The segment that must never be dropped, even if total budget is exceeded. */
  private kernelId = 'kernel.base';

  addSegment(segment: SystemSegment): void {
    if (this.segments.has(segment.id)) {
      throw new Error(`InstructionComposer: duplicate segment id "${segment.id}"`);
    }
    this.segments.set(segment.id, { ...segment });
  }

  updateContent(id: string, content: string): void {
    const seg = this.segments.get(id);
    if (!seg) {
      throw new Error(`InstructionComposer: unknown segment id "${id}"`);
    }
    seg.content = content;
  }

  removeSegment(id: string): boolean {
    return this.segments.delete(id);
  }

  get(id: string): SystemSegment | undefined {
    const seg = this.segments.get(id);
    return seg ? { ...seg } : undefined;
  }

  has(id: string): boolean {
    return this.segments.has(id);
  }

  /**
   * Compose all segments into a single system prompt string.
   *
   * Order: ascending priority (lower number first).
   * Budget: each segment is truncated to its own budget first; if the total
   * still exceeds maxTokens, lowest-priority segments are dropped entirely.
   * The kernel segment is never dropped.
   */
  compose(maxTokens: number): ComposedResult {
    const ordered = [...this.segments.values()].sort((a, b) => a.priority - b.priority);

    // Pass 1: truncate each segment to its own budget
    const prepared = ordered.map((seg) => {
      const { text, truncated, tokens } = truncateToTokens(seg.content, seg.budgetTokens);
      return {
        seg,
        text,
        truncated,
        returnedTokens: tokens,
        originalTokens: estimateTextTokens(seg.content),
        dropped: false,
      };
    });

    // Pass 2: drop lowest-priority non-kernel segments until total fits
    // (walk from the end; keep kernel.base no matter what)
    let total = prepared.reduce((sum, p) => sum + p.returnedTokens + 1, 0); // +1 for newline separator
    for (let i = prepared.length - 1; i >= 0 && total > maxTokens; i--) {
      if (prepared[i].seg.id === this.kernelId) continue;
      total -= prepared[i].returnedTokens + 1;
      prepared[i].dropped = true;
      prepared[i].text = '';
      prepared[i].returnedTokens = 0;
    }

    const kept = prepared.filter((p) => !p.dropped);
    const content = kept.map((p) => p.text).join('\n\n');
    const totalTokens = estimateTextTokens(content);

    const diagnostics: SegmentDiagnostic[] = prepared.map((p) => ({
      id: p.seg.id,
      priority: p.seg.priority,
      mutability: p.seg.mutability,
      originalTokens: p.originalTokens,
      budgetTokens: p.seg.budgetTokens,
      returnedTokens: p.returnedTokens,
      truncated: p.truncated,
      dropped: p.dropped,
    }));

    return { content, totalTokens, diagnostics };
  }

  /** Return diagnostics without composing the full string (cheap). */
  diagnostics(maxTokens: number): SegmentDiagnostic[] {
    return this.compose(maxTokens).diagnostics;
  }

  /** Number of registered segments. */
  get size(): number {
    return this.segments.size;
  }

  /**
   * Set the id of the kernel segment that must never be dropped.
   * Defaults to 'kernel.base'. Throws if the id does not exist.
   */
  setKernelId(id: string): void {
    if (!this.segments.has(id)) {
      throw new Error(`InstructionComposer: kernel id "${id}" not found`);
    }
    this.kernelId = id;
  }
}
