// 冻结收尾批次：原题三轮 + 八个变体。保留失败，额度错误停止后续批次。
// 续跑：CLOSURE_DIR=docs/baseline/closure-xxx 可以从上次中断的收尾目录继续，
// 已完成并等待内容复核的批次不重跑；provider_blocked / runner_failed / 中断残留一律重跑，
// 且源码指纹必须一致，否则拒绝混用版本。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BatchRecord, planBatches } from './closure-plan.js';
import { snapshot } from './evaluate.js';
import { benchmarkModelConfig, publicModelConfig } from './model-config.js';

const project = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ALL_BATCHES = ['original-1', 'original-2', 'original-3', 'variants'];
// 父进程加载 .env（仅填补缺失变量）：batch.json 记录真实模型，续跑模型校验才有意义。
{
  const envFile = path.join(project, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/gu, '');
    }
  }
}
const fingerprint = () =>
  createHash('sha256')
    .update(
      JSON.stringify({
        src: snapshot(path.join(project, 'src')),
        tests: snapshot(path.join(project, 'tests/baseline')),
      }),
    )
    .digest('hex');
const frozen = fingerprint();
const modelConfig = benchmarkModelConfig();

const resumeDir = process.env.CLOSURE_DIR?.trim();
let directory: string;
let batches: BatchRecord[];
if (resumeDir) {
  directory = path.resolve(project, resumeDir);
  const file = JSON.parse(fs.readFileSync(path.join(directory, 'batch.json'), 'utf8'));
  const plan = planBatches(file, frozen, modelConfig.configFingerprint, ALL_BATCHES);
  if (plan.kind !== 'resume') throw new Error(`收尾目录没有可续跑的批次记录: ${resumeDir}`);
  batches = plan.keep.map((r) => ({ name: r.name, output: r.output, status: r.status }));
  console.log(`RESUME_CLOSURE ${directory} keep=${batches.length} rerun=${plan.rerun.length}`);
  const skip = new Set(batches.map((b) => b.name));
  for (const name of ALL_BATCHES) if (!skip.has(name)) batches.push({ name, status: 'pending' });
} else {
  directory = path.join(
    project,
    'docs/baseline',
    `closure-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  batches = ALL_BATCHES.map((name) => ({ name, status: 'pending' }));
}

const save = () =>
  fs.writeFileSync(
    path.join(directory, 'batch.json'),
    JSON.stringify(
      {
        sourceHash: frozen,
        model: modelConfig.model,
        configFingerprint: modelConfig.configFingerprint,
        modelConfig: publicModelConfig(modelConfig),
        targetTasks: 44,
        finalReview: true,
        manualReview: 'pending',
        batches,
      },
      null,
      2,
    ),
  );
save();

for (const entry of batches) {
  if (entry.status === 'awaiting_content_review' || entry.status === 'content_reviewed') {
    console.log(`${entry.name}: 已等待内容复核，跳过`);
    continue;
  }
  if (fingerprint() !== frozen) throw Error('源码或验收样例变化，停止混用候选版本');
  entry.status = 'running';
  save();
  const log = fs.createWriteStream(path.join(directory, `${entry.name}.log`));
  let recent = '';
  // 剥掉继承的 BASELINE_CASES：批次用例由 closure 决定，父环境的选择不得影响四批范围。
  const { BASELINE_CASES: _inheritedCases, ...baseEnv } = process.env;
  // 子进程必须自己加载 .env（closure 父进程可能不带模型配置），否则回落默认端点必然 401。
  const child = spawn(process.execPath, ['--env-file=.env', '--import', 'tsx', 'tests/baseline/run.ts'], {
    cwd: project,
    env: {
      ...baseEnv,
      PAYASO_FINAL_REVIEW: '1',
      BASELINE_STOP_ON_PROVIDER_ERROR: '1',
      BASELINE_VARIANTS: entry.name === 'variants' ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    log.write(chunk);
    recent += String(chunk);
    const lines = recent.split('\n');
    recent = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('BASELINE_OUTPUT '))
        entry.output = line.slice('BASELINE_OUTPUT '.length).trim();
      if (line.startsWith('BASELINE')) console.log(`${entry.name}: ${line}`);
    }
  });
  child.stderr.on('data', (chunk) => log.write(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  await new Promise<void>((resolve) => log.end(resolve));
  if (code !== 0 || !entry.output || !fs.existsSync(path.join(entry.output, 'results.json'))) {
    entry.status = 'runner_failed';
    save();
    process.exitCode = 1;
    break;
  }
  const results = JSON.parse(fs.readFileSync(path.join(entry.output, 'results.json'), 'utf8'));
  const blocked = results.some((r: { turns: { error?: string }[] }) =>
    r.turns.some((t) => /429|401|402|403/.test(t.error ?? '')),
  );
  entry.status = blocked ? 'provider_blocked' : 'awaiting_content_review';
  save();
  if (blocked) {
    console.error('Provider 拒绝请求，停止后续批次；不计为质量通过。');
    process.exitCode = 1;
    break;
  }
}
console.log(`CLOSURE_BATCH ${directory}`);
