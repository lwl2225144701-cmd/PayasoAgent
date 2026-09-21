// 收尾批次的续跑计划：纯函数，不碰文件系统，便于确定性单测。
// 规则与 docs/quality-repair-closure-plan.md 对齐：
// - 只有源码/验收样例指纹完全一致才能续跑，禁止换版本混用；
// - 已“等待内容复核”的批次不重跑（省额度且不可冒名）；
// - provider_blocked / runner_failed / 中断残留的 running 一律重跑，失败不计通过。

export type BatchStatus =
  | 'awaiting_content_review'
  | 'content_reviewed'
  | 'provider_blocked'
  | 'runner_failed'
  | 'running';

export interface BatchRecord {
  name: string;
  output?: string;
  status: string;
}

export interface BatchFile {
  sourceHash?: string;
  configFingerprint?: string;
  model?: string;
  batches?: BatchRecord[];
}

export type BatchPlan =
  | { kind: 'fresh' }
  | { kind: 'resume'; keep: BatchRecord[]; rerun: string[] };

// 同一批次重跑只保留最后一条记录，按 name 去重。
function latestByName(batches: BatchRecord[]): BatchRecord[] {
  const map = new Map<string, BatchRecord>();
  for (const record of batches) if (record?.name) map.set(record.name, record);
  return [...map.values()];
}

const REVIEWED = new Set<BatchStatus>(['awaiting_content_review', 'content_reviewed']);

export function planBatches(
  existing: BatchFile | undefined,
  sourceHash: string,
  configFingerprint: string,
  all: readonly string[],
): BatchPlan {
  if (!existing || !Array.isArray(existing.batches) || existing.batches.length === 0)
    return { kind: 'fresh' };
  if (existing.sourceHash !== sourceHash) {
    throw new Error(
      '收尾目录的源码指纹与当前版本不一致，不能用新版本续跑旧批次（重新开始一个收尾目录）',
    );
  }
  if (existing.configFingerprint !== configFingerprint) {
    throw new Error('收尾目录的模型端点或凭证与当前配置不一致，不能混用评测结果');
  }
  const keep = latestByName(existing.batches).filter(
    (r) => all.includes(r.name) && REVIEWED.has(r.status as BatchStatus),
  );
  const rerun = all.filter((name) => !keep.some((r) => r.name === name));
  return { kind: 'resume', keep, rerun };
}
