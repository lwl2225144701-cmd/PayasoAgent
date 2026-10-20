// 模块: Execution Evidence Store — 每个 Run 的检查事实、执行身份与复用核对（计划 §6 / P1-A）。
//
// 职责边界（分层）：
//   - Tools 产生 ToolFacts（退出码/日志完整度/诊断）；Runtime 只保证"事实与版本关系真实"；
//   - 本模块是 Runtime 侧唯一数据归属：不把事实塞进计划文本、scratchpad 或 conversationSummary；
//   - 日志正文留在内容存储（input/spill/ 引用），Checkpoint 只保存引用与有界诊断。
//
// 失败关闭（fail-closed）：缺字段、未知版本、非法路径、超容量 → 一律按"未知"处理，
// 绝不从旧记录里恢复出 passed；新 Run 清空，resume 保留但复用前重新核对版本。
//
// 容量与淘汰（§6.1）：检查记录 ≤32、读取指纹 ≤256、文件变化 ≤64。淘汰优先 LRU 已结算，
// 但"未决 / uncertain / 当前迭代引用"的记录不可为腾位置删除；全部不可淘汰时拒绝新检查。

import {
  type CheckConclusion,
  type Diagnostic,
  EXECUTION_EVIDENCE_VERSION,
  MAX_DIAGNOSTICS_PER_RECORD,
  type ProcessFact,
  type ToolFacts,
  validateToolFacts,
} from '../execution-evidence.js';

/** 快照版本：与 ToolFacts 版本独立演进。 */
export const EVIDENCE_SNAPSHOT_VERSION = 1 as const;
export const MAX_CHECK_RECORDS = 32;
export const MAX_READ_FINGERPRINTS = 256;
export const MAX_MUTATION_FINGERPRINTS = 64;
/** Harness 视图里最多投影的检查摘要条数（§8.2）。 */
export const MAX_VIEW_CHECKS = 8;

export type ExecutionState = 'pending' | 'running' | 'settled' | 'uncertain';

/** 一次检查的执行记录（§6.2 字段表的落地形态）。 */
export interface CheckRecord {
  checkId: string;
  /** Runtime 分配；与 side-effect 操作身份同源，模型不可传入。 */
  invocationId: string;
  /** 迭代号/批次位置/tool_call_id/参数摘要的规范化定位串。 */
  origin: string;
  /** 规范化 profile/程序/参数/cwd/paths/固定 baseline/超时/适配器版本的摘要。 */
  specHash: string;
  inputFingerprint: string | null;
  scopeComplete: boolean;
  executionState: ExecutionState;
  conclusion: CheckConclusion | null;
  process: ProcessFact | null;
  diagnostics: Diagnostic[] | null;
  source: 'executed' | 'reused';
  startedAt: string;
  finishedAt: string | null;
  logRefs: { stdoutRef?: string; stderrRef?: string } | null;
  reusable: boolean;
  invalidationReason?: string;
  /** 最近一次被找到/复用的序号（LRU 与访问追踪）。 */
  lastAccessSeq: number;
  iteration: number;
}

export interface ReadFingerprint {
  path: string;
  versionKind: 'content' | 'stat';
  version: string;
  queryHash?: string;
  returnedHash: string;
  complete: boolean;
  seq: number;
}

export interface MutationFingerprint {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  seq: number;
}

export interface PendingInvocation {
  invocationId: string;
  checkId: string;
  origin: string;
  specHash: string;
  inputFingerprint: string | null;
  executionState: ExecutionState;
  startedAt: string;
  iteration: number;
}

export interface ExecutionEvidenceSnapshot {
  version: typeof EVIDENCE_SNAPSHOT_VERSION;
  sequence: number;
  records: CheckRecord[];
  reads: ReadFingerprint[];
  mutations: MutationFingerprint[];
  pending: PendingInvocation[];
}

/** Harness 只读投影：不带日志正文、不带环境明文。 */
export interface EvidenceViewCheck {
  checkId: string;
  profile: 'process' | 'biome-lint';
  conclusion: CheckConclusion | null;
  source: 'executed' | 'reused';
  reusable: boolean;
}

export interface EvidenceView {
  checks: EvidenceViewCheck[];
}

