// 模块: 已配置 Provider 远端目录的启动后台探测
//
// 第一层根治：把「供应商上新 → 用户看到」从**有人记得点刷新**变成**自动发生**。
// 静态目录（pi-ai 构建期数据）只是冷启动回退，不是真相源。
//
// 设计要点（对应 docs/plans/builtin-model-catalog-refresh.md §3）：
//   - **不阻塞就绪**：调用方在 server.listen 成功之后 fire-and-forget；探测失败只
//     记 stale，绝不让 Host 启动失败，也绝不让一个进程退出码污染启动路径。
//   - **一次只探一家的凭据**：baseUrl 与 apiKey 逐个从 RunStore 取，日志只打印
//     提供方标识与模型数，**不打印 baseUrl/apiKey/响应原文**。
//   - **有界并发**：避免启动瞬间对同一批端点发起风暴（供应商有 RPM/TPM 限制）。
//   - **失败静默**：只有确实没有可回退目录时才 WARN，其余走 DEBUG，且不抛。
//   - **写回已保存列表**：探测到的对话模型追加进该提供方的 models。输入框下拉读的是
//     这份列表，只更新目录缓存的话新模型不会出现。已有项保留，不改当前默认模型。
//
// 探测范围：已配置密钥、且地址可请求的提供方。内置提供方还要过
// isRemoteRefreshableProvider（协议上有统一的 GET {baseUrl}/models）。
// 自定义端点走与设置页「检测并同步」相同的拉取。未配置密钥的留给首次保存时的预检。

import { fetchAvailableModelCatalog, fetchBuiltinProviderCatalog } from './available-models.js';
import { isRemoteRefreshableProvider, listPiAiProviderCatalog } from './pi-ai-providers.js';
import { canonicalizeProviderBaseUrl, type ProviderModelInfo } from './provider-url.js';
import type { RunManager } from './run-manager.js';

/** 启动期并发上限：供应商端点通常有 RPM 限制，别自讨 429。 */
const PROBE_CONCURRENCY = 3;
/** 单次探测超时：比用户点击的 15s 略短，启动期不该被慢端点拖太久。 */
const PROBE_TIMEOUT_MS = 12_000;
/** 与设置保存的 models 上限一致（settings-store normalizeModels）。 */
const MAX_SAVED_MODELS = 50;

export interface BuiltinCatalogProbeResult {
  /** 内置 Provider id；自定义端点则是已保存提供方 id。 */
  piProviderId: string;
  ok: boolean;
  modelCount: number;
  error?: string;
}

interface Target {
  /** 日志用标识：内置 id，或自定义提供方 id。 */
  label: string;
  piProviderId?: string;
  providerIds: string[];
  baseUrl: string;
  apiKey: string;
}

function probeableBaseUrl(baseUrl: string): boolean {
  try {
    canonicalizeProviderBaseUrl(baseUrl, { allowLoopbackHttp: true });
    return true;
  } catch {
    return false;
  }
}

function collectTargets(manager: RunManager): Target[] {
  const targets: Target[] = [];
  for (const provider of manager.listModelProviders()) {
    if (!provider.hasApiKey) continue;
    const secret = manager.getModelProviderSecret(provider.id);
    if (!secret?.apiKey || !secret.baseUrl || !probeableBaseUrl(secret.baseUrl)) continue;
    if (provider.piProviderId) {
      if (!isRemoteRefreshableProvider(provider.piProviderId)) continue;
      // 同一供应商的不同账号可能有不同模型权限，必须逐份凭据探测、写回。
      const target: Target = {
        label: provider.piProviderId,
        piProviderId: provider.piProviderId,
        providerIds: [provider.id],
        baseUrl: secret.baseUrl,
        apiKey: secret.apiKey,
      };
      targets.push(target);
      continue;
    }
    targets.push({
      label: provider.id,
      providerIds: [provider.id],
      baseUrl: secret.baseUrl,
      apiKey: secret.apiKey,
    });
  }
  return targets;
}

/**
 * 对所有已配置且可探测的 Provider 后台拉远端 /models。
 * 内置 Provider 同时写入目录缓存与准入名单，并把新的对话模型追加到已保存列表。
 * **永不 reject** —— 失败降级为 stale 缓存（或无缓存），调用方不需要 try/catch。
 */
export async function refreshBuiltinModelCatalogs(
  manager: RunManager,
): Promise<BuiltinCatalogProbeResult[]> {
  manager.beginCatalogProbe();
  try {
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
  } finally {
    manager.finishCatalogProbe();
  }
}

