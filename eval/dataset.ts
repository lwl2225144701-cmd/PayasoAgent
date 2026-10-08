// SWE-bench Verified 数据集：拉取 → 锁定 → 读取（外挂版，零 src 依赖）。
//
// 为什么单独存在：评测器作为 PayasoAgent 的"外挂"，不再 import 任何 agent 源码；
// 数据集锁定物（revision + sha256）放 eval/.cache（gitignore），repo 里只放从它抽出的
// 50 题清单（sampling.ts）。判分侧的 gold patch / test_patch 也在这里，绝不进入 agent
// 可见路径（problem_statement / task）。
//
// 与 tests/swebench/dataset.ts 的唯一区别：缓存目录不再走 app-paths（agent 内部模块），
// 改为 EVAL_SWEBENCH_CACHE 覆盖、默认 eval/.cache。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DATASET = 'princeton-nlp/SWE-bench_Verified';
const CONFIG = 'default';
const SPLIT = 'test';
const PAGE = 100;

/** 锁定数据集的本地缓存目录。默认 eval/.cache；沙箱/CI 写不了时用 EVAL_SWEBENCH_CACHE 覆盖。 */
const CACHE_DIR = process.env.EVAL_SWEBENCH_CACHE?.trim()
  ? path.resolve(process.env.EVAL_SWEBENCH_CACHE.trim())
  : path.join(HERE, '.cache');

export interface SwebenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** gold patch——仅判分与审计用 */
  patch: string;
  /** 官方测试补丁——仅判分与 policy 路径推导用 */
  test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  version: string;
}

async function fetchPage(offset: number): Promise<SwebenchInstance[]> {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
    `&config=${CONFIG}&split=${SPLIT}&offset=${offset}&length=${PAGE}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`数据集拉取失败: HTTP ${response.status} (offset=${offset})`);
  const body = (await response.json()) as { rows?: Array<{ row: SwebenchInstance }> };
  return (body.rows ?? []).map((entry) => entry.row);
}

/** 拉取全量实例（分页直至取空）。 */
export async function fetchVerifiedDataset(maxInstances = 500): Promise<SwebenchInstance[]> {
  const all: SwebenchInstance[] = [];
  for (let offset = 0; offset < maxInstances; offset += PAGE) {
    const page = await fetchPage(offset);
    if (!page.length) break;
    all.push(...page);
    if (page.length < PAGE) break;
  }
  if (!all.length) throw new Error('数据集拉取结果为空');
  return all;
}

/** 锁定数据集到本地缓存，返回锁定文件路径与哈希（revision = 实例数 + 首尾 ID）。 */
export function lockDataset(instances: SwebenchInstance[]): {
  file: string;
  sha256: string;
  revision: string;
} {
  const sorted = [...instances].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const revision = `verified-${sorted.length}-${sorted[0].instance_id}-${sorted.at(-1)!.instance_id}`;
  const file = path.join(CACHE_DIR, `dataset.${revision}.json`);
  const payload = JSON.stringify({ revision, dataset: DATASET, instances: sorted });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, payload);
  return { file, sha256: sha256Of(payload), revision };
}

/** 读取锁定数据集并校验 sha（防止缓存被篡改/误用旧版）。 */
export function loadLockedDataset(expectedSha256?: string): {
  instances: SwebenchInstance[];
  revision: string;
  sha256: string;
} {
  const candidates = fs.existsSync(CACHE_DIR)
    ? fs
        .readdirSync(CACHE_DIR)
        .filter((f) => f.startsWith('dataset.') && f.endsWith('.json'))
        .sort()
    : [];
  const latest = candidates.at(-1);
  if (!latest) throw new Error(`未找到锁定数据集（目录: ${CACHE_DIR}）——先运行 --lock`);
  const payload = fs.readFileSync(path.join(CACHE_DIR, latest), 'utf8');
  const sha256 = sha256Of(payload);
  if (expectedSha256 && expectedSha256 !== sha256) {
    throw new Error(`锁定数据集 sha 不匹配: 期望 ${expectedSha256}，实际 ${sha256}`);
  }
  const parsed = JSON.parse(payload) as { revision: string; instances: SwebenchInstance[] };
  return { instances: parsed.instances, revision: parsed.revision, sha256 };
}

export function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export { CACHE_DIR, DATASET, HERE };
