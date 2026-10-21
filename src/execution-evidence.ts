// Module: Execution Evidence — the public DTO for facts a tool actually produced.
// docs/plans/agent-run-efficiency-optimization-plan-20261020.md §5.3 / §6.1.
//
// Why this module is a leaf (imports NOTHING, not even other src/ modules):
// Facts are produced by Tools, persisted by Runtime, and rendered by Harness. If
// the type lived in any of those layers, the other two would have to depend on
// it and the dependency direction would invert (Tools → Runtime → Harness). A
// zero-dependency module lets every layer share one shape without a cycle.
//
// Trust rules (the whole point of this protocol):
// - A conclusion is only ever derived from facts a producer stamped for THIS
//   execution. Legacy tool output (`[shell-exit-0]`, completedSteps, scratchpad)
//   is NOT evidence and must never be read as `passed`.
// - Anything unrecognized yields no passed fact: `validateToolFacts` fails
//   closed rather than guessing (unknown version, wrong field type, host
//   absolute path, unstable fingerprint).
// - Capacity is a completeness signal, not a cosmetic limit: over-cap records
//   keep their stored slice but set `reportComplete=false`, which forbids
//   comparison and reuse. The full evidence stays in the published log
//   (`ProcessFact.stdoutRef` / `stderrRef`), which is why the caps are safe.
// - `diagnostics: null` means "not obtained". `[]` means "a valid report with
//   zero diagnostics" — the two are never interchangeable.
//
// Fingerprint semantics (Diagnostic.fingerprint):
// A digest over the LOGICAL workspace-relative path + the RULE id + the
// normalized snippet. It must not contain temporary absolute paths or line
// numbers: a baseline comparison that keys on line numbers reports every moved
// line as a new problem (plan §7.3 / test case B01). Producers compute it;
// `isStableDiagnosticFingerprint` is the fail-closed consumer check.

/** Wire version of this protocol. Unknown versions are never interpreted. */
export const EXECUTION_EVIDENCE_VERSION = 1 as const;

/** Per-record capacity (plan §5.3): over-cap → incomplete report, no compare/reuse. */
export const MAX_DIAGNOSTICS_PER_RECORD = 128;
export const MAX_MUTATION_FACTS_PER_RECORD = 32;
export const MAX_READ_FACTS_PER_RECORD = 16;

/** Longest accepted opaque fingerprint (a digest never needs more). */
export const MAX_FINGERPRINT_LENGTH = 128;

export type CheckConclusion = 'passed' | 'failed' | 'inconclusive';

export type CheckProfileName = 'process' | 'biome-lint';

/** Runtime 提供给 Harness 的有界只读投影，不携带日志正文或宿主路径。 */
export interface EvidenceViewCheck {
  checkId: string;
  profile: CheckProfileName;
  conclusion: CheckConclusion | null;
  source: 'executed' | 'reused';
  reusable: boolean;
  validity: 'verified' | 'version-unknown' | 'stale';
  finishedAt: string | null;
  logRefs: { stdoutRef?: string; stderrRef?: string } | null;
}

export interface EvidenceView {
  checks: EvidenceViewCheck[];
  reads?: EvidenceViewRead[];
}

export interface EvidenceViewRead {
  path: string;
  versionKind: 'content' | 'stat';
  version: string;
  returnedRanges: ReadRange[];
  complete: boolean;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** Workspace-relative logical path (never a host absolute path). */
  path: string;
  rule: string;
  severity: DiagnosticSeverity;
  message: string;
  primarySnippet: string;
  relatedSnippets: string[];
  /** Digest of logical path + rule + snippet; no temp absolute path, no line numbers. */
  fingerprint: string;
}

export interface ReadRange {
  startLine: number;
  endLine: number;
}

export interface ReadFact {
  kind: 'file' | 'grep' | 'ls';
  path: string;
  versionKind: 'content' | 'stat';
  version: string;
  /** Normalized query + scope for grep/ls; not needed for a plain file read. */
  queryHash?: string;
  returnedRanges: ReadRange[];
  returnedHash: string;
  complete: boolean;
}

