// SWE-bench Verified 评测 runner（PayasoAgent 外挂版）——零 agent 源码依赖。
//
// 与 tests/swebench/run.ts 的区别：不再 in-process 构造 RunManager，而是**逐题把
// PayasoAgent 的 CLI 当子进程拉起**，在克隆的实例仓库里跑，进程退出即权威的「agent 已
// 停止」信号（比 HTTP/Promise settle 更干净），再抓 git diff 走 policy/apply/决策链。
//
// 用法（先在仓库根准备 eval/.env，见 eval/.env.example）：
//   tsx --env-file=eval/.env eval/run.ts --lock          # 拉取 + 锁定数据集（首次）
//   tsx --env-file=eval/.env eval/run.ts --check-list    # 校验 50 题清单与抽样一致
//   tsx --env-file=eval/.env eval/run.ts --regen-list    # 重新生成清单
//   tsx eval/run.ts --dry-run --limit 1                  # 不调模型：验 clone/workspace/policy/apply/决策
//   tsx --env-file=eval/.env eval/run.ts --pilot --limit 1  # 真跑第 1 题（agent CLI + step-5-preview）
//   tsx --env-file=eval/.env eval/run.ts                 # 跑 50 题
// 产物 eval/runs/<UTC>/（已 gitignore）；判分侧命令见 docs/plans/swebench-progress.md。
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CACHE_DIR,
  type SwebenchInstance,
  fetchVerifiedDataset,
  loadLockedDataset,
  lockDataset,
  sha256Of,
} from './dataset.js';
import { pilotFromSelection, stratifiedSample } from './sampling.js';
import { detectTestPollution, matchTestPath, parseChangedPaths } from './policy.js';
import { decideSubmission, type SubmissionStatus } from './decision.js';
import { AGENT_CLI, REPO_ROOT, type EvalConfig, loadConfig } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST_FILE = path.join(HERE, 'instances.sprint1.json');
const SELECTION_SIZE = 50;
const PILOT_SIZE = 5;
/** mtime 静默窗口（辅助检查）：进程退出已是权威信号，这只是防异步残留写入的兜底。 */
const QUIET_WINDOW_MS = 3_000;
/** repo 级 clone 缓存：50 题横跨 ~10 repo，逐题 clone 浪费约 10 倍时间。 */
const REPO_CACHE = path.join(CACHE_DIR, 'repos');

type InstanceStatus = SubmissionStatus | 'timeout' | 'budget_exceeded';

interface InstanceResult {
  instance_id: string;
  status: InstanceStatus;
  durationMs: number;
  agentExitCode: number | null;
  agentTimedOut: boolean;
  policyHits: Array<{ file: string; rule: string }>;
  patchBytes: number;
  changedPaths: string[];
  approvedPatch: boolean;
  faults: string[];
  selfTest?: Record<string, 'pass' | 'fail'>;
}