export interface InvocationSpec {
  /** 检查对象摘要（profile/程序/参数/cwd/paths/baseline/工具版本/适配器版本）。 */
  specHash: string;
  /** 依赖闭包摘要；null = 未提供（比 null 与 null 相同才可复用）。 */
  inputFingerprint?: string | null;
}

export interface InvocationHandle {
  invocationId: string;
  checkId: string;
  /** true = 该 origin 已有可用记录（resume 场景）；调用方应据此回放而非重新执行。 */
  reused: boolean;
  record: CheckRecord | null;
}

export interface RecordMeta {
  iteration?: number;
  durationMs?: number;
}

export interface ExecutionEvidenceStore {
  /** 恢复快照；任何不识别的内容按空记录处理，绝不恢复出 passed。 */
  restore(snapshot: unknown): void;
  /** 当前迭代号：用于保护"当前迭代引用"的记录不被淘汰。 */
  setIteration(iteration: number): void;
  /** 取得（或创建）本次调用的执行身份；同 origin 恢复时返回已持久化身份。 */
  getOrCreateInvocation(origin: string, spec: InvocationSpec): InvocationHandle | null;
  /** 按检查对象摘要 + 依赖闭包查找仍有效的已结算结论。 */
  findReusable(specHash: string, inputFingerprint: string | null): CheckRecord | null;
  /** 记录一次检查结果（含 invalid facts 的未知记录）。 */
  recordResult(invocationId: string, rawFacts: unknown, meta?: RecordMeta): CheckRecord | null;
  /** 记录未决/不确定退出（超时、取消、异常）。 */
  recordUncertain(invocationId: string, reason: string): void;
  /** 记录一次读取/变更指纹（批次 E 的事实观察可用；本模块只做有界存储）。返回新增条数。 */
  recordReads(facts: readonly unknown[], iteration?: number): number;
  recordMutations(facts: readonly unknown[], iteration?: number): number;
  snapshot(): ExecutionEvidenceSnapshot;
  view(): EvidenceView;
  /** 是否有未决/不确定的检查（回退保护：旧版本不能忽略后盲目重跑）。 */
  hasUnresolved(): boolean;
}

