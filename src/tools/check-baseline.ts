// 模块: Biome 检查适配器与 HEAD 基线比较（计划 §7 / 批次 D）
//
// 分层：这里只做"把已安装工具的输出变成可信事实"和"按多重集合比较两份报告"。
// 不读模型自由拼接的命令：argv 由适配器固定构造（lint --reporter=json <files>），
// 首版也只支持 CSS 路径（不推广为所有语言的语义验收）。
//
// 已验证的本地前提（计划 §7.1）：
// - `lint --reporter=json <file>` 返回可解析的 {summary, diagnostics, command}；
// - `--stdin-file-path` 在当前版本返回"contents aren't fixed"、exit 1、stdout 非 JSON
//   → 首版固定文件模式，绝不用 stdin 失败结果充当"基线 0 条告警"。
//
// 诚实边界：
// - 报告缺字段、diagnosticsNotPrinted>0、目标文件未被检查、路径越界 → 一律
//   inconclusive（不能比较、不能复用），不做"猜一个 0"。
// - 指纹不包含行号与临时绝对路径：行号移动不算新问题（B01）。
// - HEAD 视图构建失败（git 不可用、配置外部依赖、超容量、视图不可写）→
//   comparison='unknown' 并附具体原因，不退回"当前也没问题"。

import fs from 'node:fs';
import path from 'node:path';
import {
  type CheckConclusion,
  type Diagnostic,
  type DiagnosticSeverity,
  EXECUTION_EVIDENCE_VERSION,
  isStableDiagnosticFingerprint,
  isWorkspaceRelativePath,
  type ToolFacts,
} from '../execution-evidence.js';
import {
  CHECK_LOG_CAPTURE_MAX_BYTES,
  type CheckRunnerDeps,
  runCheckProcess,
} from './check-runner.js';
import { factDigest } from './tool-facts.js';
import type { ToolContext } from './tools.js';

/** 视图资源边界（计划 §7.2 末段）：首版工程起点，不是实测容量结论。 */
export const BASELINE_MAX_FILES = 20_000;
export const BASELINE_MAX_BYTES = 64 * 1024 * 1024;

/** Biome 版本不探测就不比较：同一逻辑路径必须跑"同一工具版本"。 */
export const BIOME_SUPPORTED_MAJOR = 1;

export interface BiomeCommandSummary {
  errors: number;
  warnings: number;
  diagnosticsNotPrinted: number;
  changed: number | null;
}

