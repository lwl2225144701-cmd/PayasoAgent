// SWE-bench Verified 评测 runner（P1）。
// 用法:
//   tsx tests/swebench/run.ts --lock            # 拉取 + 锁定数据集（首次/换版本）
//   tsx tests/swebench/run.ts --check-list      # 校验 repo 内 50 题清单与抽样算法一致
//   tsx tests/swebench/run.ts --regen-list      # 重新生成 50 题清单
//   tsx tests/swebench/run.ts --dry-run         # 不调模型：验证 clone/捕获/policy/apply/决策/产物
//   tsx tests/swebench/run.ts --pilot           # 跑预定的 5 题（真实 agent）
//   tsx tests/swebench/run.ts                   # 跑 50 题（真实 agent）
// 产物目录 docs/swebench/<UTC>/（已 gitignore）；判分侧命令见方案 §6 P2。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySecretStore } from '../../src/host/secrets/secret-store.js';
import { RunManager } from '../../src/host/run-manager.js';
import { SqliteRunStore } from '../../src/host/persistence/sqlite-store.js';
import { setNetworkMode } from '../../src/network-mode.js';
import { clearWorkspace, setWorkspace } from '../../src/host/workspace.js';
import { loadCheckpoint } from '../../src/persistence/file-checkpoint-store.js';
import {
  CACHE_DIR,
  fetchVerifiedDataset,
  loadLockedDataset,
  lockDataset,
  type SwebenchInstance,
} from './dataset.js';
import { pilotFromSelection, stratifiedSample } from './sampling.js';
import { detectTestPollution, matchTestPath, parseChangedPaths } from './policy.js';
import { decideSubmission, type SubmissionStatus } from './decision.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST_FILE = path.join(HERE, 'instances.sprint1.json');
const SELECTION_SIZE = 50;
const PILOT_SIZE = 5;
const OUTPUT_ROOT = path.resolve('docs/swebench');
/** mtime 静默窗口（辅助检查）：窗口内无新写入才认为写入已停止。 */
const QUIET_WINDOW_MS = 3_000;
/** repo 级 clone 缓存：50 题只跨 ~10 个 repo，逐题 clone 浪费约 10 倍时间。 */
const REPO_CACHE = path.join(CACHE_DIR, 'repos');

type InstanceStatus = SubmissionStatus | 'timeout' | 'budget_exceeded';

interface InstanceResult {
  instance_id: string;
  status: InstanceStatus;
  durationMs: number;
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

function cacheRepoDir(repo: string): string {
  return path.join(REPO_CACHE, repo.replaceAll('/', '__'));
}

/** 确保 repo 全量 clone 在缓存里（全量 clone 含所有历史 commit，无需再 fetch）。 */
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

/** mtime 静默窗口（辅助检查；权威信号是执行 Promise 已结束）。 */
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

/** 捕获 patch 与改动路径。 */
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

/**
 * dry-run 自检：用合成编辑把 §5.4 判定链完整烧一遍（不调模型）。
 * A) 改源码 → 期望 ok；B) 改测试文件 → 期望 policy_invalid。
 */
function selfTestDecisionChain(workDir: string, baseCommit: string): Record<string, 'pass' | 'fail'> {
  const out: Record<string, 'pass' | 'fail'> = {};
  const tracked = git(workDir, ['ls-files'])
    .split('\n')
    .filter((line) => line.trim().length > 0);
  // 目标文件按 policy v1 声称的模式挑选（测契约，不测假设）：源码场景取「非测试的 .py」，
  // 污染场景取「matchTestPath 命中」。粗 glob（*test*.py）会误伤 latest.py 这类文件名，
  // 而 run_astropy_tests.py 这类漏网之鱼属已知边界（A2 只覆盖已知模式，靠人工复核兜底）。
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

/** worktree 目录反查其缓存 repo（applyCheck 需要在缓存 repo 上挂干净 worktree）。 */
function cacheRepoDirOf(workDir: string): string {
  const gitdir = fs.readFileSync(path.join(workDir, '.git'), 'utf8');
  const match = /gitdir:\s*(.+)\/\.git\/worktrees\//.exec(gitdir);
  if (match) return match[1];
  // 普通 clone（非 worktree）时 .git 是目录
  return workDir;
}

function writeArtifacts(
  runDir: string,
  instance: SwebenchInstance,
  taskText: string,
  patch: string,
  faults: string[],
): void {
  const instanceDir = path.join(runDir, instance.instance_id);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, 'task.md'), taskText);
  // 档案求真：原始 patch 一律落档（哪怕被判无效/违规）
  if (patch) fs.writeFileSync(path.join(instanceDir, 'patch.diff'), patch);
  if (faults.length) fs.writeFileSync(path.join(instanceDir, 'faults.json'), JSON.stringify(faults, null, 2));
}