const EMPTY_SNAPSHOT: ExecutionEvidenceSnapshot = {
  version: EVIDENCE_SNAPSHOT_VERSION,
  sequence: 0,
  records: [],
  reads: [],
  mutations: [],
  pending: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isConclusion(value: unknown): value is CheckConclusion {
  return value === 'passed' || value === 'failed' || value === 'inconclusive';
}

function normalizeProcessFact(value: unknown): ProcessFact | null {
  if (!isRecord(value)) return null;
  const exitCode = value.exitCode;
  if (exitCode !== null && typeof exitCode !== 'number') return null;
  if (typeof value.timedOut !== 'boolean') return null;
  if (typeof value.logsComplete !== 'boolean') return null;
  const fact: ProcessFact = {
    exitCode,
    timedOut: value.timedOut,
    logsComplete: value.logsComplete,
  };
  if (typeof value.stdoutRef === 'string') fact.stdoutRef = value.stdoutRef;
  if (typeof value.stderrRef === 'string') fact.stderrRef = value.stderrRef;
  return fact;
}

function normalizeDiagnostics(value: unknown): Diagnostic[] | null {
  if (!Array.isArray(value)) return null;
  const out: Diagnostic[] = [];
  for (const item of value.slice(0, MAX_DIAGNOSTICS_PER_RECORD)) {
    if (!isRecord(item)) return null;
    if (!isNonEmptyString(item.path)) return null;
    if (!isNonEmptyString(item.rule)) return null;
    if (item.severity !== 'error' && item.severity !== 'warning' && item.severity !== 'info') {
      return null;
    }
    if (typeof item.message !== 'string' || typeof item.primarySnippet !== 'string') return null;
    if (!Array.isArray(item.relatedSnippets)) return null;
    if (typeof item.fingerprint !== 'string') return null;
    out.push({
      path: item.path,
      rule: item.rule,
      severity: item.severity,
      message: item.message,
      primarySnippet: item.primarySnippet,
      relatedSnippets: item.relatedSnippets.filter(
        (s): s is string => typeof s === 'string',
      ) as string[],
      fingerprint: item.fingerprint,
    });
  }
  return out;
}

function normalizeRecord(value: unknown): CheckRecord | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.checkId)) return null;
  if (!isNonEmptyString(value.invocationId)) return null;
  if (!isNonEmptyString(value.origin)) return null;
  if (!isNonEmptyString(value.specHash)) return null;
  const state = value.executionState;
  if (state !== 'pending' && state !== 'running' && state !== 'settled' && state !== 'uncertain') {
    return null;
  }
  if (value.source !== 'executed' && value.source !== 'reused') return null;
  if (!isNonEmptyString(value.startedAt)) return null;
  if (
    !isStringOrNull(value.conclusion) ||
    (value.conclusion !== null && !isConclusion(value.conclusion))
  ) {
    return null;
  }
  const diagnostics = value.diagnostics === null ? null : normalizeDiagnostics(value.diagnostics);
  if (value.diagnostics !== null && diagnostics === null) return null;
  const record: CheckRecord = {
    checkId: value.checkId,
    invocationId: value.invocationId,
    origin: value.origin,
    specHash: value.specHash,
    inputFingerprint: isStringOrNull(value.inputFingerprint) ? value.inputFingerprint : null,
    scopeComplete: value.scopeComplete === true,
    executionState: state,
    // 关键 fail-closed：快照里没有合法结论就是未知，绝不推断 passed。
    conclusion:
      value.conclusion !== null && isConclusion(value.conclusion) ? value.conclusion : null,
    process: normalizeProcessFact(value.process),
    diagnostics,
    source: value.source,
    startedAt: value.startedAt,
    finishedAt: isStringOrNull(value.finishedAt) ? value.finishedAt : null,
    logRefs: isRecord(value.logRefs)
      ? {
          ...(typeof value.logRefs.stdoutRef === 'string'
            ? { stdoutRef: value.logRefs.stdoutRef }
            : {}),
          ...(typeof value.logRefs.stderrRef === 'string'
            ? { stderrRef: value.logRefs.stderrRef }
            : {}),
        }
      : null,
    reusable: value.reusable === true,
    lastAccessSeq: typeof value.lastAccessSeq === 'number' ? value.lastAccessSeq : 0,
    iteration: typeof value.iteration === 'number' ? value.iteration : 0,
  };
  if (typeof value.invalidationReason === 'string') {
    record.invalidationReason = value.invalidationReason;
  }
  return record;
}

/** 读取指纹身份：同一路径的同版本同返回范围摘要 = 同一事实。 */
function readFingerprintKey(fingerprint: ReadFingerprint): string {
  return [
    fingerprint.path,
    fingerprint.versionKind,
    fingerprint.version,
    fingerprint.queryHash ?? '',
    fingerprint.returnedHash,
    fingerprint.complete ? '1' : '0',
  ].join('\u0000');
}

/** 变更指纹身份：路径 + 前后哈希（before/after 都不同 = 不同事实）。 */
function mutationFingerprintKey(fingerprint: MutationFingerprint): string {
  return [fingerprint.path, fingerprint.beforeHash ?? '', fingerprint.afterHash ?? ''].join(
    '\u0000',
  );
}

function normalizeReadFingerprint(value: unknown): ReadFingerprint | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.path)) return null;
  if (value.versionKind !== 'content' && value.versionKind !== 'stat') return null;
  if (typeof value.version !== 'string') return null;
  if (typeof value.returnedHash !== 'string') return null;
  if (typeof value.complete !== 'boolean') return null;
  return {
    path: value.path,
    versionKind: value.versionKind,
    version: value.version,
    ...(typeof value.queryHash === 'string' ? { queryHash: value.queryHash } : {}),
    returnedHash: value.returnedHash,
    complete: value.complete,
    seq: typeof value.seq === 'number' ? value.seq : 0,
  };
}

function normalizeMutationFingerprint(value: unknown): MutationFingerprint | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.path)) return null;
  if (!isStringOrNull(value.beforeHash) || !isStringOrNull(value.afterHash)) return null;
  return {
    path: value.path,
    beforeHash: value.beforeHash,
    afterHash: value.afterHash,
    seq: typeof value.seq === 'number' ? value.seq : 0,
  };
}

