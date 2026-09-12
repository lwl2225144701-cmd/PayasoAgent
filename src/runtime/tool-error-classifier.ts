// Module: Tool Error Classifier — decides whether a failed tool execution is
// worth retrying.
//
// Why this module exists (v1.8):
// The Runtime retried every non-`non_idempotent` tool failure twice. A missing
// file, an out-of-range offset and a bad argument are deterministic: retrying
// them executed the identical call three times, produced three identical error
// events, burned three model turns, and then tripped the "same args blocked"
// guard. The observed trace showed 10 of 12 error groups repeating exactly
// three times.
//
// Design: a Chain of Responsibility over an ordered rule list. The default is
// **not retryable** — a new, unclassified error is assumed permanent, which is
// the safe direction: retrying a side effect is worse than not retrying a
// transient failure. New knowledge is added by appending a rule, not by editing
// the classifier core.

import { NetworkDeniedError, RequiredRuntimeToolUnavailableError } from '../tools/tools.js';
import { isAbortError } from '../util/abort.js';

export type ToolErrorKind = 'transient' | 'permanent' | 'abort' | 'policy';

export interface ToolErrorClassification {
  kind: ToolErrorKind;
  /** True only for transient failures (network blips, locks, resource pressure). */
  retryable: boolean;
  /** Human-readable reason; safe to surface to the model. */
  reason: string;
  /** errno-style code when present. */
  code?: string;
}

interface ClassifierRule {
  name: string;
  classify(
    error: unknown,
    code: string | undefined,
    message: string,
  ): ToolErrorClassification | undefined;
}

/** errno codes that indicate a transient condition. */
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ETIME',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAGAIN',
  'EBUSY',
  'EINTR',
  'EMFILE',
  'ENFILE',
]);

/** errno codes that are deterministic for the same arguments. */
const PERMANENT_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EACCES',
  'EPERM',
  'EINVAL',
  'EEXIST',
  'ENOSPC',
  'EROFS',
  'ELOOP',
  'ENAMETOOLONG',
  'ENOTEMPTY',
  'EXDEV',
]);

/** Message patterns that indicate a transient upstream condition. */
const TRANSIENT_MESSAGE_PATTERNS: RegExp[] = [
  /\btimed?\s*out\b/i,
  /\btimeout\b/i,
  /\bfetch failed\b/i,
  /\bsocket hang up\b/i,
  /\bconnection reset\b/i,
  /\btemporarily unavailable\b/i,
  /\bresource temporarily unavailable\b/i,
  /\brate.?limit/i,
  /\bHTTP\s*(429|5\d\d)\b/i,
];

const RULES: ClassifierRule[] = [
  {
    name: 'abort',
    classify: (error) =>
      isAbortError(error)
        ? {
            kind: 'abort',
            retryable: false,
            reason: 'run aborted; retrying would ignore cancellation',
          }
        : undefined,
  },
  {
    name: 'policy-denial',
    classify: (error) => {
      if (error instanceof NetworkDeniedError) {
        return {
          kind: 'policy',
          retryable: false,
          reason: 'network policy denied this tool; retrying cannot change the policy',
        };
      }
      if (error instanceof RequiredRuntimeToolUnavailableError) {
        return {
          kind: 'policy',
          retryable: false,
          reason: 'required runtime tool is unavailable; retrying cannot install it',
        };
      }
      return undefined;
    },
  },
  {
    name: 'errno',
    classify: (_error, code) => {
      if (code === undefined) return undefined;
      if (TRANSIENT_CODES.has(code)) {
        return { kind: 'transient', retryable: true, reason: `transient errno ${code}`, code };
      }
      if (PERMANENT_CODES.has(code)) {
        return { kind: 'permanent', retryable: false, reason: `deterministic errno ${code}`, code };
      }
      return undefined;
    },
  },
  {
    name: 'transient-message',
    classify: (_error, _code, message) => {
      const hit = TRANSIENT_MESSAGE_PATTERNS.find((pattern) => pattern.test(message));
      return hit
        ? { kind: 'transient', retryable: true, reason: 'transient upstream condition' }
        : undefined;
    },
  },
];

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Classify one tool execution failure.
 * Unclassified failures are treated as permanent (retryable: false).
 */
export function classifyToolError(error: unknown): ToolErrorClassification {
  const code = errnoCode(error);
  const message = errorMessage(error);
  for (const rule of RULES) {
    const classification = rule.classify(error, code, message);
    if (classification) return classification;
  }
  return {
    kind: 'permanent',
    retryable: false,
    reason: 'unclassified failure; not retried by default',
    ...(code === undefined ? {} : { code }),
  };
}
