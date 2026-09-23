// 50 题选取：分层抽样（最大余额法）——按 repo 实例数占比分配名额，repo 内按
// instance_id 字典序取前 K。无随机种子、无人工挑选：换机器/换人跑得到同一清单。
// 纯函数，可单测（sampling.test.ts）。
import type { SwebenchInstance } from './dataset.js';

export interface SelectionResult {
  /** 选中的实例（按 instance_id 字典序全局排序，pilot 从头部预取）。 */
  selected: SwebenchInstance[];
  /** 每个 repo 分到的名额（审计用）。 */
  quota: Record<string, number>;
  total: number;
}

/**
 * 分层抽样：quota_repo = floor(share_repo * total)，余数按小数部分降序补 1
 * （最大余额法，ties 按 repo 字典序——保证确定性）。repo 内排序取前 K。
 */
export function stratifiedSample(instances: SwebenchInstance[], total: number): SelectionResult {
  if (total <= 0 || instances.length === 0) return { selected: [], quota: {}, total: 0 };
  const byRepo = new Map<string, SwebenchInstance[]>();
  for (const instance of instances) {
    const list = byRepo.get(instance.repo) ?? [];
    list.push(instance);
    byRepo.set(instance.repo, list);
  }
  const repos = [...byRepo.keys()].sort();
  const grandTotal = instances.length;

  const exact = repos.map((repo) => ({
    repo,
    exactShare: (byRepo.get(repo)!.length / grandTotal) * total,
  }));
  const quota: Record<string, number> = {};
  for (const entry of exact) quota[entry.repo] = Math.floor(entry.exactShare);
  let remaining = total - Object.values(quota).reduce((sum, n) => sum + n, 0);
  const byRemainder = [...exact].sort(
    (a, b) => b.exactShare - Math.floor(b.exactShare) - (a.exactShare - Math.floor(a.exactShare)) ||
      a.repo.localeCompare(b.repo),
  );
  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    quota[entry.repo] += 1;
    remaining -= 1;
  }

  const picked: SwebenchInstance[] = [];
  for (const repo of repos) {
    const k = quota[repo] ?? 0;
    if (k <= 0) continue;
    const sorted = [...byRepo.get(repo)!].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    picked.push(...sorted.slice(0, k));
  }
  picked.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  return { selected: picked, quota, total };
}

/** pilot = 选中清单字典序前 n（跑 50 题之前预先确定，防看过结果再换题）。 */
export function pilotFromSelection(selected: SwebenchInstance[], n: number): SwebenchInstance[] {
  return [...selected].sort((a, b) => a.instance_id.localeCompare(b.instance_id)).slice(0, n);
}