function normalizePending(value: unknown): PendingInvocation | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.invocationId)) return null;
  if (!isNonEmptyString(value.checkId)) return null;
  if (!isNonEmptyString(value.origin)) return null;
  if (!isNonEmptyString(value.specHash)) return null;
  const state = value.executionState;
  if (state !== 'pending' && state !== 'running' && state !== 'settled' && state !== 'uncertain') {
    return null;
  }
  return {
    invocationId: value.invocationId,
    checkId: value.checkId,
    origin: value.origin,
    specHash: value.specHash,
    inputFingerprint: isStringOrNull(value.inputFingerprint) ? value.inputFingerprint : null,
    executionState: state,
    startedAt: isNonEmptyString(value.startedAt) ? value.startedAt : new Date(0).toISOString(),
    iteration: typeof value.iteration === 'number' ? value.iteration : 0,
  };
}

/** 从任意来源恢复快照：返回规范化结果或空快照（fail-closed）。 */
export function normalizeEvidenceSnapshot(raw: unknown): ExecutionEvidenceSnapshot {
  if (!isRecord(raw)) return { ...EMPTY_SNAPSHOT };
  if (raw.version !== EVIDENCE_SNAPSHOT_VERSION) return { ...EMPTY_SNAPSHOT };
  const records: CheckRecord[] = [];
  for (const item of Array.isArray(raw.records) ? raw.records : []) {
    const record = normalizeRecord(item);
    if (record) records.push(record);
  }
  const reads: ReadFingerprint[] = [];
  for (const item of Array.isArray(raw.reads) ? raw.reads : []) {
    const read = normalizeReadFingerprint(item);
    if (read) reads.push(read);
  }
  const mutations: MutationFingerprint[] = [];
  for (const item of Array.isArray(raw.mutations) ? raw.mutations : []) {
    const mutation = normalizeMutationFingerprint(item);
    if (mutation) mutations.push(mutation);
  }
  const pending: PendingInvocation[] = [];
  for (const item of Array.isArray(raw.pending) ? raw.pending : []) {
    const entry = normalizePending(item);
    if (entry) pending.push(entry);
  }
  return {
    version: EVIDENCE_SNAPSHOT_VERSION,
    sequence: typeof raw.sequence === 'number' && raw.sequence >= 0 ? raw.sequence : 0,
    records,
    reads,
    mutations,
    pending,
  };
}

/** 判断一条记录是否"可作为已结算结论复用"。 */
function isReusableRecord(record: CheckRecord): boolean {
  return (
    record.executionState === 'settled' &&
    record.source === 'executed' &&
    record.reusable &&
    record.conclusion !== null
  );
}

/**
 * 创建 per-Run 事实存储。由 createAgentContext() 创建；新 Run 使用全新实例，
 * resume 时先 restore(checkpoint.executionEvidence)。
 */
