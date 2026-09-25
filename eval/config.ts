// 外挂评测配置：全部来自环境变量（eval/.env 或 shell export）。零 PayasoAgent 源码依赖。
//
// 模型凭证直接用 OPENAI_*（与 agent CLI 的兜底同名），评测器把它作为 --env-file 喂给
// 每次 spawn 的 agent CLI；评测器不 import agent、不连 Host，只在进程边界驱动 CLI。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR } from './dataset.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** payaso_agent 仓库根（eval/ 的上一级）——agent CLI（src/cli.ts）从这里拉起。 */
export const REPO_ROOT = path.resolve(HERE, '..');
export const AGENT_CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

export interface EvalConfig {
  modelBaseUrl: string;
  modelApiKey: string;
  modelName: string;
  /** eval/.env 路径（含 OPENAI_*），作为 --env-file 喂给 agent CLI */
  envFile: string;
  /** 数据集 + repo clone 缓存 + 输出根（默认都在 eval/ 下，gitignore） */
  cacheDir: string;
  outputRoot: string;
  /** 隔离的被测 agent 的 PAYASO_HOME（checkpoint / sandbox scratch / 凭证均落这里） */
  aiHome: string;
  /** 单实例 agent 墙钟上限（默认 60min）；判分不参与该值 */
  instanceTimeoutMs: number;
  permissionMode: 'read-only' | 'workspace-write' | 'full-access';
  networkMode: 'on' | 'off' | 'ask';
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): EvalConfig {
  const modelBaseUrl = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const modelApiKey = process.env.OPENAI_API_KEY?.trim() || '';
  const modelName = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const perm = process.env.EVAL_PERMISSION_MODE?.trim();
  if (perm && perm !== 'read-only' && perm !== 'workspace-write' && perm !== 'full-access') {
    throw new Error(`EVAL_PERMISSION_MODE 非法: ${perm}`);
  }
  const net = process.env.EVAL_NETWORK_MODE?.trim();
  if (net && net !== 'on' && net !== 'off' && net !== 'ask') {
    throw new Error(`EVAL_NETWORK_MODE 非法: ${net}`);
  }
  return {
    modelBaseUrl,
    modelApiKey,
    modelName,
    envFile: process.env.EVAL_ENV_FILE?.trim() || path.join(HERE, '.env'),
    cacheDir: CACHE_DIR,
    outputRoot: process.env.EVAL_OUTPUT_ROOT?.trim() || path.join(HERE, 'runs'),
    aiHome: process.env.EVAL_AI_HOME?.trim() || path.join(HERE, '.ai-home'),
    instanceTimeoutMs: positiveInt(process.env.EVAL_INSTANCE_TIMEOUT_MS, 60 * 60_000),
    permissionMode: (perm as EvalConfig['permissionMode']) ?? 'workspace-write',
    networkMode: (net as EvalConfig['networkMode']) ?? 'on',
  };
}