export interface MutationFact {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface ProcessFact {
  exitCode: number | null;
  timedOut: boolean;
  /** false = capture hit its ceiling or publishing failed → never "complete evidence". */
  logsComplete: boolean;
  /** Workspace-relative reference into the content store (input/spill/...), not a host path. */
  stdoutRef?: string;
  stderrRef?: string;
}

export interface CheckFactRecord {
  profile: CheckProfileName;
  conclusion: CheckConclusion;
  /** null = not obtained; [] = a valid report that genuinely has no diagnostics. */
  diagnostics: Diagnostic[] | null;
  reportComplete: boolean;
}

export interface ToolFacts {
  version: typeof EXECUTION_EVIDENCE_VERSION;
  process?: ProcessFact;
  check?: CheckFactRecord;
  reads?: ReadFact[];
  mutations?: MutationFact[];
}

/** Result of the consumer-side check, before anything is recorded or rendered. */
export interface ToolFactsValidation {
  /** Structure + version + paths + capacity all understood. false → record nothing. */
  valid: boolean;
  /** Normalized facts when `valid`; `null` when unrecognized. */
  facts: ToolFacts | null;
  /** Machine-readable reasons (bounded, never the payload itself). */
  issues: string[];
  /** false when anything was dropped or exceeded → no compare, no reuse. */
  reportComplete: boolean;
  /** May this record participate in a baseline/"is it new" comparison? */
  comparable: boolean;
  /** May a later call reuse this conclusion instead of re-running the check? */
  reusable: boolean;
  /** Conclusion usable under the rules above; `null` = unknown, never `passed`. */
  conclusion: CheckConclusion | null;
  /** true only when `passed` may be claimed at all. */
  mayClaimPassed: boolean;
}

const CHECK_PROFILES: readonly string[] = ['process', 'biome-lint'];
const CHECK_CONCLUSIONS: readonly string[] = ['passed', 'failed', 'inconclusive'];
const DIAGNOSTIC_SEVERITIES: readonly string[] = ['error', 'warning', 'info'];
const READ_KINDS: readonly string[] = ['file', 'grep', 'ls'];
const VERSION_KINDS: readonly string[] = ['content', 'stat'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Workspace-relative path test (fail-closed): no empty string, no NUL, no host
 * absolute path (`/…`, `C:\…`), no UNC, no parent-directory escape, and no
 * backslash pretending to be a separator on a POSIX-style key.
 */
export function isWorkspaceRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  const segments = value.split(/[/\\]/);
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Stable-fingerprint test: an opaque digest-like token. Path separators,
 * whitespace, or a line-number suffix mean the producer leaked volatile
 * identity into it, which would turn a moved line into a "new" problem.
 */
export function isStableDiagnosticFingerprint(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.length > MAX_FINGERPRINT_LENGTH) return false;
  if (/[/\\]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  // `foo.css:12:7` style location markers are volatile by definition.
  if (/:\d+(?::\d+)?$/.test(value)) return false;
  return true;
}

function invalidBase(issues: string[]): ToolFactsValidation {
  // Unrecognized evidence yields NO conclusion at all — most importantly no
  // `passed` — and blocks compare/reuse. The legacy text path is unaffected.
  return {
    valid: false,
    facts: null,
    issues,
    reportComplete: false,
    comparable: false,
    reusable: false,
    conclusion: null,
    mayClaimPassed: false,
  };
}

function validateDiagnostic(
  raw: Record<string, unknown>,
  index: number,
  issues: string[],
): boolean {
  if (!isWorkspaceRelativePath(raw.path)) {
    issues.push(`diagnostics[${index}].path is not a workspace-relative path`);
    return false;
  }
  if (!isNonEmptyString(raw.rule)) {
    issues.push(`diagnostics[${index}].rule missing`);
    return false;
  }
  if (typeof raw.severity !== 'string' || !DIAGNOSTIC_SEVERITIES.includes(raw.severity)) {
    issues.push(`diagnostics[${index}].severity unrecognized`);
    return false;
  }
  if (typeof raw.message !== 'string' || typeof raw.primarySnippet !== 'string') {
    issues.push(`diagnostics[${index}] message/primarySnippet must be strings`);
    return false;
  }
  if (!stringArray(raw.relatedSnippets)) {
    issues.push(`diagnostics[${index}].relatedSnippets must be a string array`);
    return false;
  }
  if (!isStableDiagnosticFingerprint(raw.fingerprint)) {
    issues.push(`diagnostics[${index}].fingerprint is not a stable logical fingerprint`);
    return false;
  }
  return true;
}

function validateReadFact(raw: Record<string, unknown>, index: number, issues: string[]): boolean {
  if (typeof raw.kind !== 'string' || !READ_KINDS.includes(raw.kind)) {
    issues.push(`reads[${index}].kind unrecognized`);
    return false;
  }
  if (!isWorkspaceRelativePath(raw.path)) {
    issues.push(`reads[${index}].path is not a workspace-relative path`);
    return false;
  }
  if (typeof raw.versionKind !== 'string' || !VERSION_KINDS.includes(raw.versionKind)) {
    issues.push(`reads[${index}].versionKind unrecognized`);
    return false;
  }
  if (!isNonEmptyString(raw.version) || !isNonEmptyString(raw.returnedHash)) {
    issues.push(`reads[${index}] version/returnedHash must be non-empty strings`);
    return false;
  }
  if (!isOptionalString(raw.queryHash)) {
    issues.push(`reads[${index}].queryHash must be a string when present`);
    return false;
  }
  if (
    !Array.isArray(raw.returnedRanges) ||
    !raw.returnedRanges.every(
      (range) =>
        isRecord(range) &&
        Number.isSafeInteger(range.startLine) &&
        Number.isSafeInteger(range.endLine) &&
        (range.startLine as number) > 0 &&
        (range.endLine as number) >= (range.startLine as number),
    )
  ) {
    issues.push(`reads[${index}].returnedRanges malformed`);
    return false;
  }
  if (!isBoolean(raw.complete)) {
    issues.push(`reads[${index}].complete must be boolean`);
    return false;
  }
  return true;
}

function validateMutationFact(
  raw: Record<string, unknown>,
  index: number,
  issues: string[],
): boolean {
  if (!isWorkspaceRelativePath(raw.path)) {
    issues.push(`mutations[${index}].path is not a workspace-relative path`);
    return false;
  }
  for (const key of ['beforeHash', 'afterHash'] as const) {
    if (raw[key] !== null && typeof raw[key] !== 'string') {
      issues.push(`mutations[${index}].${key} must be a string or null`);
      return false;
    }
  }
  return true;
}

/**
 * The single consumption entry point (plan §5.3: validate → record → render).
 * Never throws: bad evidence is reported, not repaired.
 */
export function validateToolFacts(raw: unknown): ToolFactsValidation {
  if (raw === undefined || raw === null) return invalidBase(['facts absent']);
  if (!isRecord(raw)) return invalidBase(['facts must be an object']);
  if (raw.version !== EXECUTION_EVIDENCE_VERSION) {
    return invalidBase([`unsupported facts version: ${String(raw.version)}`]);
  }

  const issues: string[] = [];
  let reportComplete = true;

  const facts: ToolFacts = { version: EXECUTION_EVIDENCE_VERSION };

  if (raw.process !== undefined) {
    if (!isRecord(raw.process)) {
      issues.push('process must be an object');
      return finalizeInvalid(issues);
    }
    const p = raw.process;
    if (!(p.exitCode === null || (Number.isInteger(p.exitCode) && (p.exitCode as number) >= 0))) {
      issues.push('process.exitCode must be a non-negative integer or null');
      return finalizeInvalid(issues);
    }
    if (!isBoolean(p.timedOut) || !isBoolean(p.logsComplete)) {
      issues.push('process.timedOut/logsComplete must be booleans');
      return finalizeInvalid(issues);
    }
    for (const key of ['stdoutRef', 'stderrRef'] as const) {
      if (p[key] !== undefined && !isWorkspaceRelativePath(p[key])) {
        issues.push(`process.${key} must be a workspace-relative reference`);
        return finalizeInvalid(issues);
      }
    }
    const processFact: ProcessFact = {
      exitCode: p.exitCode as number | null,
      timedOut: p.timedOut,
      logsComplete: p.logsComplete,
      ...(typeof p.stdoutRef === 'string' ? { stdoutRef: p.stdoutRef } : {}),
      ...(typeof p.stderrRef === 'string' ? { stderrRef: p.stderrRef } : {}),
    };
    facts.process = processFact;
    if (!processFact.logsComplete) reportComplete = false;
  }

  if (raw.check !== undefined) {
    if (!isRecord(raw.check)) {
      issues.push('check must be an object');
      return finalizeInvalid(issues);
    }
    const c = raw.check;
    if (typeof c.profile !== 'string' || !CHECK_PROFILES.includes(c.profile)) {
      issues.push('check.profile unrecognized');
      return finalizeInvalid(issues);
    }
    if (typeof c.conclusion !== 'string' || !CHECK_CONCLUSIONS.includes(c.conclusion)) {
      // A missing conclusion is never defaulted — defaulting is how `passed`
      // would sneak in. Incomplete report, no conclusion, no reuse.
      issues.push('check.conclusion missing or unrecognized');
      return finalizeInvalid(issues);
    }
    if (!isBoolean(c.reportComplete)) {
      issues.push('check.reportComplete must be boolean');
      return finalizeInvalid(issues);
    }
    if (c.diagnostics !== null && !Array.isArray(c.diagnostics)) {
      issues.push('check.diagnostics must be null or an array');
      return finalizeInvalid(issues);
    }
    let diagnostics: Diagnostic[] | null = c.diagnostics === null ? null : [];
    if (Array.isArray(c.diagnostics)) {
      const kept: Diagnostic[] = [];
      for (let index = 0; index < c.diagnostics.length; index++) {
        const item = c.diagnostics[index];
        if (!isRecord(item)) {
          issues.push(`check.diagnostics[${index}] must be an object`);
          return finalizeInvalid(issues);
        }
        if (!validateDiagnostic(item, index, issues)) return finalizeInvalid(issues);
        if (kept.length < MAX_DIAGNOSTICS_PER_RECORD) {
          kept.push(item as unknown as Diagnostic);
          continue;
        }
        // Over capacity: keep the bounded slice, mark the report incomplete, and
        // forbid compare/reuse. The complete evidence stays in the log ref.
        reportComplete = false;
        if (issues.length < 8) {
          issues.push(
            `check.diagnostics exceeded ${MAX_DIAGNOSTICS_PER_RECORD} (report incomplete)`,
          );
        }
        break;
      }
      diagnostics = kept;
    }
    facts.check = {
      profile: c.profile as CheckProfileName,
      conclusion: c.conclusion as CheckConclusion,
      diagnostics,
      reportComplete: c.reportComplete && reportComplete,
    };
    if (!c.reportComplete) reportComplete = false;
  }

  if (raw.reads !== undefined) {
    if (!Array.isArray(raw.reads)) {
      issues.push('reads must be an array');
      return finalizeInvalid(issues);
    }
    const kept: ReadFact[] = [];
    for (let index = 0; index < raw.reads.length; index++) {
      const item = raw.reads[index];
      if (!isRecord(item) || !validateReadFact(item, index, issues)) return finalizeInvalid(issues);
      if (kept.length < MAX_READ_FACTS_PER_RECORD) {
        kept.push(item as unknown as ReadFact);
        continue;
      }
      reportComplete = false;
      issues.push(`reads exceeded ${MAX_READ_FACTS_PER_RECORD} (report incomplete)`);
      break;
    }
    facts.reads = kept;
  }

  if (raw.mutations !== undefined) {
    if (!Array.isArray(raw.mutations)) {
      issues.push('mutations must be an array');
      return finalizeInvalid(issues);
    }
    const kept: MutationFact[] = [];
    for (let index = 0; index < raw.mutations.length; index++) {
      const item = raw.mutations[index];
      if (!isRecord(item) || !validateMutationFact(item, index, issues)) {
        return finalizeInvalid(issues);
      }
      if (kept.length < MAX_MUTATION_FACTS_PER_RECORD) {
        kept.push(item as unknown as MutationFact);
        continue;
      }
      reportComplete = false;
      issues.push(`mutations exceeded ${MAX_MUTATION_FACTS_PER_RECORD} (report incomplete)`);
      break;
    }
    facts.mutations = kept;
  }

  if (facts.check === undefined && facts.process === undefined) {
    // An empty facts envelope carries no evidence either way: recognized, but
    // it must not be rendered as a check result.
    reportComplete = false;
    issues.push('facts envelope contains no process or check record');
  }

  const logsComplete = facts.process ? facts.process.logsComplete : true;
  const comparable = reportComplete && logsComplete && facts.check !== undefined;
  // 通用进程没有可核实的依赖闭包；报告完整不等于输入版本已证明。
  const reusable =
    comparable &&
    facts.check?.profile === 'biome-lint' &&
    facts.check.conclusion !== 'inconclusive';
  const conclusion = facts.check?.conclusion ?? null;

  return {
    valid: true,
    facts,
    issues,
    reportComplete,
    comparable,
    reusable,
    conclusion,
    mayClaimPassed: comparable && conclusion === 'passed',
  };
}

function finalizeInvalid(issues: string[]): ToolFactsValidation {
  return invalidBase(issues.slice(0, 8));
}

/**
 * Convenience for consumers that only need one thing: "may I treat this as a
 * completed check?" Legacy output has no facts, so this returns `null` — the
 * caller must not infer anything from `[shell-exit-0]` or completedSteps.
 */
export function readCheckConclusion(raw: unknown): CheckConclusion | null {
  return validateToolFacts(raw).conclusion;
}