export function createExecutionEvidenceStore(): ExecutionEvidenceStore {
  let sequence = 0;
  let iteration = 0;
  let records: CheckRecord[] = [];
  let reads: ReadFingerprint[] = [];
  let mutations: MutationFingerprint[] = [];
  const pending = new Map<string, PendingInvocation>();

  const now = (): string => new Date().toISOString();
  const nextSeq = (): number => {
    sequence += 1;
    return sequence;
  };

  const findRecord = (invocationId: string): CheckRecord | undefined =>
    records.find((record) => record.invocationId === invocationId);

  /** 腾出空间：只淘汰已结算、非 uncertain、非当前迭代的记录；返回是否成功。 */
  const makeRoom = (): boolean => {
    if (records.length < MAX_CHECK_RECORDS) return true;
    const candidates = records
      .filter(
        (record) =>
          record.executionState === 'settled' &&
          record.iteration < iteration &&
          record.checkId !== undefined,
      )
      .sort((a, b) => a.lastAccessSeq - b.lastAccessSeq);
    const victim = candidates[0];
    if (!victim) return false;
    records = records.filter((record) => record !== victim);
    const entry = pending.get(victim.invocationId);
    if (entry && entry.executionState === 'settled') pending.delete(victim.invocationId);
    return true;
  };

  const trimReads = (): void => {
    while (reads.length > MAX_READ_FINGERPRINTS) {
      reads.sort((a, b) => a.seq - b.seq);
      reads.shift();
    }
  };

  const trimMutations = (): void => {
    while (mutations.length > MAX_MUTATION_FINGERPRINTS) {
      mutations.sort((a, b) => a.seq - b.seq);
      mutations.shift();
    }
  };

  return {
    restore(snapshot: unknown): void {
      const normalized = normalizeEvidenceSnapshot(snapshot);
      sequence = normalized.sequence;
      records = normalized.records;
      reads = normalized.reads;
      mutations = normalized.mutations;
      pending.clear();
      for (const entry of normalized.pending) pending.set(entry.origin, entry);
    },

    setIteration(next: number): void {
      if (Number.isFinite(next) && next >= 0) iteration = Math.floor(next);
    },

    getOrCreateInvocation(origin: string, spec: InvocationSpec): InvocationHandle | null {
      const existing = pending.get(origin);
      if (existing) {
        const record = findRecord(existing.invocationId) ?? null;
        return {
          invocationId: existing.invocationId,
          checkId: existing.checkId,
          reused: existing.executionState === 'settled' || existing.executionState === 'uncertain',
          record,
        };
      }
      if (!makeRoom()) return null;
      const seq = nextSeq();
      const invocationId = `inv-${seq}`;
      const checkId = `chk-${seq}`;
      const startedAt = now();
      const record: CheckRecord = {
        checkId,
        invocationId,
        origin,
        specHash: spec.specHash,
        inputFingerprint: spec.inputFingerprint ?? null,
        scopeComplete: false,
        executionState: 'pending',
        conclusion: null,
        process: null,
        diagnostics: null,
        source: 'executed',
        startedAt,
        finishedAt: null,
        logRefs: null,
        reusable: false,
        lastAccessSeq: seq,
        iteration,
      };
      records.push(record);
      pending.set(origin, {
        invocationId,
        checkId,
        origin,
        specHash: spec.specHash,
        inputFingerprint: spec.inputFingerprint ?? null,
        executionState: 'pending',
        startedAt,
        iteration,
      });
      return { invocationId, checkId, reused: false, record };
    },

    findReusable(specHash: string, inputFingerprint: string | null): CheckRecord | null {
      const fingerprint = inputFingerprint ?? null;
      const match = records.find(
        (record) =>
          isReusableRecord(record) &&
          record.specHash === specHash &&
          (record.inputFingerprint ?? null) === fingerprint,
      );
      if (!match) return null;
      match.lastAccessSeq = nextSeq();
      return match;
    },

    recordResult(invocationId: string, rawFacts: unknown, meta?: RecordMeta): CheckRecord | null {
      const record = findRecord(invocationId);
      if (!record) return null;
      const validation = validateToolFacts(rawFacts);
      const facts: ToolFacts | null = validation.facts;
      if (!validation.valid || facts === null) {
        // 不识别的事实：保留"未知"记录，绝不产生通过结论。
        record.executionState = 'settled';
        record.conclusion = null;
        record.reusable = false;
        record.scopeComplete = false;
        record.finishedAt = now();
        record.invalidationReason = validation.issues[0] ?? 'invalid_facts';
        const entry = pending.get(record.origin);
        if (entry) entry.executionState = 'settled';
        return record;
      }
      const check = facts.check;
      record.process = facts.process ?? null;
      record.conclusion = check?.conclusion ?? null;
      record.diagnostics = check?.diagnostics ?? null;
      record.scopeComplete = validation.reportComplete;
      record.executionState = 'settled';
      record.reusable = validation.reusable && record.conclusion !== null;
      record.finishedAt = now();
      record.lastAccessSeq = nextSeq();
      if (facts.process) {
        record.logRefs = {
          ...(facts.process.stdoutRef ? { stdoutRef: facts.process.stdoutRef } : {}),
          ...(facts.process.stderrRef ? { stderrRef: facts.process.stderrRef } : {}),
        };
      }
      if (!record.reusable) {
        record.invalidationReason = validation.reportComplete
          ? (validation.issues[0] ?? 'not_reusable')
          : 'report_incomplete';
      }
      const entry = pending.get(record.origin);
      if (entry) entry.executionState = 'settled';
      // 读取/变更事实有界留存（republish 给后续批次 E 的进度判断）。
      this.recordReads(facts.reads ?? [], meta?.iteration);
      this.recordMutations(facts.mutations ?? [], meta?.iteration);
      return record;
    },

    recordUncertain(invocationId: string, reason: string): void {
      const record = findRecord(invocationId);
      if (record) {
        record.executionState = 'uncertain';
        record.reusable = false;
        record.finishedAt = now();
        record.invalidationReason = reason;
      }
      const entry = [...pending.values()].find((item) => item.invocationId === invocationId);
      if (entry) entry.executionState = 'uncertain';
    },

    recordReads(facts: readonly unknown[], readIteration?: number): number {
      let added = 0;
      for (const fact of facts) {
        if (!isRecord(fact)) continue;
        const fingerprint = normalizeReadFingerprint({ ...fact, seq: nextSeq() });
        if (!fingerprint) continue;
        // 相同读取指纹（同版本 + 同返回范围摘要）重复出现不是新增事实（计划 §8.1）：
        // 已有记录只刷新序号并移到队尾，不重复占容量，也不计入新增。
        const key = readFingerprintKey(fingerprint);
        const existing = reads.findIndex((item) => readFingerprintKey(item) === key);
        if (existing >= 0) {
          const previous = reads[existing];
          if (previous) reads[existing] = { ...previous, seq: fingerprint.seq };
          const [moved] = reads.splice(existing, 1);
          if (moved) reads.push(moved);
          continue;
        }
        reads.push(fingerprint);
        added += 1;
        trimReads();
      }
      void readIteration;
      return added;
    },

    recordMutations(facts: readonly unknown[], mutationIteration?: number): number {
      let added = 0;
      for (const fact of facts) {
        if (!isRecord(fact)) continue;
        const fingerprint = normalizeMutationFingerprint({ ...fact, seq: nextSeq() });
        if (!fingerprint) continue;
        const key = mutationFingerprintKey(fingerprint);
        const existing = mutations.findIndex((item) => mutationFingerprintKey(item) === key);
        if (existing >= 0) {
          const previous = mutations[existing];
          if (previous) mutations[existing] = { ...previous, seq: fingerprint.seq };
          const [moved] = mutations.splice(existing, 1);
          if (moved) mutations.push(moved);
          continue;
        }
        mutations.push(fingerprint);
        added += 1;
        trimMutations();
      }
      void mutationIteration;
      return added;
    },

    snapshot(): ExecutionEvidenceSnapshot {
      return {
        version: EVIDENCE_SNAPSHOT_VERSION,
        sequence,
        records: records.slice(0, MAX_CHECK_RECORDS).map((record) => ({ ...record })),
        reads: reads.slice(-MAX_READ_FINGERPRINTS).map((read) => ({ ...read })),
        mutations: mutations.slice(-MAX_MUTATION_FINGERPRINTS).map((mutation) => ({ ...mutation })),
        pending: [...pending.values()].slice(0, MAX_CHECK_RECORDS).map((entry) => ({ ...entry })),
      };
    },

    view(): EvidenceView {
      const recent = records
        .filter((record) => record.executionState === 'settled' && record.conclusion !== null)
        .sort((a, b) => b.lastAccessSeq - a.lastAccessSeq)
        .slice(0, MAX_VIEW_CHECKS)
        .map((record) => ({
          checkId: record.checkId,
          profile: inferProfile(record),
          conclusion: record.conclusion,
          source: record.source,
          reusable: record.reusable,
        }));
      return { checks: recent };
    },

    hasUnresolved(): boolean {
      return records.some(
        (record) => record.executionState === 'pending' || record.executionState === 'uncertain',
      );
    },
  };
}

/** 记录里的 profile 只从 facts 形状推断（process 有退出码事实，biome-lint 有诊断）。 */
function inferProfile(record: CheckRecord): 'process' | 'biome-lint' {
  if (record.process !== null) return 'process';
  if (record.diagnostics !== null) return 'biome-lint';
  return 'process';
}

export { EXECUTION_EVIDENCE_VERSION };
