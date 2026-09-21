// 12 个固定真实任务的基线执行器。顺序运行、隔离工作区、逐题保存，失败不中断其他题。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, snapshot, type BaselineCase } from './evaluate.js';
import { deriveRunStats } from '../../src/host/run-stats.js';
import { isValidTokenUsage } from '../../src/llm/token-usage.js';
import type { HostEvent } from '../../src/host/run-events.js';
import { benchmarkModelConfig, publicModelConfig } from './model-config.js';
const project = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const variantTrack = process.env.BASELINE_VARIANTS === '1';
const casePath = path.join(project, variantTrack ? 'tests/baseline/variants.json' : 'tests/baseline/cases.json');
const allCases: BaselineCase[] = JSON.parse(fs.readFileSync(casePath, 'utf8'));
const expectedCount = variantTrack ? 8 : 12;
if (allCases.length !== expectedCount || new Set(allCases.map(test => test.id)).size !== expectedCount) throw Error('Unexpected fixed case set');
const selected = process.env.BASELINE_CASES?.split(',').filter(Boolean);
if (selected?.some(id => !allCases.some(test => test.id === id))) throw Error('Unknown baseline case');
// 空字符串（未显式指定）视为全部用例：空数组是 truthy，不能当成“选了 0 题”。
const cases = selected?.length ? allCases.filter(test => selected.includes(test.id)) : allCases;
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(project, 'docs/baseline', timestamp);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-baseline-'));
fs.mkdirSync(output, { recursive: true });
process.env.PAYASO_HOME = path.join(temporary, 'home');
process.env.PAYASO_DB_PATH = path.join(temporary, 'store.db');
process.env.SANDBOX_ROOT = path.join(temporary, 'sandbox');
const { RunManager } = await import('../../src/host/run-manager.js');
const { createDefaultRunStore } = await import('../../src/host/persistence/sqlite-store.js');
const { MemorySecretStore } = await import('../../src/host/secrets/secret-store.js');
const { setWorkspace, clearWorkspace } = await import('../../src/host/workspace.js');
const modelConfig = benchmarkModelConfig();
const manager = new RunManager(createDefaultRunStore(new MemorySecretStore()));
const selectedModel = manager.importEnvModelProvider(modelConfig);
if (!selectedModel) throw new Error('无法把评测模型配置导入隔离 Provider');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sources = snapshot(path.join(project, 'src'));
const manifest = {
  startedAt: new Date().toISOString(), model: modelConfig.model,
  modelConfig: publicModelConfig(modelConfig),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim(),
  sourceHash: hash(JSON.stringify(Object.entries(sources).sort())),
  runnerHash: hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
  evaluatorHash: hash(fs.readFileSync(path.join(project, 'tests/baseline/evaluate.ts'), 'utf8')),
  casesHash: hash(fs.readFileSync(casePath, 'utf8')), lockHash: hash(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8')),
  selectedCases: cases.map(test => test.id),
  track: variantTrack ? 'variants' : 'original', finalReview: process.env.PAYASO_FINAL_REVIEW === '1',
  tokenBudgetPerCase: 1000000,
  concurrency: 1, permissionMode: 'workspace-write', timeoutPerTurnMs: 180000,
  note: '每题一次；多轮题计入全部轮次。未设置 temperature 或 seed，采用当前应用默认值。仅使用合成资料。',
};
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`BASELINE_OUTPUT ${output}`);
const results: Record<string, unknown>[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (const test of cases) {
    const directory = path.join(output, test.id);
    const workspace = path.join(temporary, test.id);
    fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(directory);
    for (const [name, content] of Object.entries(test.files)) {
      fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
      fs.writeFileSync(path.join(workspace, name), content);
    }
    setWorkspace(workspace);
    const events: HostEvent[] = [];
    const failures: string[] = [];
    const turns: unknown[] = [];
    let sessionId: string | undefined;
    let answer = '';
    let previous: Record<string, string> | undefined;
    const started = Date.now();
    try {
      for (const [index, task] of test.turns.entries()) {
        previous = index > 0 ? snapshot(workspace) : undefined;
        const created = manager.createInSession(task, sessionId, {
          permissionMode: 'workspace-write',
          providerId: selectedModel.providerId,
          model: selectedModel.modelId,
        });
        sessionId = created.sessionId;
        const deadline = Date.now() + manifest.timeoutPerTurnMs;
        let run = manager.get(created.runId)!;
        while (run.status === 'running' || run.status === 'stopping') {
          const usedTokens = [...events, ...(manager.listRunEvents(created.runId) ?? [])]
            .filter(event => event.type === 'llm_call').reduce((sum, event) => sum + (event.usage?.totalTokens ?? 0), 0);
          if (Date.now() >= deadline || usedTokens > manifest.tokenBudgetPerCase) {
            manager.stop(created.runId); failures.push(`第 ${index + 1} 轮${usedTokens > manifest.tokenBudgetPerCase ? '超出 token 预算' : '超时'}`);
            for (let j = 0; j < 50; j++) { await pause(200); run = manager.get(created.runId)!; if (!['running', 'stopping'].includes(run.status)) break; }
            break;
          }
          await pause(500); run = manager.get(created.runId)!;
        }
        const trace = manager.listRunEvents(created.runId) ?? [];
        events.push(...trace);
        answer = run.result ?? '';
        turns.push({ runId: run.runId, status: run.status, task, result: answer, error: run.error, model: run.model });
        fs.writeFileSync(path.join(directory, `turn-${index + 1}.json`), JSON.stringify({ run, events: trace }, null, 2));
        const turnFiles = snapshot(workspace);
        fs.writeFileSync(path.join(directory, `files-${index + 1}.json`), JSON.stringify(turnFiles, null, 2));
        failures.push(...evaluate({ ...test, checks: index === 0 && test.turns.length > 1 ? test.initialChecks ?? [] : [] }, turnFiles, answer).map(failure => `第 ${index + 1} 轮：${failure}`));
        if (run.status !== 'completed') { failures.push(`第 ${index + 1} 轮未完成：${run.status}`); break; }
      }
    } catch (error) { failures.push(`执行异常：${(error as Error).message}`); }
    const files = snapshot(workspace);
    failures.push(...evaluate(test, files, answer, previous));
    const stats = deriveRunStats(events);
    const calls = events.filter(event => event.type === 'llm_call');
    const valid = calls.filter(event => isValidTokenUsage(event.usage));
    const totals = valid.reduce((sum, event) => ({ input: sum.input + event.usage!.inputTokens, output: sum.output + event.usage!.outputTokens, cacheRead: sum.cacheRead + (event.usage!.cacheReadTokens ?? 0), cacheWrite: sum.cacheWrite + (event.usage!.cacheWriteTokens ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const record = {
      id: test.id, category: test.category, title: test.title,
      automatic: failures.length ? 'FAIL' : 'PASS', manual: '待复核', failures,
      durationMs: Date.now() - started, llmCalls: stats.llmCalls, toolCalls: stats.toolCalls, toolMs: stats.toolMs,
      tokenCoverage: `${valid.length}/${calls.length}`, tokens: valid.length ? totals : null,
      reviewCalls: calls.filter(event => event.purpose === 'final_review').length,
      models: [...new Set(events.filter(event => event.type === 'context_usage').map(event => event.model))],
      reviewCriteria: test.review, turns,
    };
    results.push(record);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(record, null, 2));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`BASELINE ${test.id} ${record.automatic} ${Math.round(record.durationMs / 1000)}s tools=${record.toolCalls} ${failures.join('; ')}`);
    if (process.env.BASELINE_STOP_ON_PROVIDER_ERROR === '1' && turns.some(turn => /429|401|402|403/.test((turn as { error?: string }).error ?? ''))) break;
  }
} finally { clearWorkspace(); await manager.close(); }
console.log(`BASELINE_DONE ${results.length}/${cases.length} ${output}`);
