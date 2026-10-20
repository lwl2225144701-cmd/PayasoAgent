// 套件: Biome 诊断与 HEAD 基线比较（批次 D · 计划 §7 / §11.2 用例 B01-B05）
// 用法: npx tsx tests/check-baseline.test.ts
//
// 验收（确定性、无网络、无真实远端副作用）：
//   B01 基线 3 条、当前同 3 条但行号移动 → 全部 unchanged，不按行号误报新增
//   B02 规则/片段不同 → 按多重集合给出 introduced/resolved，不按条数认定
//   B03 非 JSON（stdin 类失败）/ 缺 summary / 诊断被省略 → inconclusive，comparison=unknown
//   B04 配置含相对 extends / 绝对路径 / npm: 包 → 明确不支持，不静默跑不同配置
//   B05 当前文件变化、基线未变 → current 重跑、baseline 仍用 HEAD 内容；
//        真实工作区不被 checkout/stash/覆盖
//
// 载体：临时工作区里放一个"假 biome"（node 脚本）按 cwd 输出不同 JSON，
// 以及一个真实 git 仓库（HEAD 固定 SHA 由 git rev-parse 得到）。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXECUTION_EVIDENCE_VERSION, validateToolFacts } from '../src/execution-evidence.js';
import { executeCheck } from '../src/tools/check.js';
import {
  BASELINE_MAX_FILES,
  type BiomeRunResult,
  buildHeadViews,
  compareDiagnosticMultisets,
  diagnosticFingerprint,
  inspectBiomeConfigSupport,
  parseBiomeJsonReport,
  resolveBiomeInstall,
  runBiomeBaseline,
} from '../src/tools/check-baseline.js';
import { normalizeToolResult, type ToolContext } from '../src/tools/tools.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-biome-'));
const WORKSPACE = path.join(TEST_ROOT, 'ws');
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.SANDBOX_ROOT = path.join(TEST_ROOT, 'sandbox-root');
process.env.PAYASO_ATTACHMENT_STORE = path.join(TEST_ROOT, 'attachment-store');
process.env.PAYASO_SHELL_UNSANDBOXED = '1';
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;

const DEPS = { platform: 'linux' as NodeJS.Platform };
const CSS_PATH = 'work/a.css';