function tally(results: InstanceResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

function safeGit(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function sourceHash(): string {
  const hash = createHash('sha256');
  for (const file of ['run.ts', 'dataset.ts', 'sampling.ts', 'policy.ts', 'decision.ts']) {
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
    if (!fs.existsSync(LIST_FILE)) {
      console.error(`清单不存在: ${LIST_FILE}（用 --regen-list 生成）`);
      process.exit(1);
    }
    const committed = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) as { ids: string[] };
    const expected = sampled.selected.map((i) => i.instance_id);
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

  // pilot 从 50 题清单预取（防 cherry-pick：先于任何结果确定）
  const listIds = (JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) as { ids: string[] }).ids;
  const byId = new Map(dataset.instances.map((i) => [i.instance_id, i]));
  const ordered = listIds.map((id) => byId.get(id)!);
  let targets: SwebenchInstance[] = arg('--pilot') ? pilotFromSelection(ordered, PILOT_SIZE) : ordered;
  const instanceCap = Number(argValue('--limit'));
  if (Number.isFinite(instanceCap) && instanceCap > 0) targets = targets.slice(0, instanceCap);

  const dryRun = arg('--dry-run');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OUTPUT_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // ---- Preflight（方案 D6）：消除审批触发条件，缺一不可启动 ----
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
  if (preflightFaults.length) {
    console.error(`preflight 失败，拒绝启动:\n${preflightFaults.join('\n')}`);
    process.exit(1);
  }
  if (!dryRun) setNetworkMode('on'); // 显式接线（D6：弃 CLI 后不沿用隐式状态）

  const store = new SqliteRunStore(':memory:', new MemorySecretStore());
  const manager = new RunManager(store);
  const results: InstanceResult[] = [];
  const predsLines: string[] = [];

  for (const instance of targets) {
    console.log(`\n=== ${instance.instance_id}（${dryRun ? 'dry-run' : 'live'}）===`);
    const startedAt = Date.now();
    const instanceFaults: string[] = [];
    const workDir = path.join(runDir, 'work', instance.instance_id);
    fs.mkdirSync(path.dirname(workDir), { recursive: true });
    const cacheRepo = cacheRepoDir(instance.repo);

    // 1) repo 缓存 + worktree 到 base_commit
    try {
      ensureRepoCache(instance.repo);
      git(cacheRepo, ['worktree', 'add', '--detach', '--quiet', workDir, instance.base_commit]);
    } catch (err) {
      instanceFaults.push(`clone/checkout 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2) task 包装：problem_statement + 一行约束
    const taskText =
      `${instance.problem_statement}\n\n` +
      '[约束] 只修改源代码，不要修改或新增测试文件（tests/、conftest.py、pytest 配置等）。';

    let patch = '';
    let agentRunId: string | undefined;
    let agentPromise: Promise<unknown> | undefined;

    if (!instanceFaults.length && !dryRun) {
      // 3) 真实执行：setWorkspace + RunManager（方案 D2）
      setWorkspace(workDir);
      try {
        const created = manager.createInSession(taskText, undefined, {
          permissionMode: 'workspace-write',
          attachments: [],
        });
        agentRunId = created.runId;
        // 执行 Promise 捕获（权威 settle 信号；checkpoint 在 tool_result 时也保存，不能作判据）
        agentPromise = manager.runExecution(agentRunId);
        // 无人值守审批：出现即自动驳回（方案 D6，不等 60s）
        const approvalWatch = setInterval(() => {
          for (const { event } of store.listEvents(agentRunId!)) {
            if (event.type === 'approval_requested') {
              manager.resolveApproval(agentRunId!, event.requestId, false);
              instanceFaults.push('runner_fault: approval_requested 已自动驳回');
            }
            if (event.type === 'toolchain_preparation_requested') {
              manager.resolveToolchainPreparation(agentRunId!, event.requestId, false);
              instanceFaults.push('runner_fault: toolchain_preparation_requested 已自动驳回');
            }
          }
        }, 2_000);
        try {
          // 4a) 等终态事件
          const terminalDeadline = Date.now() + 60 * 60_000;
          for (;;) {
            const events = store.listEvents(agentRunId).map(({ event }) => event);
            if (events.some((e) => ['run_completed', 'run_failed', 'run_stopped'].includes(e.type))) break;
            if (Date.now() > terminalDeadline) {
              instanceFaults.push('runner_fault: 等待终态事件超时');
              break;
            }
            await new Promise((r) => setTimeout(r, 1_000));
          }
        } finally {
          clearInterval(approvalWatch);
        }
        // 4b) 执行 Promise 真正结束
        if (agentPromise) {
          await Promise.race([
            agentPromise.catch(() => undefined),
            new Promise((_, reject) => setTimeout(() => reject(new Error('agentPromise settle 等待超时')), 5 * 60_000)),
          ]).catch((err) => instanceFaults.push(`runner_fault: ${err instanceof Error ? err.message : String(err)}`));
        }
      } catch (err) {
        instanceFaults.push(`agent 执行失败: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearWorkspace();
      }
    }

    let status: InstanceStatus = 'empty_patch';
    let approvedPatch = false;
    let changedPaths: string[] = [];
    const policyHits: Array<{ file: string; rule: string }> = [];

    const fatalClone = instanceFaults.some((f) => f.startsWith('clone/checkout'));
    if (fatalClone) {
      status = 'runner_fault';
    } else {
      // 4c) 写入已停止验收：mtime 静默窗口（辅助；权威信号是 agentPromise 已结束）
      if (!dryRun && agentRunId) {
        const quiet = await waitQuiet(workDir);
        if (!quiet) instanceFaults.push('runner_fault: mtime 静默窗口未满足');
      }
      try {
        ({ patch, changedPaths } = capturePatch(workDir, instance.base_commit));
      } catch (err) {
        instanceFaults.push(`diff 捕获失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 5) policy 判定（A2：diff 触及路径；test_patch 路径由数据集推导——v1 先模式匹配）
      const policy = detectTestPollution(changedPaths, []);
      policyHits.push(...policy.hits);
      // 6) 提交决策（§5.4 唯一优先级）
      const runnerFaults = instanceFaults.filter((f) => f.startsWith('runner_fault') || f.startsWith('diff 捕获'));
      const apply = patch.trim() ? applyCheck(cacheRepo, instance.base_commit, patch) : { ok: false };
      const decision = decideSubmission({
        runnerFaults: fatalClone ? ['clone 失败'] : runnerFaults,
        patch,
        policy,
        applyOk: apply.ok,
      });
      status = decision.status;
      approvedPatch = decision.approvedPatch;
      if (status === 'patch_invalid') instanceFaults.push(`apply --check 失败: ${apply.error ?? ''}`);
    }

    // 7) dry-run 自检：合成编辑烧一遍判定链
    let selfTest: Record<string, 'pass' | 'fail'> | undefined;
    if (dryRun && !fatalClone) {
      selfTest = selfTestDecisionChain(workDir, instance.base_commit);
      console.log(`自检: ${JSON.stringify(selfTest)}`);
    }

    // 8) 落档（档案求真）+ predictions（提交求净：无效/违规 → 空 patch）
    writeArtifacts(runDir, instance, taskText, patch, instanceFaults);
    predsLines.push(
      JSON.stringify({
        instance_id: instance.instance_id,
        model_name_or_path: argValue('--model-name') ?? 'step-5-preview',
        model_patch: approvedPatch ? patch : '',
      }),
    );
    results.push({
      instance_id: instance.instance_id,
      status,
      durationMs: Date.now() - startedAt,
      policyHits,
      patchBytes: Buffer.byteLength(patch, 'utf8'),
      changedPaths,
      approvedPatch,
      faults: instanceFaults,
      ...(selfTest ? { selfTest } : {}),
    });

    if (agentRunId) {
      const checkpoint = loadCheckpoint(agentRunId);
      if (checkpoint) {
        fs.writeFileSync(
          path.join(runDir, instance.instance_id, 'transcript.json'),
          JSON.stringify({ messages: checkpoint.messages, iteration: checkpoint.iteration }, null, 2),
        );
      }
    }
    if (fs.existsSync(workDir)) removeWorktree(cacheRepo, workDir);
  }

  await manager.close();

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
        dataset: { revision: dataset.revision, sha256: dataset.sha256, cacheDir: CACHE_DIR },
        selection: { algorithm: 'stratified-largest-remainder', size: SELECTION_SIZE, listSha256: listHash },
        modelName: argValue('--model-name') ?? 'step-5-preview',
        source: { git: safeGit('rev-parse', 'HEAD'), sourceSha: sourceHash() },
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
  if (!dryRun) console.log('判分命令见方案 §6 P2（注意：每次改 predictions 必须换新 grading run_id）');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