const arg = (flag: string): boolean => process.argv.includes(flag);
const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function safeGit(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function cacheRepoDir(repo: string): string {
  return path.join(REPO_CACHE, repo.replaceAll('/', '__'));
}
function ensureRepoCache(repo: string): void {
  const dir = cacheRepoDir(repo);
  if (fs.existsSync(path.join(dir, '.git'))) return;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '--quiet', `https://github.com/${repo}.git`, dir], {
    stdio: 'ignore',
    timeout: 30 * 60_000,
  });
}
function removeWorktree(cacheRepo: string, workDir: string): void {
  try {
    git(cacheRepo, ['worktree', 'remove', '--force', workDir]);
  } catch {
    /* worktree 注册残留无碍（缓存目录可弃） */
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}
function latestMtimeMs(root: string): number {
  let latest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.lstatSync(full);
        if (stat.mtimeMs > latest) latest = stat.mtimeMs;
        if (entry.isDirectory()) walk(full);
      } catch {
        /* 文件瞬时消失：忽略 */
      }
    }
  };
  walk(root);
  return latest;
}
/** 辅助静默窗口（权威信号是 agent 进程已退出）。 */
async function waitQuiet(root: string, quietMs = QUIET_WINDOW_MS): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  let baseline = latestMtimeMs(root);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = latestMtimeMs(root);
    if (now > baseline) {
      baseline = now;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= quietMs) return true;
  }
  return false;
}
/** 干净 checkout 上 git apply --check 预检。 */
function applyCheck(cacheRepo: string, baseCommit: string, patch: string): { ok: boolean; error?: string } {
  const clean = fs.mkdtempSync(path.join(path.dirname(REPO_CACHE), 'applycheck-'));
  try {
    git(cacheRepo, ['worktree', 'add', '--detach', clean, baseCommit]);
    fs.writeFileSync(path.join(clean, '.candidate.patch'), patch);
    try {
      execFileSync('git', ['apply', '--check', '.candidate.patch'], { cwd: clean, encoding: 'utf8' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    git(cacheRepo, ['worktree', 'remove', '--force', clean]).trim();
    fs.rmSync(clean, { recursive: true, force: true });
  }
}
function capturePatch(workDir: string, baseCommit: string): { patch: string; changedPaths: string[] } {
  git(workDir, ['add', '-A']);
  const patch = git(workDir, ['diff', '--cached', '--binary', '--full-index', baseCommit, '--', '.']);
  const changedPaths = parseChangedPaths(git(workDir, ['diff', '--cached', '--name-only', baseCommit]));
  return { patch, changedPaths };
}
function resetWorkdir(workDir: string): void {
  git(workDir, ['reset', '--hard', '--quiet']);
  git(workDir, ['clean', '-fd']);
}
function cacheRepoDirOf(workDir: string): string {
  const gitdir = fs.readFileSync(path.join(workDir, '.git'), 'utf8');
  const match = /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(gitdir);
  if (match) return match[1];
  return workDir;
}

interface AgentRunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  logFile: string;
}

/**
 * 逐题驱动 agent CLI：node --import tsx --env-file <eval/.env> src/cli.ts
 * --workspace <worktree> --permission-mode ... --network-mode on --run-id <id> "<task>"。
 * - cwd 固定 REPO_ROOT：保证 tsx 从 agent 仓库的 node_modules 解析（克隆的实例仓库没有依赖）。
 * - PAYASO_HOME 隔离：checkpoint / sandbox scratch / 凭证全落 eval/.ai-home，不污染本机数据。
 * - 进程退出即权威「agent 已停止」信号；timeout 强杀（SIGTERM→SIGKILL）。
 */
async function runAgentCli(
  cfg: EvalConfig,
  opts: { workDir: string; instanceId: string; taskText: string; logFile: string },
): Promise<AgentRunOutcome> {
  const argv = [
    '--import',
    'tsx',
    '--env-file',
    cfg.envFile,
    AGENT_CLI,
    '--workspace',
    opts.workDir,
    '--permission-mode',
    cfg.permissionMode,
    '--network-mode',
    cfg.networkMode,
    '--run-id',
    opts.instanceId,
    opts.taskText,
  ];
  const child = spawn(process.execPath, argv, {
    cwd: REPO_ROOT,
    env: { ...process.env, PAYASO_HOME: cfg.aiHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logStream = fs.createWriteStream(opts.logFile, { flags: 'w' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }, cfg.instanceTimeoutMs);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(killTimer);
  await new Promise<void>((r) => logStream.end(() => r()));
  return { exitCode: exit.code, signal: exit.signal, timedOut, logFile: opts.logFile };
}

/** 模型端点探活（方案 §6 preflight 要求但旧 run.ts 漏做）：一次最小 chat completion。 */
async function probeModel(cfg: EvalConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${cfg.modelBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.modelApiKey}` },
      body: JSON.stringify({ model: cfg.modelName, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `鉴权失败 HTTP ${res.status}` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `网络错误: ${(err as Error).message}` };
  }
}

/** dry-run 自检：用合成编辑把 §5.4 判定链完整烧一遍（不调模型）。 */
function selfTestDecisionChain(workDir: string, baseCommit: string): Record<string, 'pass' | 'fail'> {
  const out: Record<string, 'pass' | 'fail'> = {};
  const tracked = git(workDir, ['ls-files'])
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const sourceTarget = tracked.find((f) => f.endsWith('.py') && !matchTestPath(f));
  const testTarget = tracked.find((f) => matchTestPath(f));
  const scenario = (target: string | undefined, expected: 'ok' | 'policy_invalid'): void => {
    if (!target) {
      out[`${expected}(无目标文件)`] = 'fail';
      return;
    }
    fs.appendFileSync(path.join(workDir, target), '\n# swebench self-test synthetic edit\n');
    const { patch, changedPaths } = capturePatch(workDir, baseCommit);
    const policy = detectTestPollution(changedPaths, []);
    const apply = patch.trim() ? applyCheck(cacheRepoDirOf(workDir), baseCommit, patch) : { ok: false };
    const decision = decideSubmission({ runnerFaults: [], patch, policy, applyOk: apply.ok });
    out[`${expected}(${target})`] = decision.status === expected ? 'pass' : 'fail';
    resetWorkdir(workDir);
  };
  scenario(sourceTarget, 'ok');
  scenario(testTarget, 'policy_invalid');
  return out;
}

function tally(results: InstanceResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

/** eval/ 源码指纹（记录用来自评的版本）。 */
function evalSourceHash(): string {
  const hash = createHash('sha256');
  for (const file of ['run.ts', 'config.ts', 'dataset.ts', 'sampling.ts', 'policy.ts', 'decision.ts']) {
    try {
      hash.update(file);
      hash.update(fs.readFileSync(path.join(HERE, file)));
    } catch {
      /* 缺文件不影响主流程 */
    }
  }
  return hash.digest('hex');
}

async function main(): Promise<void> {
  if (arg('--lock')) {
    const instances = await fetchVerifiedDataset();
    const locked = lockDataset(instances);
    console.log(`已锁定 ${instances.length} 实例 → ${locked.file}`);
    console.log(`revision: ${locked.revision}`);
    console.log(`sha256:   ${locked.sha256}`);
    return;
  }

  const dataset = loadLockedDataset(argValue('--dataset-sha'));
  const sampled = stratifiedSample(dataset.instances, SELECTION_SIZE);
  const listHash = sha256Text(sampled.selected.map((i) => i.instance_id).join('\n'));

  if (arg('--check-list')) {
    const expected = sampled.selected.map((i) => i.instance_id);
    const committed = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) as { ids: string[] };
    const same = JSON.stringify(committed.ids) === JSON.stringify(expected);
    console.log(same ? `清单一致（${expected.length} 题）` : '清单不一致！用 --regen-list 重新生成');
    process.exit(same ? 0 : 1);
  }
  if (arg('--regen-list')) {
    fs.writeFileSync(
      LIST_FILE,
      JSON.stringify(
        {
          size: SELECTION_SIZE,
          datasetSha: dataset.sha256,
          revision: dataset.revision,
          quota: sampled.quota,
          ids: sampled.selected.map((i) => i.instance_id),
          sha256: listHash,
        },
        null,
        2,
      ),
    );
    console.log(`已生成 ${SELECTION_SIZE} 题清单（repo 配额: ${JSON.stringify(sampled.quota)}）`);
    return;
  }

  const cfg = loadConfig();
  const dryRun = arg('--dry-run');
  const listIds = (JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) as { ids: string[] }).ids;
  const byId = new Map(dataset.instances.map((i) => [i.instance_id, i]));
  const ordered = listIds.map((id) => byId.get(id)!);
  let targets: SwebenchInstance[] = arg('--pilot') ? pilotFromSelection(ordered, PILOT_SIZE) : ordered;
  const instanceCap = Number(argValue('--limit'));
  if (Number.isFinite(instanceCap) && instanceCap > 0) targets = targets.slice(0, instanceCap);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(cfg.outputRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(cfg.aiHome, { recursive: true });

  // ---- Preflight（D6 + §6 端点探活）：缺一不可启动 ----
  const preflightFaults: string[] = [];
  for (const [tool, probe] of [
    ['git', ['--version']],
    ['node', ['--version']],
    ['npm', ['--version']],
  ] as const) {
    try {
      execFileSync(tool, probe, { stdio: 'ignore' });
    } catch {
      preflightFaults.push(`${tool} 不可用`);
    }
  }
  if (!fs.existsSync(AGENT_CLI)) preflightFaults.push(`agent CLI 不存在: ${AGENT_CLI}`);
  if (!dryRun) {
    if (!cfg.modelApiKey) preflightFaults.push('OPENAI_API_KEY 未配置（eval/.env）');
    if (!fs.existsSync(cfg.envFile)) preflightFaults.push(`--env-file 不存在: ${cfg.envFile}`);
    if (!preflightFaults.length) {
      const probe = await probeModel(cfg);
      console.log(`模型探活: ${probe.detail}（${cfg.modelName} @ ${cfg.modelBaseUrl}）`);
      if (!probe.ok) preflightFaults.push(`模型端点探活失败: ${probe.detail}`);
    }
  }
  if (preflightFaults.length) {
    console.error(`preflight 失败，拒绝启动:\n${preflightFaults.map((f) => `- ${f}`).join('\n')}`);
    process.exit(1);
  }

  const results: InstanceResult[] = [];
  const predsLines: string[] = [];

  for (const instance of targets) {
    console.log(`\n=== ${instance.instance_id}（${dryRun ? 'dry-run' : 'live'}）===`);
    const startedAt = Date.now();
    const instanceFaults: string[] = [];
    let agentExitCode: number | null = null;
    const workDir = path.join(runDir, 'work', instance.instance_id);
    fs.mkdirSync(path.dirname(workDir), { recursive: true });
    const cacheRepo = cacheRepoDir(instance.repo);

    // 1) repo 缓存 + worktree 到 base_commit
    try {
      ensureRepoCache(instance.repo);
      git(cacheRepo, ['worktree', 'add', '--detach', '--quiet', workDir, instance.base_commit]);
    } catch (err) {
      instanceFaults.push(
        `clone/checkout 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2) task 包装：problem_statement + 一行约束
    const taskText =
      `${instance.problem_statement}\n\n` +
      '[约束] 只修改源代码，不要修改或新增测试文件（tests/、conftest.py、pytest 配置等）。';

    // 3) 真跑：spawn agent CLI（进程退出 = agent 已停止，权威信号）
    const logFile = path.join(runDir, instance.instance_id, 'agent.log');
    if (!instanceFaults.length && !dryRun) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      try {
        const outcome = await runAgentCli(cfg, { workDir, instanceId: instance.instance_id, taskText, logFile });
        agentExitCode = outcome.exitCode;
        if (outcome.timedOut) instanceFaults.push('label:timeout');
        if (outcome.exitCode !== 0) instanceFaults.push(`label:agent_exit_nonzero(${outcome.exitCode ?? outcome.signal})`);
      } catch (err) {
        instanceFaults.push(`runner_fault: agent CLI spawn 失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let status: InstanceStatus = 'empty_patch';
    let approvedPatch = false;
    let changedPaths: string[] = [];
    let patch = '';
    const policyHits: Array<{ file: string; rule: string }> = [];

    const fatalClone = instanceFaults.some((f) => f.startsWith('clone/checkout'));
    if (fatalClone) {
      status = 'runner_fault';
    } else {
      // 4) 写入已停止验收：静默窗口（辅助）；随后捕获 diff；任一 runner_fault 出现即 runner_fault
      if (!dryRun) {
        const quiet = await waitQuiet(workDir);
        if (!quiet) instanceFaults.push('runner_fault: mtime 静默窗口未满足');
      }
      let runnerFault = instanceFaults.some((f) => f.startsWith('runner_fault'));
      if (!runnerFault) {
        try {
          ({ patch, changedPaths } = capturePatch(workDir, instance.base_commit));
        } catch (err) {
          instanceFaults.push(`runner_fault: diff 捕获失败: ${err instanceof Error ? err.message : String(err)}`);
          runnerFault = true;
        }
      }
      if (runnerFault) {
        status = 'runner_fault';
      } else {
        const policy = detectTestPollution(changedPaths, []);
        policyHits.push(...policy.hits);
        const apply = patch.trim() ? applyCheck(cacheRepo, instance.base_commit, patch) : { ok: false };
        const decision = decideSubmission({
          runnerFaults: instanceFaults.filter((f) => f.startsWith('runner_fault')),
          patch,
          policy,
          applyOk: apply.ok,
        });
        status = decision.status;
        approvedPatch = decision.approvedPatch;
        if (status === 'patch_invalid') instanceFaults.push(`apply --check 失败: ${apply.error ?? ''}`);
      }
    }

    // 5) dry-run 自检
    let selfTest: Record<string, 'pass' | 'fail'> | undefined;
    if (dryRun && !fatalClone) {
      selfTest = selfTestDecisionChain(workDir, instance.base_commit);
      console.log(`自检: ${JSON.stringify(selfTest)}`);
    }

    // 6) 落档（档案求真）+ predictions（提交求净）
    const instanceDir = path.join(runDir, instance.instance_id);
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'task.md'), taskText);
    if (patch) fs.writeFileSync(path.join(instanceDir, 'patch.diff'), patch);
    if (instanceFaults.length) fs.writeFileSync(path.join(instanceDir, 'faults.json'), JSON.stringify(instanceFaults, null, 2));
    if (fs.existsSync(logFile)) fs.copyFileSync(logFile, path.join(instanceDir, 'agent.log'));
    predsLines.push(
      JSON.stringify({
        instance_id: instance.instance_id,
        model_name_or_path: cfg.modelName,
        model_patch: approvedPatch ? patch : '',
      }),
    );
    results.push({
      instance_id: instance.instance_id,
      status,
      durationMs: Date.now() - startedAt,
      agentExitCode,
      agentTimedOut: instanceFaults.includes('label:timeout'),
      policyHits,
      patchBytes: Buffer.byteLength(patch, 'utf8'),
      changedPaths,
      approvedPatch,
      faults: instanceFaults,
      ...(selfTest ? { selfTest } : {}),
    });

    if (fs.existsSync(workDir)) removeWorktree(cacheRepo, workDir);
  }

  // ---- 汇总 ----
  fs.writeFileSync(path.join(runDir, 'preds.jsonl'), `${predsLines.join('\n')}${predsLines.length ? '\n' : ''}`);
  fs.writeFileSync(
    path.join(runDir, 'results.json'),
    JSON.stringify({ runId, dryRun, selectionSize: SELECTION_SIZE, datasetRevision: dataset.revision, results }, null, 2),
  );
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        dryRun,
        agentUnderTest: {
          repoRoot: REPO_ROOT,
          cliPath: AGENT_CLI,
          gitCommit: safeGit(REPO_ROOT, 'rev-parse', 'HEAD'),
          gitDirty: safeGit(REPO_ROOT, 'status', '--porcelain') !== 'unknown' ? safeGit(REPO_ROOT, 'status', '--porcelain') !== '' : undefined,
        },
        model: {
          name: cfg.modelName,
          baseUrl: cfg.modelBaseUrl,
          apiKeySha256: cfg.modelApiKey ? sha256Of(cfg.modelApiKey).slice(0, 16) : '',
        },
        dataset: { revision: dataset.revision, sha256: dataset.sha256, cacheDir: CACHE_DIR },
        selection: { algorithm: 'stratified-largest-remainder', size: SELECTION_SIZE, listSha256: listHash },
        config: { instanceTimeoutMs: cfg.instanceTimeoutMs, permissionMode: cfg.permissionMode, networkMode: cfg.networkMode },
        evalSourceSha: evalSourceHash(),
      },
      null,
      2,
    ),
  );
  console.log(`\n完成：${results.length} 实例 → ${runDir}`);
  console.log(`状态分布: ${JSON.stringify(tally(results))}`);
  if (dryRun) {
    const failures = results.flatMap((r) =>
      Object.entries(r.selfTest ?? {})
        .filter(([, v]) => v === 'fail')
        .map(([k]) => `${r.instance_id}:${k}`),
    );
    console.log(failures.length ? `自检失败: ${failures.join('；')}` : '自检全部通过');
    process.exit(failures.length ? 1 : 0);
  }
  console.log('判分命令见 docs/plans/swebench-progress.md（注意：每次改 predictions 必须换新 grading run_id）');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