let passes = 0;
let failures = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failures++;
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${(err as Error).message}`);
  }
}

function context(): ToolContext {
  return {
    runId: `biome-run-${process.pid}`,
    workspaceRoot: WORKSPACE,
    permissionMode: 'workspace-write',
  };
}

// ---- 工作区 + 假 biome + git 仓库 ----

interface FakeDiag {
  rule: string;
  message: string;
  line: number;
  sourceCode?: string;
}

const biomeScript = (currentJson: string, baselineJson: string): string => `#!/usr/bin/env node
const path = require('node:path');
const current = ${JSON.stringify(currentJson)};
const baseline = ${JSON.stringify(baselineJson)};
const isBaselineView = process.cwd().includes('baseline-view');
const payload = isBaselineView ? baseline : current;
process.stdout.write(payload);
if (!payload.startsWith('{"report":')) {
  const parsed = JSON.parse(payload);
  process.exit((parsed.summary && parsed.summary.errors > 0) ? 1 : 0);
}
process.stderr.write('contents aren\\'t fixed\\n');
process.exit(1);
`;

function biomeReport(diagnostics: FakeDiag[]): string {
  const errors = diagnostics.filter((d) => d.rule.startsWith('error/')).length;
  return JSON.stringify({
    command: 'lint',
    summary: {
      changed: 0,
      unchanged: 0,
      duration: 1,
      errors,
      warnings: diagnostics.length - errors,
      skipped: 0,
      suggestedFixes: 0,
      diagnosticsNotPrinted: 0,
    },
    diagnostics: diagnostics.map((item) => ({
      category: item.rule,
      severity: item.rule.startsWith('error/') ? 'error' : 'warning',
      description: item.message,
      message: [{ elements: [], content: item.message }],
      location: {
        path: { file: CSS_PATH },
        span: [item.line, 1],
        sourceCode: item.sourceCode ?? '',
      },
      sourceCode: item.sourceCode ?? 'a { color: red; }',
      advices: {},
    })),
  });
}

function writeFakeBiome(currentJson: string, baselineJson: string = currentJson): void {
  const pkgDir = path.join(WORKSPACE, 'node_modules/@biomejs/biome');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@biomejs/biome', version: '1.9.4' }),
  );
  const bin = path.join(pkgDir, 'bin/biome');
  fs.writeFileSync(bin, biomeScript(currentJson, baselineJson));
  fs.chmodSync(bin, 0o755);
}

function writeWorkspaceFile(relative: string, content: string): void {
  const abs = path.join(WORKSPACE, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', WORKSPACE, ...args], { encoding: 'utf8' });
}

function commitAll(message: string): string {
  execFileSync('git', ['-C', WORKSPACE, 'add', '-A'], { encoding: 'utf8' });
  execFileSync('git', ['-C', WORKSPACE, 'commit', '-q', '-m', message], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return git(['rev-parse', 'HEAD']).trim();
}

const WARNINGS: FakeDiag[] = [
  { rule: 'lint/suspicious/noDuplicateProperties', message: 'Duplicate property name', line: 3 },
  { rule: 'lint/complexity/noImportantStyles', message: 'Avoid !important', line: 8 },
  { rule: 'lint/style/noJsxLiterals', message: 'Unexpected string literal', line: 12 },
];

async function main(): Promise<void> {
  execFileSync('git', ['-C', WORKSPACE, 'init', '-q'], { encoding: 'utf8' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  writeWorkspaceFile('biome.json', JSON.stringify({ linter: { enabled: true } }));
  writeWorkspaceFile(CSS_PATH, 'a { color: red; }\nb { color: blue; }\n');

  console.log('\n== 纯函数：解析、指纹、多重集合比较 ==');
  await test('B01 行号移动不改变指纹：同 3 条诊断 → unchanged=3、introduced=0', () => {
    const baseline = parseBiomeJsonReport(biomeReport(WARNINGS));
    // 同一批诊断只是行号整体下移（真实场景：上面插了几行代码）。
    const movedReports = WARNINGS.map((item) => ({ ...item, line: item.line + 10 }));
    const current = parseBiomeJsonReport(biomeReport(movedReports));
    assert.equal(baseline.state, 'valid');
    assert.equal(current.state, 'valid');
    if (baseline.state !== 'valid' || current.state !== 'valid') return;
    const diff = compareDiagnosticMultisets(current.diagnostics, baseline.diagnostics);
    assert.equal(diff.introduced.length, 0, '行号移动不是新问题');
    assert.equal(diff.resolved.length, 0);
    assert.equal(diff.unchanged, 3);
  });
  await test('B02 规则不同 → 按多重集合给 introduced/resolved，不按条数', () => {
    const current = parseBiomeJsonReport(
      biomeReport([
        WARNINGS[0],
        WARNINGS[1],
        { rule: 'lint/style/useConst', message: 'Use const', line: 20 },
      ]),
    );
    const baseline = parseBiomeJsonReport(
      biomeReport([
        WARNINGS[0],
        WARNINGS[1],
        { rule: 'lint/a11y/useAltText', message: 'Alt text', line: 30 },
      ]),
    );
    assert.equal(current.state, 'valid');
    assert.equal(baseline.state, 'valid');
    if (current.state !== 'valid' || baseline.state !== 'valid') return;
    const diff = compareDiagnosticMultisets(current.diagnostics, baseline.diagnostics);
    assert.equal(diff.introduced.length, 1, '两侧各 3 条也必须按诊断差异判断');
    assert.equal(diff.resolved.length, 1);
    assert.equal(diff.unchanged, 2);
    assert.equal(diff.introduced[0]?.rule, 'lint/style/useConst');
  });
  await test('B03 stdin 类失败输出（非 JSON）→ invalid，绝不得到 0 诊断', () => {
    const parsed = parseBiomeJsonReport("contents aren't fixed");
    assert.equal(parsed.state, 'invalid');
    if (parsed.state === 'invalid') assert.ok(parsed.reasons.length > 0);
  });
  await test('B03 缺 summary / diagnosticsNotPrinted>0 → 不完整，不可比较', () => {
    const noSummary = parseBiomeJsonReport(JSON.stringify({ command: 'lint', diagnostics: [] }));
    assert.equal(noSummary.state, 'invalid');
    const omitted = parseBiomeJsonReport(
      JSON.stringify({
        command: 'lint',
        summary: { errors: 0, warnings: 1, diagnosticsNotPrinted: 2 },
        diagnostics: [
          {
            category: 'lint/style/useConst',
            severity: 'warning',
            message: [{ content: 'Use const' }],
            location: { path: { file: CSS_PATH }, span: [1, 1] },
            sourceCode: 'a{}',
          },
        ],
      }),
    );
    assert.equal(omitted.state, 'valid');
    if (omitted.state !== 'valid') return;
    assert.equal(omitted.reportComplete, false, '被省略的诊断 → 报告不完整');
  });
  await test('B04 相对 extends / 绝对路径 / npm 包 → 明确不支持', () => {
    assert.deepEqual(inspectBiomeConfigSupport(null), { ok: true });
    assert.equal(inspectBiomeConfigSupport('{"extends":["../shared/biome.json"]}').ok, false);
    assert.equal(inspectBiomeConfigSupport('{"extends":["/etc/biome.json"]}').ok, false);
    assert.equal(inspectBiomeConfigSupport('{"extends":["npm:@scope/preset"]}').ok, false);
    assert.equal(inspectBiomeConfigSupport('{"extends":["./base.json"]}').ok, true);
  });
  await test('B01 指纹不含行号/绝对路径（同一逻辑诊断稳定）', () => {
    const base = {
      path: CSS_PATH,
      rule: 'lint/style/useConst',
      primarySnippet: 'a { color: red; }',
      relatedSnippets: [],
      message: 'Use const',
    };
    const first = diagnosticFingerprint(base);
    assert.equal(first, diagnosticFingerprint({ ...base }));
    assert.notEqual(first, diagnosticFingerprint({ ...base, rule: 'lint/other/rule' }));
    assert.doesNotMatch(first, /[:/\\\s]/, '指纹必须是稳定不透明摘要');
  });

  console.log('\n== 适配器与 HEAD 基线（真实 git 仓库 + 假 biome） ==');
  await test('D0 工作区已安装 biome：入口/版本可解析；版本不支持时明确拒绝', () => {
    writeFakeBiome(biomeReport(WARNINGS));
    const install = resolveBiomeInstall(WORKSPACE);
    assert.equal(install.ok, true);
    if (!install.ok) return;
    assert.equal(install.version, '1.9.4');
    assert.ok(install.program.startsWith(fs.realpathSync(WORKSPACE)), '入口必须在工作区内');
    writeWorkspaceFile(
      'node_modules/@biomejs/biome/package.json',
      JSON.stringify({ name: '@biomejs/biome', version: '2.0.0' }),
    );
    assert.equal(resolveBiomeInstall(WORKSPACE).ok, false, '跨大版本不比较');
    writeFakeBiome(biomeReport(WARNINGS));
  });
  await test('B05 HEAD 视图只读：构建视图不改动真实工作区，当前内容随工作区变化', async () => {
    writeWorkspaceFile(CSS_PATH, 'a { color: red; }\n');
    commitAll('baseline');
    const changed = 'a { color: green; }\n';
    writeWorkspaceFile(CSS_PATH, changed);
    const scratch = fs.mkdtempSync(path.join(TEST_ROOT, 'scratch-'));
    const views = await buildHeadViews({
      workspaceRoot: WORKSPACE,
      scratchRoot: scratch,
      paths: [CSS_PATH],
      timeoutMs: 30_000,
      context: context(),
      deps: DEPS,
    });
    assert.equal(views.state, 'ok', views.state === 'unsupported' ? views.reasons.join(',') : '');
    if (views.state !== 'ok') return;
    assert.match(views.sha, /^[0-9a-f]{40}$/);
    assert.equal(views.sha, git(['rev-parse', 'HEAD']).trim(), 'baseline 用调用开始时的 HEAD');
    assert.equal(
      fs.readFileSync(path.join(views.baselineRoot, CSS_PATH), 'utf8'),
      'a { color: red; }\n',
      'baseline 视图是 HEAD 内容',
    );
    assert.equal(
      fs.readFileSync(path.join(views.currentRoot, CSS_PATH), 'utf8'),
      changed,
      'current 视图是当前内容',
    );
    assert.equal(
      fs.readFileSync(path.join(WORKSPACE, CSS_PATH), 'utf8'),
      changed,
      '真实工作区未被 checkout/stash/覆盖',
    );
    assert.ok(!fs.existsSync(path.join(WORKSPACE, '.git/index.lock')), '不留 git 锁');
    assert.ok(BASELINE_MAX_FILES >= 1);
  });
  await test('B05 baseline/current 各跑一次：当前文件变化检出 introduced，基线仍用 HEAD', async () => {
    // 工作区当前 = 2 条 warning；HEAD = 3 条 warning（其中一条已修好）。
    writeWorkspaceFile(CSS_PATH, 'a { color: red; }\n');
    const baselineJson = biomeReport(WARNINGS);
    const currentJson = biomeReport([
      WARNINGS[0],
      { ...WARNINGS[1], line: 40 },
      { rule: 'lint/style/useConst', message: 'Use const', line: 2 },
    ]);
    writeFakeBiome(currentJson, baselineJson);
    const result = await runBiomeBaseline({
      context: context(),
      workspaceRoot: WORKSPACE,
      paths: [CSS_PATH],
      timeoutMs: 30_000,
      baseline: true,
      deps: { ...DEPS, scratchRoot: fs.mkdtempSync(path.join(TEST_ROOT, 'scratch-')) },
    });
    assert.equal(result.install.ok, true);
    assert.equal(result.comparison, 'compared', (result.reasons ?? []).join(','));
    assert.ok(result.diff, '必须给出多重集合差异');
    assert.equal(result.diff?.introduced.length, 1, '新增 1 条 useConst');
    assert.equal(result.diff?.resolved.length, 1, '基线里 last 一条规则已不出现');
    assert.equal(result.diff?.unchanged, 2);
    assert.equal(result.processRuns, 2, '两个视图各一次进程，不额外重跑');
    assert.equal(result.baseline?.conclusion, 'passed', '基线 3 条 warning、exit 0 → passed');
  });
  await test('B03 报告不可解析 → comparison=unknown、conclusion=inconclusive', async () => {
    writeFakeBiome('{"report":"stdin-failed"}', '{"report":"stdin-failed"}');
    const result = await runBiomeBaseline({
      context: context(),
      workspaceRoot: WORKSPACE,
      paths: [CSS_PATH],
      timeoutMs: 30_000,
      baseline: true,
      deps: { ...DEPS, scratchRoot: fs.mkdtempSync(path.join(TEST_ROOT, 'scratch-')) },
    });
    assert.equal(result.comparison, 'unknown');
    assert.equal(result.diff, null);
    assert.equal(result.current?.conclusion, 'inconclusive');
    assert.ok(result.reasons?.length, '必须给出具体原因');
    writeFakeBiome(biomeReport(WARNINGS));
  });
  await test('B04 视图配置含外部 extends → 明确不支持（不静默跑不同配置）', async () => {
    writeWorkspaceFile('biome.json', JSON.stringify({ extends: ['npm:@preset/biome'] }));
    commitAll('external config');
    const result = await runBiomeBaseline({
      context: context(),
      workspaceRoot: WORKSPACE,
      paths: [CSS_PATH],
      timeoutMs: 30_000,
      baseline: true,
      deps: { ...DEPS, scratchRoot: fs.mkdtempSync(path.join(TEST_ROOT, 'scratch-')) },
    });
    assert.equal(result.comparison, 'unknown');
    assert.ok(
      result.reasons?.includes('biome_config_package_extends'),
      `原因应指出外部配置（实际: ${result.reasons?.join(',')}）`,
    );
    writeWorkspaceFile('biome.json', JSON.stringify({ linter: { enabled: true } }));
  });
  await test('D2 check 工具 biome 分支：真实调用返回 facts（含 reportComplete）', async () => {
    writeWorkspaceFile(CSS_PATH, 'a { color: red; }\n');
    commitAll('tool wiring');
    writeFakeBiome(biomeReport(WARNINGS));
    const result = normalizeToolResult(
      await executeCheck({ profile: 'biome-lint', paths: [CSS_PATH] }, context(), {
        ...DEPS,
        createScratch: () => scratchForTest(),
      }),
    );
    assert.ok(result.facts, 'biome-lint 必须返回结构化 facts');
    const validated = validateToolFacts(result.facts);
    assert.equal(validated.valid, true);
    assert.equal(result.facts?.version, EXECUTION_EVIDENCE_VERSION);
    assert.equal(result.facts?.check?.profile, 'biome-lint');
    assert.equal(result.facts?.check?.conclusion, 'passed');
    assert.equal(result.facts?.check?.diagnostics?.length, 3);
    assert.equal(result.facts?.check?.reportComplete, true);
    assert.match(result.text, /"comparison":"unknown"|"comparison":"compared"/);
  });
  await test('D2 未安装 biome → 明确 inconclusive+reason，不跑程序', async () => {
    fs.rmSync(path.join(WORKSPACE, 'node_modules/@biomejs/biome'), {
      recursive: true,
      force: true,
    });
    const result = normalizeToolResult(
      await executeCheck({ profile: 'biome-lint', paths: [CSS_PATH] }, context(), {
        ...DEPS,
        createScratch: () => scratchForTest(),
      }),
    );
    assert.equal(result.facts?.check?.conclusion, 'inconclusive');
    assert.equal(result.facts?.check?.diagnostics, null);
    assert.match(result.text, /biome_not_installed/);
  });

  console.log('========================================================');
  console.log(`汇总: ${passes} PASS / ${failures} FAIL`);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  if (failures > 0) {
    console.log('验收：Biome 适配/基线比较存在失败用例 ✗');
    process.exit(1);
  }
  console.log('验收：B01-B05 行为与不变量成立（真实 git + 假 biome；未验证真实 Biome 输出）✓');
}

function scratchForTest(): { path: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'scratch-'));
  return { path: dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 供类型检查使用的 runBiomeLint 引用（避免 tree-shake 误判未使用）。 */
type _RunResult = BiomeRunResult;

await main();