export type BiomeParseResult =
  | {
      state: 'valid';
      diagnostics: Diagnostic[];
      summary: BiomeCommandSummary;
      /** 报告完整性：所有诊断都可解析、没有被省略的诊断。 */
      reportComplete: boolean;
      reasons: string[];
    }
  | { state: 'invalid'; reasons: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  // Biome 的 message 是 {elements:[{kind,content}], content}[]；只取文本片段。
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') parts.push(item);
      else if (isRecord(item) && typeof item.content === 'string') parts.push(item.content);
      else if (isRecord(item) && Array.isArray(item.elements)) {
        for (const el of item.elements) {
          if (isRecord(el) && typeof el.content === 'string') parts.push(el.content);
        }
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

/**
 * 诊断指纹：逻辑路径 + 规则 + 主片段 + 相关片段 + 消息。
 * 不含行号/列号，也不含宿主绝对路径 —— 否则行号移动会被误报为新增问题（B01）。
 */
export function diagnosticFingerprint(input: {
  path: string;
  rule: string;
  primarySnippet: string;
  relatedSnippets: readonly string[];
  message: string;
}): string {
  const normalizedSnippet = (text: string): string =>
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();
  return factDigest(
    [
      input.path,
      input.rule,
      normalizedSnippet(input.primarySnippet),
      [...input.relatedSnippets].map(normalizedSnippet).sort().join('\u0001'),
      input.message.trim(),
    ].join('\u0000'),
  );
}

/**
 * 解析 Biome `--reporter=json` 的 stdout（文件模式）。
 * 未知格式、缺 summary、目标未被检查、诊断字段不可解析 → invalid（绝不返回 0 诊断）。
 */
export function parseBiomeJsonReport(
  stdout: string,
  options: { allowedPaths?: readonly string[] } = {},
): BiomeParseResult {
  const reasons: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: 'invalid', reasons: ['biome_stdout_not_json'] };
  }
  if (!isRecord(parsed)) return { state: 'invalid', reasons: ['biome_report_not_object'] };
  if (parsed.command !== 'lint') reasons.push('biome_command_not_lint');
  const rawSummary = parsed.summary;
  if (!isRecord(rawSummary)) return { state: 'invalid', reasons: ['biome_summary_missing'] };
  const numberField = (key: string): number | null => {
    const value = rawSummary[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const errors = numberField('errors');
  const warnings = numberField('warnings');
  const notPrinted = numberField('diagnosticsNotPrinted');
  if (errors === null || warnings === null) {
    return { state: 'invalid', reasons: ['biome_summary_counts_missing'] };
  }
  if (notPrinted === null) {
    // 没有该字段就无法证明诊断完整 —— 按不完整处理，不默认 0。
    reasons.push('biome_diagnostics_not_printed_unknown');
  }
  const rawDiagnostics = parsed.diagnostics;
  if (!Array.isArray(rawDiagnostics))
    return { state: 'invalid', reasons: ['biome_diagnostics_missing'] };

  const allowed = options.allowedPaths ? new Set(options.allowedPaths) : null;
  const diagnostics: Diagnostic[] = [];
  let reportComplete = notPrinted === 0;
  for (const [index, raw] of rawDiagnostics.entries()) {
    if (!isRecord(raw))
      return { state: 'invalid', reasons: [`biome_diagnostic_${index}_not_object`] };
    const rule = typeof raw.category === 'string' ? raw.category : null;
    const severityRaw = raw.severity;
    const severity: DiagnosticSeverity | null =
      severityRaw === 'error' || severityRaw === 'warning' || severityRaw === 'info'
        ? severityRaw
        : null;
    const location = isRecord(raw.location) ? raw.location : null;
    const locationPath = location && isRecord(location.path) ? location.path.file : null;
    const logicalPath =
      typeof locationPath === 'string' ? locationPath.split(path.sep).join('/') : null;
    const message = messageText(raw.message) ?? messageText(raw.description);
    if (!rule || !severity || !logicalPath || !message) {
      return { state: 'invalid', reasons: [`biome_diagnostic_${index}_incomplete`] };
    }
    if (!isWorkspaceRelativePath(logicalPath)) {
      return { state: 'invalid', reasons: [`biome_diagnostic_${index}_path_outside_workspace`] };
    }
    if (allowed && !allowed.has(logicalPath) && !allowed.has(`./${logicalPath}`)) {
      // 报告里出现未请求的文件：来源不可信，不能比较。
      return { state: 'invalid', reasons: [`biome_diagnostic_${index}_unrequested_path`] };
    }
    const primarySnippet =
      typeof raw.sourceCode === 'string'
        ? raw.sourceCode
        : typeof raw.description === 'string'
          ? raw.description
          : message;
    const relatedSnippets: string[] = [];
    const advices = isRecord(raw.advices) ? raw.advices : null;
    if (advices) {
      for (const value of Object.values(advices)) {
        if (!Array.isArray(value)) continue;
        for (const advice of value) {
          if (isRecord(advice) && typeof advice.content === 'string') {
            relatedSnippets.push(advice.content);
          }
        }
      }
    }
    diagnostics.push({
      path: logicalPath,
      rule,
      severity,
      message,
      primarySnippet,
      relatedSnippets: relatedSnippets.slice(0, 8),
      fingerprint: diagnosticFingerprint({
        path: logicalPath,
        rule,
        primarySnippet,
        relatedSnippets,
        message,
      }),
    });
  }

  // 计数与诊断条数必须自洽：只得到计数而无完整诊断时不能比较来源（§7.2.6）。
  const totalDiagnostics = errors + warnings;
  if (totalDiagnostics !== diagnostics.length) {
    reasons.push('biome_summary_count_mismatch');
    reportComplete = false;
  }
  for (const item of diagnostics) {
    if (!isStableDiagnosticFingerprint(item.fingerprint)) {
      return { state: 'invalid', reasons: ['biome_fingerprint_unstable'] };
    }
  }
  return {
    state: 'valid',
    diagnostics,
    summary: {
      errors,
      warnings,
      diagnosticsNotPrinted: notPrinted ?? -1,
      changed: numberField('changed'),
    },
    reportComplete,
    reasons,
  };
}

export function conclusionFromBiome(
  result: Extract<BiomeParseResult, { state: 'valid' }>,
): CheckConclusion {
  if (!result.reportComplete) return 'inconclusive';
  return result.summary.errors > 0 ? 'failed' : 'passed';
}

/** 多重集合比较：只按指纹计数，不按条数，也不按行号（B02）。 */
export interface DiagnosticDiff {
  introduced: Diagnostic[];
  resolved: Diagnostic[];
  unchanged: number;
}

export function compareDiagnosticMultisets(
  current: readonly Diagnostic[],
  baseline: readonly Diagnostic[],
): DiagnosticDiff {
  const counts = (
    items: readonly Diagnostic[],
  ): Map<string, { count: number; sample: Diagnostic }> => {
    const map = new Map<string, { count: number; sample: Diagnostic }>();
    for (const item of items) {
      const entry = map.get(item.fingerprint);
      if (entry) entry.count += 1;
      else map.set(item.fingerprint, { count: 1, sample: item });
    }
    return map;
  };
  const currentCounts = counts(current);
  const baselineCounts = counts(baseline);
  const introduced: Diagnostic[] = [];
  const resolved: Diagnostic[] = [];
  let unchanged = 0;
  for (const [fingerprint, entry] of currentCounts) {
    const base = baselineCounts.get(fingerprint);
    const shared = base ? Math.min(base.count, entry.count) : 0;
    unchanged += shared;
    for (let i = shared; i < entry.count; i++) introduced.push(entry.sample);
  }
  for (const [fingerprint, entry] of baselineCounts) {
    const now = currentCounts.get(fingerprint);
    const shared = now ? Math.min(now.count, entry.count) : 0;
    for (let i = shared; i < entry.count; i++) resolved.push(entry.sample);
  }
  const byPathRule = (a: Diagnostic, b: Diagnostic): number =>
    `${a.path}\u0000${a.rule}`.localeCompare(`${b.path}\u0000${b.rule}`);
  return {
    introduced: introduced.sort(byPathRule),
    resolved: resolved.sort(byPathRule),
    unchanged,
  };
}

/**
 * 配置语义支持性检查（B04）：只支持"视图内自洽"的配置。
 * 相对 extends 可能指向视图外、npm: extends 需要 node_modules、绝对路径则越界——
 * 这些一律明确不支持，不静默跑成不同配置。
 */
export function inspectBiomeConfigSupport(
  configText: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (configText === null || configText.trim() === '') return { ok: true };
  let parsed: unknown;
  try {
    // biome.json 允许 JSONC 注释：先去掉整行 // 注释再解析（失败则按不支持处理）。
    const stripped = configText.replace(/^\s*\/\/.*$/gm, '');
    parsed = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: 'biome_config_unparsable' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'biome_config_not_object' };
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 8 || value === null || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const bad = visit(item, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'extends' || key === 'overrides' || key === 'include' || key === 'ignore') {
        const items = Array.isArray(child) ? child : [child];
        for (const item of items) {
          if (typeof item !== 'string') continue;
          if (item.startsWith('npm:') || item.startsWith('@'))
            return 'biome_config_package_extends';
          if (path.isAbsolute(item)) return 'biome_config_absolute_path';
          if (key === 'extends' && item.startsWith('..')) return 'biome_config_extends_outside';
        }
      }
      const bad = visit(child, depth + 1);
      if (bad) return bad;
    }
    return null;
  };
  const reason = visit(parsed, 0);
  return reason ? { ok: false, reason } : { ok: true };
}