async function probeOne(manager: RunManager, target: Target): Promise<BuiltinCatalogProbeResult> {
  try {
    const catalog = target.piProviderId
      ? await probeBuiltin(manager, target)
      : await withTimeout(
          fetchAvailableModelCatalog(target.baseUrl, target.apiKey),
          PROBE_TIMEOUT_MS,
        );
    const staticIds = target.piProviderId
      ? (listPiAiProviderCatalog()
          .find((provider) => provider.id === target.piProviderId)
          ?.models.map((model) => model.id) ?? [])
      : [];
    const added = appendDiscoveredChatModels(manager, target.providerIds, catalog, staticIds);
    console.log(
      `[catalog] ${target.label} 远端目录已刷新：${catalog.length} 个模型，已保存列表追加 ${added} 个`,
    );
    return { piProviderId: target.label, ok: true, modelCount: catalog.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 失败：内置目录保留上次成功结果并标 stale（从未成功过 = no-op）。
    // 已保存的模型列表不动。
    if (target.piProviderId) {
      manager.recordBuiltinRemoteCatalog(target.piProviderId, [], [], false);
    }
    console.warn(`[catalog] ${target.label} 远端目录刷新失败（沿用上次结果）: ${message}`);
    return { piProviderId: target.label, ok: false, modelCount: 0, error: message };
  }
}

async function probeBuiltin(manager: RunManager, target: Target): Promise<ProviderModelInfo[]> {
  const piProviderId = target.piProviderId;
  if (!piProviderId) return [];
  const { catalog, remoteModelIds } = await withTimeout(
    fetchBuiltinProviderCatalog(piProviderId, target.baseUrl, target.apiKey),
    PROBE_TIMEOUT_MS,
  );
  // remoteModelIds = 远端真正返回的 id（准入名单的证据）；
  // catalog = 静态 ∪ 远端 的合并目录。准入名单必须先落盘，后面追加的新 id 才能通过保存校验。
  manager.recordBuiltinRemoteCatalog(piProviderId, remoteModelIds, catalog, true);
  return catalog;
}

/**
 * 把目录里的对话模型追加到已保存提供方。
 * 已有 id 保留；50 条上限内优先追加远端独有 id，避免静态旧模型把最新模型挤出去。
 * 不覆盖用户已经填过的能力；新 id 才带上远端声明的上下文 / 视觉。
 */
function appendDiscoveredChatModels(
  manager: RunManager,
  providerIds: string[],
  catalog: ProviderModelInfo[],
  staticModelIds: string[],
): number {
  const staticIds = new Set(staticModelIds);
  const chat = catalog.filter((model) => model.category === 'chat' && model.id.trim());
  const ranked = [
    ...chat.filter((model) => !staticIds.has(model.id)),
    ...chat.filter((model) => staticIds.has(model.id)),
  ];
  if (ranked.length === 0) return 0;

  let added = 0;
  for (const providerId of providerIds) {
    const current = manager.getModelProvider(providerId);
    if (!current) continue;
    const known = new Set(current.models);
    const room = MAX_SAVED_MODELS - current.models.length;
    if (room <= 0) continue;
    const additions = ranked.filter((model) => !known.has(model.id)).slice(0, room);
    if (additions.length === 0) continue;

    const capabilities = { ...(current.modelCapabilities ?? {}) };
    let wroteCapability = false;
    for (const model of additions) {
      const entry: {
        contextWindow?: number;
        maxOutputTokens?: number;
        vision?: boolean;
      } = {};
      if (model.contextWindow !== undefined && model.contextWindow > 0) {
        entry.contextWindow = model.contextWindow;
      }
      if (model.maxOutputTokens !== undefined && model.maxOutputTokens > 0) {
        entry.maxOutputTokens = model.maxOutputTokens;
      }
      if (model.vision === true) entry.vision = true;
      if (Object.keys(entry).length === 0) continue;
      capabilities[model.id] = entry;
      wroteCapability = true;
    }

    try {
      manager.updateModelProvider(providerId, {
        models: [...current.models, ...additions.map((model) => model.id)],
        ...(wroteCapability ? { modelCapabilities: capabilities } : {}),
      });
      added += additions.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[catalog] ${providerId} 追加模型失败（已保存列表不变）: ${message}`);
    }
  }
  return added;
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
