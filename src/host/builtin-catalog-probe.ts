// 模块: 内置 Provider 远端目录的启动后台探测
//
// 第一层根治：把「供应商上新 → 用户看到」从**有人记得点刷新**变成**自动发生**。
// 静态目录（pi-ai 构建期数据）只是冷启动回退，不是真相源。
//
// 设计要点（对应 docs/plans/builtin-model-catalog-refresh.md §3）：
//   - **不阻塞就绪**：调用方在 server.listen 成功之后 fire-and-forget；探测失败只
//     记 stale，绝不让 Host 启动失败，也绝不让一个进程退出码污染启动路径。
//   - **一次只探一家的凭据**：baseUrl 与 apiKey 逐个从 RunStore 取，日志只打印
//     piProviderId 与模型数，**不打印 baseUrl/apiKey/响应原文**。
//   - **有界并发**：避免启动瞬间对同一批端点发起风暴（供应商有 RPM/TPM 限制）。
//   - **失败静默**：只有确实没有可回退目录时才 WARN，其余走 DEBUG，且不抛。
//
// 只探「已配置密钥 + 可远端刷新」的内置 Provider（见 isRemoteRefreshableProvider），
// 未配置的 Provider 留给用户在设置页首次配置时的实时预检。

import { fetchBuiltinProviderCatalog } from './available-models.js';
import { isRemoteRefreshableProvider } from './pi-ai-providers.js';
import type { RunManager } from './run-manager.js';

/** 启动期并发上限：供应商端点通常有 RPM 限制，别自讨 429。 */
const PROBE_CONCURRENCY = 3;
/** 单次探测超时：比用户点击的 15s 略短，启动期不该被慢端点拖太久。 */
const PROBE_TIMEOUT_MS = 12_000;

export interface BuiltinCatalogProbeResult {
  piProviderId: string;
  ok: boolean;
  modelCount: number;
  error?: string;
}

interface Target {
  piProviderId: string;
  baseUrl: string;
  apiKey: string;
}

function collectTargets(manager: RunManager): Target[] {
  const targets: Target[] = [];
  for (const provider of manager.listModelProviders()) {
    const piProviderId = provider.piProviderId;
    if (!piProviderId || !provider.hasApiKey) continue;
    if (!isRemoteRefreshableProvider(piProviderId)) continue;
    const secret = manager.getModelProviderSecret(provider.id);
    if (!secret?.apiKey || !secret.baseUrl) continue;
    targets.push({ piProviderId, baseUrl: secret.baseUrl, apiKey: secret.apiKey });
  }
  return targets;
}

/**
 * 对所有已配置的内置 Provider 后台探测远端 /models，写入目录缓存与准入名单。
 * **永不 reject** —— 失败降级为 stale 缓存（或无缓存），调用方不需要 try/catch。
 */
export async function refreshBuiltinModelCatalogs(
  manager: RunManager,
): Promise<BuiltinCatalogProbeResult[]> {
  const targets = collectTargets(manager);
  const results: BuiltinCatalogProbeResult[] = [];
  if (targets.length === 0) return results;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const target = targets[index];
      results[index] = await probeOne(manager, target);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, () => worker()),
  );
  return results;
}

async function probeOne(manager: RunManager, target: Target): Promise<BuiltinCatalogProbeResult> {
  try {
    const { catalog, remoteModelIds } = await withTimeout(
      fetchBuiltinProviderCatalog(target.piProviderId, target.baseUrl, target.apiKey),
      PROBE_TIMEOUT_MS,
    );
    // remoteModelIds = 远端真正返回的 id（准入名单的证据）；
    // catalog = 静态 ∪ 远端 的合并目录（缓存里存的形状，供设置页直读）。
    manager.recordBuiltinRemoteCatalog(target.piProviderId, remoteModelIds, catalog, true);
    console.log(`[catalog] ${target.piProviderId} 远端目录已刷新：${catalog.length} 个模型`);
    return { piProviderId: target.piProviderId, ok: true, modelCount: catalog.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 失败：保留上次成功结果并标 stale（从未成功过 = no-op，不凭空造空目录）
    manager.recordBuiltinRemoteCatalog(target.piProviderId, [], [], false);
    console.warn(`[catalog] ${target.piProviderId} 远端目录刷新失败（沿用上次结果）: ${message}`);
    return { piProviderId: target.piProviderId, ok: false, modelCount: 0, error: message };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