/** 工作区内已安装的 Biome 入口与版本（不探测就退回明确不支持）。 */
export type BiomeInstall =
  | { ok: true; program: string; version: string; versionMajor: number }
  | { ok: false; reason: string };

export function resolveBiomeInstall(workspaceRoot: string): BiomeInstall {
  const candidates = [
    'node_modules/@biomejs/biome/bin/biome',
    'node_modules/.bin/biome',
    'node_modules/@biomejs/cli-darwin-arm64/biome',
    'node_modules/@biomejs/cli-darwin-x64/biome',
    'node_modules/@biomejs/cli-linux-x64/biome',
  ];
  let program: string | null = null;
  for (const candidate of candidates) {
    const absolute = path.join(workspaceRoot, candidate);
    try {
      const real = fs.realpathSync(absolute);
      if (!real.startsWith(`${fs.realpathSync(workspaceRoot)}${path.sep}`)) continue;
      if (!fs.statSync(real).isFile()) continue;
      program = real;
      break;
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  if (!program) return { ok: false, reason: 'biome_not_installed' };
  let version: string | null = null;
  for (const pkg of ['node_modules/@biomejs/biome/package.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(workspaceRoot, pkg), 'utf8'));
      if (isRecord(parsed) && typeof parsed.version === 'string') version = parsed.version;
    } catch {
      /* 版本缺失 */
    }
  }
  if (!version) return { ok: false, reason: 'biome_version_unknown' };
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) return { ok: false, reason: 'biome_version_unparsable' };
  if (major !== BIOME_SUPPORTED_MAJOR)
    return { ok: false, reason: `biome_version_unsupported_${major}` };
  return { ok: true, program, version, versionMajor: major };
}

/** 单视图 lint 执行（文件模式，argv 固定由适配器构造）。 */
export interface BiomeRunResult {
  conclusion: CheckConclusion;
  diagnostics: Diagnostic[];
  reportComplete: boolean;
  reasons: string[];
  exitCode: number | null;
  stdoutRef?: string;
  stderrRef?: string;
  stdoutBytes: number;
  stderrBytes: number;
  logsComplete: boolean;
  processRuns: number;
  displayCommand: string;
}

export async function runBiomeLint(options: {
  workspaceRoot: string;
  /** 视图根目录（真实路径，可等于工作区；HEAD 比较时是受管 scratch 视图）。 */
  viewRoot: string;
  viewDisplay: string;
  program: string;
  files: readonly string[];
  timeoutMs: number;
  context: ToolContext;
  deps?: CheckRunnerDeps;
}): Promise<BiomeRunResult> {
  const args = ['lint', '--reporter=json', ...options.files];
  const outcome = await runCheckProcess(
    {
      program: options.program,
      args,
      cwd: options.viewRoot,
      cwdDisplay: options.viewDisplay,
      timeoutMs: options.timeoutMs,
    },
    options.context,
    options.deps,
  );
  const parsed = parseBiomeJsonReport(outcome.stdoutText, { allowedPaths: options.files });
  const base = {
    exitCode: outcome.exitCode,
    ...(outcome.stdoutRef ? { stdoutRef: outcome.stdoutRef } : {}),
    ...(outcome.stderrRef ? { stderrRef: outcome.stderrRef } : {}),
    stdoutBytes: outcome.stdoutBytes,
    stderrBytes: outcome.stderrBytes,
    logsComplete: outcome.logsComplete,
    processRuns: outcome.processRuns,
    displayCommand: `biome ${args.join(' ')}`,
  };
  if (parsed.state === 'invalid') {
    // 报告不可解析/不完整 → inconclusive（绝不是"零诊断通过"）。
    return {
      ...base,
      conclusion: 'inconclusive',
      diagnostics: [],
      reportComplete: false,
      reasons: [...parsed.reasons, 'biome_report_invalid'],
    };
  }
  const conclusion = conclusionFromBiome(parsed);
  const reasons = [...parsed.reasons];
  if (conclusion === 'inconclusive') reasons.push('biome_report_incomplete');
  return {
    ...base,
    conclusion,
    diagnostics: parsed.diagnostics,
    reportComplete: parsed.reportComplete,
    reasons,
  };
}

// ---- HEAD 隔离视图 ----

export interface HeadViews {
  state: 'ok';
  sha: string;
  baselineRoot: string;
  currentRoot: string;
  files: string[];
  configSupport: { ok: true } | { ok: false; reason: string };
  /** 视图建立时的输入摘要（用于失效判断；不含环境明文）。 */
  scopeDigest: string;
}

export type HeadViewsResult = HeadViews | { state: 'unsupported'; reasons: string[] };

/**
 * 用 git 清单构建两个隔离视图（baseline=固定 SHA 内容，current=当前内容）。
 * 不 checkout / 不 stash / 不覆盖真实工作区：只在受管 scratch 下写视图副本。
 * 任一前提不满足即 unsupported（附原因），由调用方给出 comparison=unknown。
 */
export async function buildHeadViews(options: {
  workspaceRoot: string;
  scratchRoot: string;
  paths: readonly string[];
  timeoutMs: number;
  context: ToolContext;
  deps?: CheckRunnerDeps;
}): Promise<HeadViewsResult> {
  const git = async (args: string[]): Promise<{ ok: boolean; stdout: string }> => {
    const outcome = await runCheckProcess(
      {
        program: 'git',
        args,
        cwd: options.workspaceRoot,
        cwdDisplay: '.',
        timeoutMs: options.timeoutMs,
      },
      options.context,
      options.deps,
    );
    return { ok: outcome.exitCode === 0 && !outcome.timedOut, stdout: outcome.stdoutText };
  };
  const reasons: string[] = [];
  const head = await git(['rev-parse', 'HEAD']);
  if (!head.ok) return { state: 'unsupported', reasons: ['git_unavailable_or_no_head'] };
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    return { state: 'unsupported', reasons: ['git_head_not_fixed_sha'] };

  const listing = await git(['ls-tree', '-r', '-z', '--name-only', sha]);
  if (!listing.ok) return { state: 'unsupported', reasons: ['git_ls_tree_failed'] };
  const tracked = listing.stdout.split('\0').filter((item) => item !== '');
  if (tracked.length > BASELINE_MAX_FILES) {
    return { state: 'unsupported', reasons: ['view_file_cap_exceeded'] };
  }
  // 只保留本次请求的路径（视图语义 = 同一逻辑路径 + 各自完整配置）。
  const files = options.paths.map((item) => item.replace(/^\.\//, ''));
  const missing = files.filter((file) => !tracked.includes(file));
  if (missing.length > 0) reasons.push('baseline_path_not_tracked');

  // 配置依据：视图内的 biome.json / .biome.json（HEAD 与当前各自的版本）。
  const configPath = ['biome.json', '.biome.json', 'biome.jsonc'].find((name) =>
    tracked.includes(name),
  );
  let configText: string | null = null;
  if (configPath) {
    const show = await git(['show', `${sha}:${configPath}`]);
    if (!show.ok) return { state: 'unsupported', reasons: ['baseline_config_unreadable'] };
    configText = show.stdout;
  } else {
    try {
      const current = fs.readFileSync(path.join(options.workspaceRoot, 'biome.json'), 'utf8');
      configText = current;
    } catch {
      configText = null;
    }
  }
  const configSupport = inspectBiomeConfigSupport(configText);
  if (!configSupport.ok) return { state: 'unsupported', reasons: [configSupport.reason] };

  const baselineRoot = path.join(options.scratchRoot, 'baseline-view');
  const currentRoot = path.join(options.scratchRoot, 'current-view');
  let totalBytes = 0;
  try {
    for (const root of [baselineRoot, currentRoot]) {
      fs.mkdirSync(root, { recursive: true });
      if (configPath) {
        fs.mkdirSync(path.dirname(path.join(root, configPath)), { recursive: true });
        if (configText !== null) fs.writeFileSync(path.join(root, configPath), configText);
      }
    }
    const digestParts: string[] = [];
    for (const file of files) {
      if (!tracked.includes(file)) continue;
      const show = await git(['show', `${sha}:${file}`]);
      if (!show.ok) {
        reasons.push('baseline_blob_unreadable');
        break;
      }
      const currentAbs = path.join(options.workspaceRoot, file);
      let currentText: string;
      try {
        currentText = fs.readFileSync(currentAbs, 'utf8');
      } catch {
        reasons.push('current_file_unreadable');
        break;
      }
      totalBytes += Buffer.byteLength(show.stdout) + Buffer.byteLength(currentText);
      if (totalBytes > BASELINE_MAX_BYTES) {
        return { state: 'unsupported', reasons: ['view_byte_cap_exceeded'] };
      }
      for (const [root, text] of [
        [baselineRoot, show.stdout],
        [currentRoot, currentText],
      ] as const) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
      digestParts.push(
        `${file}:${factDigest(show.stdout).slice(0, 12)}:${factDigest(currentText).slice(0, 12)}`,
      );
    }
    if (reasons.length > 0) return { state: 'unsupported', reasons };
    return {
      state: 'ok',
      sha,
      baselineRoot,
      currentRoot,
      files,
      configSupport,
      scopeDigest: factDigest(digestParts.join('\n')),
    };
  } catch {
    // 视图不可写（沙箱/权限）→ 明确不支持，不降级成"当前也没问题"。
    return { state: 'unsupported', reasons: ['view_not_writable'] };
  }
}

// ---- 一个工具调用内完成的比较（§7.2） ----

export interface BiomeBaselineComparison {
  comparison: 'compared' | 'unknown';
  current: BiomeRunResult;
  baseline: BiomeRunResult | null;
  diff: DiagnosticDiff | null;
  reasons: string[];
  sha: string | null;
  scopeDigest: string | null;
  processRuns: number;
}

export interface BiomeBaselineDeps extends CheckRunnerDeps {
  /** 视图 scratch 根（测试注入临时目录）。 */
  scratchRoot?: string;
}

export async function runBiomeBaseline(options: {
  context: ToolContext;
  workspaceRoot: string;
  paths: readonly string[];
  timeoutMs: number;
  baseline: boolean;
  deps?: BiomeBaselineDeps;
}): Promise<{ install: BiomeInstall } & Partial<BiomeBaselineComparison>> {
  const install = resolveBiomeInstall(options.workspaceRoot);
  if (!install.ok) return { install };
  const deps = options.deps ?? {};
  const current = await runBiomeLint({
    workspaceRoot: options.workspaceRoot,
    viewRoot: options.workspaceRoot,
    viewDisplay: '.',
    program: install.program,
    files: options.paths,
    timeoutMs: options.timeoutMs,
    context: options.context,
    deps,
  });
  if (!options.baseline) {
    return {
      install,
      comparison: 'unknown',
      current,
      baseline: null,
      diff: null,
      reasons: ['baseline_not_requested'],
      sha: null,
      scopeDigest: null,
      processRuns: current.processRuns,
    };
  }
  const scratchRoot = deps.scratchRoot;
  if (!scratchRoot) {
    return {
      install,
      comparison: 'unknown',
      current,
      baseline: null,
      diff: null,
      reasons: ['baseline_scratch_unavailable'],
      sha: null,
      scopeDigest: null,
      processRuns: current.processRuns,
    };
  }
  const views = await buildHeadViews({
    workspaceRoot: options.workspaceRoot,
    scratchRoot,
    paths: options.paths,
    timeoutMs: options.timeoutMs,
    context: options.context,
    deps,
  });
  if (views.state !== 'ok') {
    return {
      install,
      comparison: 'unknown',
      current,
      baseline: null,
      diff: null,
      reasons: views.reasons,
      sha: null,
      scopeDigest: null,
      processRuns: current.processRuns,
    };
  }
  const baseline = await runBiomeLint({
    workspaceRoot: options.workspaceRoot,
    viewRoot: views.baselineRoot,
    viewDisplay: 'baseline-view',
    program: install.program,
    files: views.files,
    timeoutMs: options.timeoutMs,
    context: options.context,
    deps,
  });
  const processRuns = current.processRuns + baseline.processRuns;
  if (!current.reportComplete || !baseline.reportComplete) {
    return {
      install,
      comparison: 'unknown',
      current,
      baseline,
      diff: null,
      reasons: ['report_incomplete', ...current.reasons, ...baseline.reasons],
      sha: views.sha,
      scopeDigest: views.scopeDigest,
      processRuns,
    };
  }
  return {
    install,
    comparison: 'compared',
    current,
    baseline,
    diff: compareDiagnosticMultisets(current.diagnostics, baseline.diagnostics),
    reasons: [],
    sha: views.sha,
    scopeDigest: views.scopeDigest,
    processRuns,
  };
}

/** 组装 biome-lint 的 facts（诊断+结论，供 Runtime 校验/比较/复用）。 */
export function biomeFacts(result: BiomeRunResult): ToolFacts {
  return {
    version: EXECUTION_EVIDENCE_VERSION,
    check: {
      profile: 'biome-lint',
      conclusion: result.conclusion,
      diagnostics: result.diagnostics.slice(0, 128),
      reportComplete: result.reportComplete,
    },
  };
}

/** 模型可见文本（JSON 摘要 + 有界诊断列表）。 */
export function describeBiomeComparison(input: {
  paths: readonly string[];
  comparison: BiomeBaselineComparison;
  install: BiomeInstall;
}): string {
  const { comparison, install } = input;
  const current = comparison.current;
  const payload: Record<string, unknown> = {
    tool: 'check',
    version: 1,
    profile: 'biome-lint',
    paths: input.paths,
    toolVersion: install.ok ? install.version : null,
    conclusion:
      comparison.comparison === 'unknown' && current.reportComplete === false
        ? 'inconclusive'
        : current.conclusion,
    comparison: comparison.comparison,
    reportComplete: current.reportComplete,
    current: {
      errors: current.diagnostics.filter((d) => d.severity === 'error').length,
      warnings: current.diagnostics.filter((d) => d.severity === 'warning').length,
      diagnostics: current.diagnostics.length,
    },
    reasons: comparison.reasons,
    sha: comparison.sha,
    baseline: comparison.baseline
      ? {
          conclusion: comparison.baseline.conclusion,
          diagnostics: comparison.baseline.diagnostics.length,
        }
      : null,
    introduced: comparison.diff?.introduced.length ?? null,
    resolved: comparison.diff?.resolved.length ?? null,
    unchanged: comparison.diff?.unchanged ?? null,
    introducedDiagnostics: (comparison.diff?.introduced ?? []).slice(0, 8).map(describeDiagnostic),
    resolvedDiagnostics: (comparison.diff?.resolved ?? []).slice(0, 8).map(describeDiagnostic),
    note:
      'comparison=unknown 时不能据此认为"没有新增问题"；报告不完整时结论为 inconclusive。' +
      '不要把同一失败路径换成别的命令反复尝试。',
  };
  return `${JSON.stringify(payload)}\n`;
}

function describeDiagnostic(item: Diagnostic): Record<string, string> {
  return {
    path: item.path,
    rule: item.rule,
    severity: item.severity,
    message: item.message.slice(0, 200),
  };
}

/** 采集上限（与 check 共用 8MiB 日志上限，避免两套预算）。 */
export const BIOME_LOG_CAPTURE_MAX_BYTES = CHECK_LOG_CAPTURE_MAX_BYTES;
