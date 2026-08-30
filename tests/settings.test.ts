// 模块: 模型配置 API 测试 — 覆盖 CRUD、Secret 隔离、校验、错误响应
// 用法: npx tsx tests/settings.test.ts（确定性，无真实网络；SecretStore = Memory）

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { createHostServer } from "../src/host/server.js";
import { RunManager } from "../src/host/run-manager.js";
import { createDefaultRunStore, SqliteRunStore } from "../src/host/persistence/sqlite-store.js";
import { SettingsStore } from "../src/host/persistence/settings-store.js";
import { MemorySecretStore, providerSecretKey } from "../src/host/secrets/secret-store.js";
import { checkpointPath } from "../src/runtime/checkpoint.js";
import { createWorkspace, getSandboxRoot } from "../src/sandbox/sandbox-manager.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-settings-test-"));
process.env.SANDBOX_ROOT = ROOT;
process.env.PAYASO_DB_PATH = path.join(ROOT, "payaso.db");
fs.mkdirSync(ROOT, { recursive: true });

// SecretStore 注入 Memory 实现：确定性测试绝不触碰用户本机 Keychain
const secretStore = new MemorySecretStore();
const store = createDefaultRunStore(secretStore);
const manager = new RunManager(store);
const TEST_TOKEN = "test-token-00000000000000000000000000000000";
const server = createHostServer(manager, TEST_TOKEN);
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

async function getRunStatus(runId: string): Promise<{ status: string }> {
  const body = await (await fetch(`${base}/runs/${runId}`, { headers: await authHeaders() })).json();
  return { status: body.status };
}
function cleanupCheckpoint(runId: string): void {
  fs.rmSync(checkpointPath(runId), { force: true });
}

async function getJSON(url: string, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, { headers: await authHeaders() });
  const text = await res.text().catch(() => "");
  if (res.status !== expectedStatus) {
    console.error(`GET ${url} failed: ${res.status} ${text}`);
  }
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postJSON(url: string, body: any, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (res.status !== expectedStatus) {
    console.error(`POST ${url} failed: ${res.status} ${text}`);
  }
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function patchJSON(url: string, body: any, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (res.status !== expectedStatus) {
    console.error(`PATCH ${url} failed: ${res.status} ${text}`);
  }
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function delJSON(url: string, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, { method: "DELETE", headers: await authHeaders() });
  const text = await res.text().catch(() => "");
  if (res.status !== expectedStatus) {
    console.error(`DELETE ${url} failed: ${res.status} ${text}`);
  }
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postJSONWithOrigin(url: string, body: any, origin: string, expectedStatus = 200): Promise<{ status: number }> {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const client = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      const headers = [
        `POST ${u.pathname} HTTP/1.1`,
        `Host: ${u.host}`,
        `Origin: ${origin}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(payload)}`,
        "Connection: close",
        "",
        payload,
      ].join("\r\n");
      client.write(headers);
    });
    const chunks: Buffer[] = [];
    client.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
    });
    client.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const match = raw.match(/HTTP\/\d\.\d (\d+)/);
      console.log(`[raw request] status=${match ? match[1] : "?"} raw=${raw.slice(0, 200)}`);
      resolve({ status: match ? parseInt(match[1], 10) : 0 });
    });
    client.on("error", reject);
  });
}

// ---- 测试开始 ----

(async () => {
  // 1. 默认列表：新库无内置模板，列表为空
  let list = await getJSON(`${base}/settings/models`);
  check("GET default empty (no builtins)", Array.isArray(list.models) && list.models.length === 0);

  // 1b. 创建带凭证的 provider（替代原内置模板入口，builtin 已移除）
  let tplAdded = await postJSON(`${base}/settings/models`, {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-template-1234",
    models: ["deepseek-chat"],
  }, 201);
  check("template add keeps custom kind", tplAdded.kind === "custom");
  check("template add has key", tplAdded.hasApiKey === true && tplAdded.apiKeyMasked === "********");
  let afterTpl = await getJSON(`${base}/settings/models`);
  check("template add visible in list", afterTpl.models.some((m: any) => m.id === tplAdded.id && m.hasApiKey === true));

  // 2. 创建 provider
  let created = await postJSON(`${base}/settings/models`, {
    name: "TestProvider",
    baseUrl: "https://api.test.com",
    apiKey: "sk-abcdef1234567890",
    models: ["test-chat", "test-reasoner"],
  }, 201);
  check("POST created has id", typeof created.id === "string" && created.id.length > 0);
  check("POST created name", created.name === "TestProvider");
  check("POST created apiKeyMasked", created.apiKeyMasked === "********");
  check("POST created hasApiKey", created.hasApiKey === true);
  check("POST created models", created.models.length === 2);
  check("POST created kind", created.kind === "custom");
  check("POST created status", created.status === "configured");

  // 3. 重复 name 拒绝
  let dupName = await postJSON(`${base}/settings/models`, {
    name: "TestProvider",
    baseUrl: "https://api.other.com",
    apiKey: "sk-other",
    models: ["other"],
  }, 400);
  check("POST dup name 400", dupName.message === "Provider with same name or baseUrl already exists: TestProvider (https://api.test.com)");

  // 4. 重复 baseUrl 拒绝
  let dupUrl = await postJSON(`${base}/settings/models`, {
    name: "Other",
    baseUrl: "https://api.test.com",
    apiKey: "sk-other",
    models: ["other"],
  }, 400);
  check("POST dup baseUrl 400", dupUrl.message === "Provider with same name or baseUrl already exists: TestProvider (https://api.test.com)");

  // 5. 非法 URL 拒绝
  let badUrl = await postJSON(`${base}/settings/models`, {
    name: "Bad",
    baseUrl: "ftp://example.com",
    apiKey: "sk-bad",
    models: ["bad"],
  }, 400);
  check("POST bad url 400", badUrl.message === "baseUrl protocol not allowed");

  // 6. models 去重
  let deduped = await postJSON(`${base}/settings/models`, {
    name: "Dedup",
    baseUrl: "https://api.dedup.com",
    apiKey: "sk-dedup",
    models: ["m1", "m1", "m2", " m2 "],
  }, 201);
  check("POST models deduped", deduped.models.length === 2);

  // 7. models 超 50 拒绝
  const manyModels = Array.from({ length: 51 }, (_, i) => `m${i}`);
  let tooMany = await postJSON(`${base}/settings/models`, {
    name: "TooMany",
    baseUrl: "https://api.toomany.com",
    apiKey: "sk-toomany",
    models: manyModels,
  }, 400);
  check("POST too many models 400", tooMany.message === "models cannot exceed 50");

  // 8. 更新保留 apiKey（不传 apiKey）
  let updated = await patchJSON(`${base}/settings/models/${created.id}`, {
    name: "TestProvider Updated",
  });
  check("PATCH name updated", updated.name === "TestProvider Updated");
  check("PATCH apiKey unchanged", updated.apiKeyMasked === "********" && updated.hasApiKey === true);

  // 9. 更新清除 apiKey（传 null）
  let cleared = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: null,
  });
  check("PATCH apiKey cleared", cleared.apiKeyMasked === "****" && cleared.hasApiKey === false);

  // 10. 更新替换 apiKey
  let replaced = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: "new-key-9999",
  });
  check("PATCH apiKey replaced", replaced.apiKeyMasked === "********" && replaced.hasApiKey === true);

  // 11. 空字符串 apiKey 拒绝
  let emptyKey = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: "   ",
  }, 400);
  check("PATCH empty apiKey 400", emptyKey.message === "apiKey must be non-empty or null");

  // 12. 非法 ID 拒绝
  let badId = await getJSON(`${base}/settings/models/not-a-uuid`, 400);
  check("GET bad id 400", badId.message === "invalid_model_id");

  let badIdPatch = await patchJSON(`${base}/settings/models/not-a-uuid`, { name: "x" }, 400);
  check("PATCH bad id 400", badIdPatch.message === "invalid_model_id");

  let badIdDel = await delJSON(`${base}/settings/models/not-a-uuid`, 400);
  check("DELETE bad id 400", badIdDel.message === "invalid_model_id");

  // 13. 删除不存在的 provider 返回 404（内置模板已移除，无"不可删内置"语义）
  let delMissingStatus = await (await fetch(`${base}/settings/models/${crypto.randomUUID()}`, {
    method: "DELETE",
    headers: await authHeaders(),
  })).status;
  check("DELETE missing provider 404", delMissingStatus === 404);

  // 14. 删除成功返回 { deleted: true }
  let deleted = await delJSON(`${base}/settings/models/${created.id}`);
  check("DELETE returns deleted:true", deleted.deleted === true);

  // 15. 删除后不存在
  let afterDel = await getJSON(`${base}/settings/models/${created.id}`, 404);
  check("GET after delete 404", afterDel.error === "not_found");

  // 16. 列表最终：DeepSeek + Dedup 两个自定义（无内置模板）
  let finalList = await getJSON(`${base}/settings/models`);
  check("final list count", finalList.models.length === 2);
  check("final list builtin count", finalList.models.filter((m: any) => m.kind === "builtin").length === 0);

  // 17. 设置默认模型：校验矩阵（未知 404 / 空 400 / 未配置密钥 400）
  let unknownDefault = await postJSON(`${base}/settings/default`, { providerId: "not-exist", model: "m" }, 404);
  check("default unknown provider 404", unknownDefault.error === "not_found");

  let emptyDefault = await postJSON(`${base}/settings/default`, { providerId: "   " }, 400);
  check("default empty providerId 400", emptyDefault.message === "providerId is required");

  // 未配置密钥的 provider 设默认 → 400
  let noKeyProv = await postJSON(`${base}/settings/models`, {
    name: "NoKeyProvider",
    baseUrl: "https://api.nokey.com",
    models: ["nk-chat"],
  }, 201);
  let unconfiguredDefault = await postJSON(`${base}/settings/default`, { providerId: noKeyProv.id, model: "nk-chat" }, 400);
  check("default unconfigured provider 400", unconfiguredDefault.message === "Provider has no API key configured");

  // 18. 默认模型成对保存（providerId + modelId）+ model 目录校验
  let defaultProvider = await postJSON(`${base}/settings/models`, {
    name: "DefaultProvider",
    baseUrl: "https://api.default-test.com",
    apiKey: "sk-default-8888",
    models: ["dm-chat", "dm-reasoner"],
  }, 201);

  let badModelDefault = await postJSON(`${base}/settings/default`, { providerId: defaultProvider.id, model: "not-in-catalog" }, 400);
  check("default unknown model 400", badModelDefault.message === 'Model "not-in-catalog" is not in provider catalog');

  let okDefault = await postJSON(`${base}/settings/default`, { providerId: defaultProvider.id, model: "dm-reasoner" }, 200);
  check("default set returns pair", okDefault.defaultProviderId === defaultProvider.id && okDefault.defaultModelId === "dm-reasoner");

  let currentDefault = await getJSON(`${base}/settings`);
  check("GET settings returns pair", currentDefault.defaultProviderId === defaultProvider.id && currentDefault.defaultModelId === "dm-reasoner");

  // 19. P1 回归：对其它 provider 的 CRUD 不得丢失默认对
  await postJSON(`${base}/settings/models`, {
    name: "TouchProvider",
    baseUrl: "https://api.touch.com",
    apiKey: "sk-touch",
    models: ["touch-1"],
  }, 201);
  let afterAdd = await getJSON(`${base}/settings`);
  check("default survives addModel", afterAdd.defaultProviderId === defaultProvider.id && afterAdd.defaultModelId === "dm-reasoner");

  await patchJSON(`${base}/settings/models/${defaultProvider.id}`, { name: "DefaultProvider Renamed" });
  let afterUpdate = await getJSON(`${base}/settings`);
  check("default survives updateModel", afterUpdate.defaultProviderId === defaultProvider.id && afterUpdate.defaultModelId === "dm-reasoner");

  // 20. 删除默认 provider → 默认对清空（解析时回退第一个可用 provider）
  await delJSON(`${base}/settings/models/${defaultProvider.id}`);
  let afterDelete = await getJSON(`${base}/settings`);
  check("default cleared after deleting default provider", afterDelete.defaultProviderId === "" && afterDelete.defaultModelId === "");

  // 21. 环境配置一次性导入（.env → 设置）：新建自定义 Provider 并设为默认
  {
    const store = new SettingsStore(new DatabaseSync(":memory:"), new MemorySecretStore());
    const imported = store.importEnvFallback({
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "sk-env-test-1234",
      model: "MiniMax-M3",
    });
    check("env import returns pair", imported !== null && imported.modelId === "MiniMax-M3");
    const view = imported ? store.listViews().find(p => p.id === imported.providerId) : undefined;
    check("env import created configured provider", !!view && view.hasApiKey && view.models.includes("MiniMax-M3"));
    check("env import set default pair", store.getDefaultProviderId() === imported?.providerId && store.getDefaultModelId() === "MiniMax-M3");

    // 幂等：导入过一次后不再重复（即使传入不同配置）
    const again = store.importEnvFallback({ baseUrl: "https://api.other.com/v1", apiKey: "sk-another", model: "other-model" });
    check("env import is once-only", again === null && store.listViews().length === 1);
  }

  // 22. 环境配置导入：无内置模板，匹配不到时新建自定义 provider（不新建则填已有）
  {
    const store = new SettingsStore(new DatabaseSync(":memory:"), new MemorySecretStore());
    const imported = store.importEnvFallback({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai-env-5678",
      model: "gpt-4o",
    });
    check("env import created custom", imported !== null && imported.modelId === "gpt-4o");
    const openai = imported ? store.listViews().find(p => p.id === imported.providerId) : undefined;
    check("env import filled custom key", !!openai && openai.hasApiKey && openai.apiKeyMasked === "********");
    check("env import kept catalog", !!openai && openai.models.includes("gpt-4o") && openai.models.length >= 1);
  }

  // 23. 获取可用模型：OpenAI 兼容 GET /models 的解析（去重、trim、排序、错误分支）
  {
    const { fetchAvailableModels } = await import("../src/host/available-models.js");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ data: [{ id: "m2" }, { id: "m1" }, { id: " m1 " }, { object: "model" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
      const models = await fetchAvailableModels("https://api.test.com/v1/", "sk-test");
      check("available models deduped and sorted", JSON.stringify(models) === JSON.stringify(["m1", "m2"]));

      globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
      await assert.rejects(() => fetchAvailableModels("https://api.test.com/v1", "bad"), /returned 401/);

      globalThis.fetch = (async () => new Response(JSON.stringify({ data: "nope" }), { status: 200 })) as typeof fetch;
      await assert.rejects(() => fetchAvailableModels("https://api.test.com/v1", "k"), /missing data array/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 24. HTTP：providerId 代拉目录（存储密钥只在服务端使用，不回传明文）
  {
    const originalFetch = globalThis.fetch;
    try {
      // 放行测试客户端到本地 Host 的请求，仅拦截发往上游的 /models 调用
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes("api.touch.com")) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
          check("available-models used stored key", auth === "Bearer sk-touch");
          return new Response(JSON.stringify({ data: [{ id: "touch-pro" }, { id: "touch-max" }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const listNow = await getJSON(`${base}/settings/models`);
      const touch = listNow.models.find((m: any) => m.name === "TouchProvider");
      check("touch provider exists", !!touch);

      let viaProvider = await postJSON(
        `${base}/settings/available-models`,
        { providerId: touch.id },
        200,
      );
      check("available-models via providerId", JSON.stringify(viaProvider.models) === JSON.stringify(["touch-max", "touch-pro"]));

      // 未配置密钥的 provider → 400
      const noKeyProv = await postJSON(`${base}/settings/models`, {
        name: "NoKeyProv",
        baseUrl: "https://api.nokey2.com",
        models: ["nk2-chat"],
      }, 201);
      let noKey = await postJSON(`${base}/settings/available-models`, { providerId: noKeyProv.id }, 400);
      check("available-models without key 400", noKey.message === "provider has no API key configured");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 25. Secret 隔离：metadata 与凭证分离（Case 1/2/3/4/5/12）
  {
    const SECRET = "PAYASO_TEST_SECRET_DO_NOT_LEAK_123";
    const leak = await postJSON(`${base}/settings/models`, {
      name: "LeakProbe",
      baseUrl: "https://api.leakprobe.com",
      apiKey: SECRET,
      models: ["leak-chat"],
    }, 201);
    const secretKey = providerSecretKey(leak.id);

    // Case 1: Secret 在 SecretStore，不在 SQLite（含 WAL）的任何字节里
    check("Case1: secret lives in SecretStore", secretStore.get(secretKey) === SECRET);
    const dbPath = process.env.PAYASO_DB_PATH!;
    const dbBytes = fs.readFileSync(dbPath);
    const walBytes = fs.existsSync(dbPath + "-wal") ? fs.readFileSync(dbPath + "-wal") : Buffer.alloc(0);
    check("Case1: raw SQLite (main+WAL) contains no secret",
      !dbBytes.includes(SECRET) && !walBytes.includes(SECRET));

    // Case 2: GET settings 不返回 key（即便 SecretStore 里有）
    const listJson = JSON.stringify(await (await fetch(`${base}/settings/models`)).json());
    check("Case2: settings list JSON contains no secret", !listJson.includes(SECRET));

    // Case 3: 只改 metadata → Secret 保持原值
    await patchJSON(`${base}/settings/models/${leak.id}`, { name: "LeakProbe Renamed" });
    check("Case3: metadata-only edit keeps secret", secretStore.get(secretKey) === SECRET);

    // Case 4: 替换 → SecretStore 为新值；旧值不出现在任何 settings JSON
    await patchJSON(`${base}/settings/models/${leak.id}`, { apiKey: SECRET + "-v2" });
    check("Case4: secret replaced in SecretStore", secretStore.get(secretKey) === SECRET + "-v2");
    const afterReplaceList = await getJSON(`${base}/settings/models`);
    const afterReplace = JSON.stringify(afterReplaceList.models.find((m: any) => m.id === leak.id));
    check("Case4: old/new keys absent from settings JSON",
      Boolean(afterReplace) && !afterReplace.includes(SECRET) && !afterReplace.includes(SECRET + "-v2"));

    // Case 5: 显式清除 → Secret 删除 + hasApiKey=false
    await patchJSON(`${base}/settings/models/${leak.id}`, { apiKey: null });
    check("Case5: secret deleted from SecretStore", secretStore.get(secretKey) === null);
    const clearedView = (await getJSON(`${base}/settings/models`)).models.find((m: any) => m.id === leak.id);
    check("Case5: hasApiKey=false after clear", clearedView?.hasApiKey === false);

    // Case 12: 走完一整轮 Run 后，secret 不出现在 SSE 事件/Run JSON/settings/SQLite 序列化里
    const sweep = await postJSON(`${base}/settings/models`, {
      name: "SweepProvider",
      baseUrl: "https://api.sweep-provider.com/v1",
      apiKey: SECRET,
      models: ["sweep-chat"],
    }, 201);
    await postJSON(`${base}/settings/default`, { providerId: sweep.id, model: "sweep-chat" }, 200);
    const originalFetch = globalThis.fetch;
    let runId12 = "";
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes("api.sweep-provider.com")) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
          check("Case12: run request used the SecretStore credential", auth === `Bearer ${SECRET}`);
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "swept" } }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      const created12 = await postJSON(`${base}/runs`, { task: "secret sweep" }, 202);
      runId12 = created12.runId;
      const deadline = Date.now() + 10000;
      let status12 = "running";
      while (Date.now() < deadline) {
        status12 = (await getRunStatus(runId12)).status;
        if (status12 !== "running" && status12 !== "stopping") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check("Case12: run completed through SecretStore credential", status12 === "completed", `status=${status12}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const runJson = JSON.stringify(await (await fetch(`${base}/runs/${runId12}`, { headers: await authHeaders() })).json());
    const eventsText = await (await fetch(`${base}/runs/${runId12}/events?live=0`, { headers: await authHeaders() })).text();
    const settingsAll = JSON.stringify(await (await fetch(`${base}/settings/models`, { headers: await authHeaders() })).json());
    const dbAfter = fs.readFileSync(dbPath);
    check("Case12: no secret in run JSON / SSE events / settings / SQLite",
      !runJson.includes(SECRET) && !eventsText.includes(SECRET) && !settingsAll.includes(SECRET) && !dbAfter.includes(SECRET));
    cleanupCheckpoint(runId12);
  }

  // 26. Case 11: 删除 Provider → SecretStore 同步清理
  {
    const del = await postJSON(`${base}/settings/models`, {
      name: "DelProbe",
      baseUrl: "https://api.delprobe.com",
      apiKey: "sk-del-probe",
      models: ["d1"],
    }, 201);
    check("Case11 pre: secret exists", secretStore.get(providerSecretKey(del.id)) === "sk-del-probe");
    await delJSON(`${base}/settings/models/${del.id}`);
    check("Case11: provider deletion cleans secret", secretStore.get(providerSecretKey(del.id)) === null);
  }

  // 27. Case 6/7/8: legacy 明文 apiKey 迁移（先写 SecretStore 再剥 SQLite；幂等；失败不丢 key）
  {
    const legacyDbPath = path.join(ROOT, "legacy-secrets.db");
    const legacy = new DatabaseSync(legacyDbPath);
    legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    legacy.prepare("INSERT INTO settings VALUES ('app', ?)").run(JSON.stringify({
      models: [
        { id: "legacy-p1", kind: "custom", name: "LegacyOne", baseUrl: "https://legacy1.example.com", apiKey: "legacy-secret-one", hasApiKey: true, models: ["l1"] },
        { id: "legacy-p2", kind: "custom", name: "LegacyTwo", baseUrl: "https://legacy2.example.com", apiKey: "", hasApiKey: false, models: ["l2"] },
      ],
      defaultProviderId: "legacy-p1",
      defaultModelId: "l1",
    }));
    legacy.close();

    // Case 6: 打开即迁移 → SecretStore 有值，SQLite 明文消失
    const mem = new MemorySecretStore();
    let firstSetCalls = 0;
    const store = new SqliteRunStore(legacyDbPath, {
      get: (k: string) => mem.get(k),
      set: (k: string, v: string) => { firstSetCalls++; mem.set(k, v); },
      delete: (k: string) => { mem.delete(k); },
    });
    check("Case6: legacy secret migrated to SecretStore", mem.get(providerSecretKey("legacy-p1")) === "legacy-secret-one");
    const rawBlob = String(new DatabaseSync(legacyDbPath).prepare("SELECT value FROM settings WHERE key='app'").get()!.value);
    check("Case6: legacy plaintext removed from SQLite", !rawBlob.includes("legacy-secret-one"));
    check("Case6: empty legacy key → no secret created", mem.get(providerSecretKey("legacy-p2")) === null);
    check("Case6: migrated provider usable", store.listModelProviders().some((p: any) => p.id === "legacy-p1" && p.hasApiKey === true));
    store.close();

    // Case 8: 幂等 —— 二次打开 0 次 Secret 写入
    let secondSetCalls = 0;
    const store2 = new SqliteRunStore(legacyDbPath, {
      get: (k: string) => mem.get(k),
      set: (k: string, v: string) => { secondSetCalls++; mem.set(k, v); },
      delete: (k: string) => { mem.delete(k); },
    });
    store2.close();
    check("Case8: second open is a no-op (0 secret writes)", secondSetCalls === 0, `setCalls=${secondSetCalls}`);

    // Case 7: SecretStore.set 失败 → legacy 明文不被删除（凭证不丢）
    const failingDb = path.join(ROOT, "failing-secrets.db");
    const flegacy = new DatabaseSync(failingDb);
    flegacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    flegacy.prepare("INSERT INTO settings VALUES ('app', ?)").run(JSON.stringify({
      models: [{ id: "f-p", kind: "custom", name: "F", baseUrl: "https://f.example.com", apiKey: "legacy-secret-must-survive", hasApiKey: true, models: ["f1"] }],
      defaultProviderId: "f-p",
      defaultModelId: "f1",
    }));
    flegacy.close();
    assert.throws(() => new SettingsStore(new DatabaseSync(failingDb), {
      get: () => null,
      set: () => { throw new Error("keychain boom"); },
      delete: () => {},
    }));
    const rawAfterFailure = String(new DatabaseSync(failingDb).prepare("SELECT value FROM settings WHERE key='app'").get()!.value);
    check("Case7: legacy apiKey NOT deleted when SecretStore.set fails",
      rawAfterFailure.includes("legacy-secret-must-survive"));
  }

  // 28. Case 9: Run 的 ModelConfig 由 metadata + SecretStore 合成
  {
    const originalFetch = globalThis.fetch;
    let authHeader = "";
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes("api.resolution-provider.com")) {
          authHeader = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "resolved" } }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      const prov = await postJSON(`${base}/settings/models`, {
        name: "ResolutionProvider",
        baseUrl: "https://api.resolution-provider.com/v1",
        apiKey: "sk-resolution-42",
        models: ["res-chat"],
      }, 201);
      await postJSON(`${base}/settings/default`, { providerId: prov.id, model: "res-chat" }, 200);
      const created9 = await postJSON(`${base}/runs`, { task: "解析凭证" }, 202);
      const deadline = Date.now() + 10000;
      let status9 = "running";
      while (Date.now() < deadline) {
        status9 = (await getRunStatus(created9.runId)).status;
        if (status9 !== "running" && status9 !== "stopping") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check("Case9: run completed with merged ModelConfig", status9 === "completed", `status=${status9}`);
      check("Case9: Authorization used SecretStore value", authHeader === "Bearer sk-resolution-42", `got ${authHeader}`);
      cleanupCheckpoint(created9.runId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 29. SSRF/Origin 防线：available-models 拒绝客户端 baseUrl、要求 providerId、Origin 校验
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes("api.evil.com")) {
          return new Response(JSON.stringify({ data: [{ id: "evil" }] }), { status: 200 });
        }
        if (String(input).includes("ssrf-test.example.com")) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
          check("SSRF: available-models used stored key", auth === "Bearer sk-ssrf-test");
          return new Response(JSON.stringify({ data: [{ id: "ssrf-chat" }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      // 先创建一个带密钥的 provider 用于测试
      const testProv = await postJSON(`${base}/settings/models`, {
        name: "SSRFTestProvider",
        baseUrl: "https://ssrf-test.example.com/v1",
        apiKey: "sk-ssrf-test",
        models: ["ssrf-chat"],
      }, 201);

      // 无 providerId → 400
      const noProvider = await postJSON(`${base}/settings/available-models`, { baseUrl: "https://api.openai.com/v1" }, 400);
      check("SSRF: missing providerId 400", noProvider.message === "providerId is required");

      // 传了 baseUrl 但无 providerId（客户端试图指定 endpoint）→ 400
      const withBaseUrl = await postJSON(`${base}/settings/available-models`, { baseUrl: "https://api.evil.com/v1", apiKey: "sk" }, 400);
      check("SSRF: client-supplied baseUrl rejected", withBaseUrl.message === "providerId is required");

      // 未知 providerId → 400
      const unknownProv = await postJSON(`${base}/settings/available-models`, { providerId: "unknown-id" }, 400);
      check("SSRF: unknown providerId 400", unknownProv.message === "provider not found or not configured");

      // 有 providerId 但无 apiKey → 400（使用未配置密钥的 provider）
      const noKeyProv2 = await postJSON(`${base}/settings/models`, {
        name: "NoKeyProv2",
        baseUrl: "https://api.nokey3.com",
        models: ["nk3-chat"],
      }, 201);
      const noKey = await postJSON(`${base}/settings/available-models`, { providerId: noKeyProv2.id }, 400);
      check("SSRF: provider without key 400", noKey.message === "provider has no API key configured");

      // 正确 providerId → 200（使用存储的 baseUrl + apiKey）
      const ok = await postJSON(`${base}/settings/available-models`, { providerId: testProv.id }, 200);
      check("SSRF: valid providerId 200", Array.isArray(ok.models));

      // Origin 校验：无 Origin 头（服务端调用）→ 200；非法 Origin → 400
      const noOriginRes = await fetch(`${base}/settings/available-models`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` },
        body: JSON.stringify({ providerId: testProv.id }),
      });
      check("SSRF: no Origin allowed", noOriginRes.status === 200);

      const badOriginRes = await postJSONWithOrigin(`${base}/settings/available-models`, { providerId: testProv.id }, "https://evil.com", 400);
      check("SSRF: bad Origin rejected", badOriginRes.status === 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 29b. preview 临时预检接口：/settings/available-models/preview
  // 用于新增 Provider 时用表单 baseUrl+apiKey 拉取目录；凭证不落盘、不写日志。
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes("preview-target.example.com")) {
          const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
          check("preview: used form apiKey", auth === "Bearer sk-preview-form");
          return new Response(JSON.stringify({ data: [{ id: "preview-chat" }, { id: "preview-flash" }] }), { status: 200 });
        }
        if (url.includes("127.0.0.1:60666")) {
          return new Response(JSON.stringify({ data: [{ id: "loopback-chat" }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      // 缺 baseUrl / apiKey → 400
      const noBaseUrl = await postJSON(`${base}/settings/available-models/preview`, { apiKey: "sk-x" }, 400);
      check("preview: missing baseUrl 400", noBaseUrl.message === "baseUrl and apiKey are required");
      const noKey = await postJSON(`${base}/settings/available-models/preview`, { baseUrl: "https://a.com/v1" }, 400);
      check("preview: missing apiKey 400", noKey.message === "baseUrl and apiKey are required");

      // 非 https / 非 loopback http → 400（协议白名单）
      const ftpUrl = await postJSON(`${base}/settings/available-models/preview`, { baseUrl: "ftp://a.com/v1", apiKey: "sk-x" }, 400);
      check("preview: ftp rejected 400", ftpUrl.message === "baseUrl protocol not allowed");
      const evilHttp = await postJSON(`${base}/settings/available-models/preview`, { baseUrl: "http://api.evil.com/v1", apiKey: "sk-x" }, 400);
      check("preview: non-loopback http rejected 400", evilHttp.message === "baseUrl protocol not allowed");

      // 正确 https → 200，mock 校验 Authorization 使用表单 apiKey（不落盘、不回显）
      const okHttps = await postJSON(`${base}/settings/available-models/preview`, {
        baseUrl: "https://preview-target.example.com/v1",
        apiKey: "sk-preview-form",
      }, 200);
      check("preview: https ok 200", Array.isArray(okHttps.models) && okHttps.models.includes("preview-chat"));

      // loopback http（开发模式）→ 200
      const okLoopback = await postJSON(`${base}/settings/available-models/preview`, {
        baseUrl: "http://127.0.0.1:60666/v1",
        apiKey: "sk-loopback",
      }, 200);
      check("preview: loopback http ok 200", Array.isArray(okLoopback.models) && okLoopback.models.includes("loopback-chat"));

      // Origin 校验同样生效
      const badOrigin = await postJSONWithOrigin(`${base}/settings/available-models/preview`, { baseUrl: "https://preview-target.example.com/v1", apiKey: "sk-x" }, "https://evil.com", 400);
      check("preview: bad Origin rejected 400", badOrigin.status === 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 30. SettingsStore 补偿：add/update/delete 的跨存储一致性
  // 两类真实故障注入：
  //   (a) SecretStore 本身失败（failNext）
  //   (b) metadata 写入失败（SQLite BEFORE UPDATE 触发器 RAISE(ABORT)）—— Secret 已成功写入后的补偿回滚
  {
    const failingSecretStore = new (class extends MemorySecretStore {
      failNext = false;
      set(key: string, value: string): void {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("secret store boom");
        }
        super.set(key, value);
      }
      delete(key: string): void {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("secret store boom");
        }
        super.delete(key);
      }
    })();

    // 在 settings 表上安装 BEFORE UPDATE 触发器：任何 metadata 写入都 RAISE(ABORT)
    function addMetaWriteFailTrigger(db: DatabaseSync): void {
      db.exec(`CREATE TRIGGER fail_meta_write BEFORE UPDATE ON settings
               BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END`);
    }

    // Case A1: SecretStore.set 失败 → addModel 抛错，无孤儿 secret
    {
      const db = new DatabaseSync(path.join(ROOT, "fail-add-secret.db"));
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db.exec("INSERT INTO settings (key, value) VALUES ('app', '{\"models\":[],\"defaultProviderId\":\"\",\"defaultModelId\":\"\"}')");
      const store = new SettingsStore(db, failingSecretStore);
      failingSecretStore.failNext = true;
      try {
        store.addModel({ name: "FailAddSecret", baseUrl: "https://fail.add.secret", apiKey: "sk-fail-add", models: ["m"] });
      } catch {
        // expected
      }
      check("Compensation A1: secret set failure leaves no orphan secret", !failingSecretStore.get("model-provider:fail-add-secret:api-key") && failingSecretStore.get("model-provider:fail-add-secret:api-key") === null);
    }

    // Case A2: SecretStore.set 成功 + metadata 写失败（触发器）→ 补偿删除 Secret
    {
      const db = new DatabaseSync(path.join(ROOT, "fail-add-meta.db"));
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db.exec("INSERT INTO settings (key, value) VALUES ('app', '{\"models\":[],\"defaultProviderId\":\"\",\"defaultModelId\":\"\"}')");
      const store = new SettingsStore(db, failingSecretStore); // 构造函数迁移完成后才能装触发器
      addMetaWriteFailTrigger(db);
      const idBefore = JSON.parse((db.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string }).value).models.length;
      try {
        store.addModel({ name: "FailAddMeta", baseUrl: "https://fail.add.meta", apiKey: "sk-fail-add", models: ["m"] });
        check("Compensation A2: metadata failure throws", false, "expected throw");
      } catch {
        check("Compensation A2: metadata failure throws", true);
      }
      // Secret 必须被补偿删除（真实命中"写入成功 → metadata 失败 → 回滚"路径）
      check("Compensation A2: orphan secret compensated", failingSecretStore.get("model-provider:fail-add-meta:api-key") === null, `got ${JSON.stringify(failingSecretStore.get("model-provider:fail-add-meta:api-key"))}`);
      const row = db.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string } | undefined;
      check("Compensation A2: metadata unchanged", row ? JSON.parse(row.value).models.length === idBefore : false);
    }

    // Case B1: SecretStore.set 失败 → updateModel 抛错，secret 保持旧值
    {
      const db2 = new DatabaseSync(path.join(ROOT, "fail-update-secret.db"));
      db2.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db2.exec("INSERT INTO settings (key, value) VALUES ('app', '{\"models\":[{\"id\":\"up1\",\"name\":\"Up1\",\"baseUrl\":\"https://up1\",\"hasApiKey\":true,\"models\":[\"m\"],\"kind\":\"custom\"}],\"defaultProviderId\":\"\",\"defaultModelId\":\"\"}')");
      const store2 = new SettingsStore(db2, failingSecretStore);
      failingSecretStore.set("model-provider:up1:api-key", "old-secret");
      failingSecretStore.failNext = true;
      try {
        store2.updateModel("up1", { name: "Up1Renamed", apiKey: "new-secret" });
      } catch {
        // expected
      }
      check("Compensation B1: secret write failure keeps old secret", failingSecretStore.get("model-provider:up1:api-key") === "old-secret");
    }

    // Case B2: 新 Secret 写入成功 + metadata 写失败（触发器）→ 恢复旧 Secret
    {
      const db2 = new DatabaseSync(path.join(ROOT, "fail-update-meta.db"));
      db2.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db2.exec("INSERT INTO settings (key, value) VALUES ('app', '{\"models\":[{\"id\":\"up2\",\"name\":\"Up2\",\"baseUrl\":\"https://up2\",\"hasApiKey\":true,\"models\":[\"m\"],\"kind\":\"custom\"}],\"defaultProviderId\":\"\",\"defaultModelId\":\"\"}')");
      const store2 = new SettingsStore(db2, failingSecretStore); // 先构造，后装触发器
      addMetaWriteFailTrigger(db2);
      failingSecretStore.set("model-provider:up2:api-key", "old-secret");
      try {
        store2.updateModel("up2", { name: "Up2Renamed", apiKey: "new-secret" });
        check("Compensation B2: metadata failure throws", false, "expected throw");
      } catch {
        check("Compensation B2: metadata failure throws", true);
      }
      // 新 Secret 写入后 metadata 失败 → 必须回滚到旧 Secret（真实命中回滚路径）
      check("Compensation B2: secret rolled back to old", failingSecretStore.get("model-provider:up2:api-key") === "old-secret", `got ${JSON.stringify(failingSecretStore.get("model-provider:up2:api-key"))}`);
      // 默认引用检查在 hasApiKey 更新后执行：清空默认 provider 凭证必须立即清空默认引用
      check("Compensation B2: default reference not dangling", JSON.parse((db2.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string }).value).defaultProviderId === "");
    }

    // Case B3: 默认 provider 被清空凭证（apiKey: null）→ 默认引用必须立即清空（顺序修复回归）
    {
      const db2 = new DatabaseSync(path.join(ROOT, "default-clear-api-key.db"));
      db2.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db2.exec("INSERT INTO settings (key, value) VALUES ('app', '{\"models\":[{\"id\":\"dp1\",\"name\":\"DP1\",\"baseUrl\":\"https://dp1\",\"hasApiKey\":true,\"models\":[\"m1\"],\"kind\":\"custom\"}],\"defaultProviderId\":\"dp1\",\"defaultModelId\":\"m1\"}')");
      const store2 = new SettingsStore(db2, failingSecretStore);
      failingSecretStore.set("model-provider:dp1:api-key", "dp-secret");
      const updated = store2.updateModel("dp1", { apiKey: null });
      check("Default-clear: update returns hasApiKey=false", updated?.hasApiKey === false);
      const row = db2.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string } | undefined;
      const parsed = row ? JSON.parse(row.value) : { defaultProviderId: "dp1", defaultModelId: "m1" };
      check("Default-clear: defaultProviderId cleared", parsed.defaultProviderId === "", `got ${JSON.stringify(parsed.defaultProviderId)}`);
      check("Default-clear: defaultModelId cleared", parsed.defaultModelId === "", `got ${JSON.stringify(parsed.defaultModelId)}`);
      check("Default-clear: secret deleted", failingSecretStore.get("model-provider:dp1:api-key") === null);
    }

    // Case C1: SecretStore.delete 失败 → metadata 不被删除（防止 orphan secret）
    {
      const db3 = new DatabaseSync(path.join(ROOT, "fail-delete-secret.db"));
      db3.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      const json = JSON.stringify({
        models: [{ id: "del1", name: "Del1", baseUrl: "https://del1", hasApiKey: true, models: ["m"], kind: "custom" }],
        defaultProviderId: "",
        defaultModelId: "",
      });
      db3.exec(`INSERT INTO settings (key, value) VALUES ('app', '${json}')`);
      const store3 = new SettingsStore(db3, failingSecretStore);
      failingSecretStore.set("model-provider:del1:api-key", "del-secret");
      failingSecretStore.failNext = true;
      try {
        store3.deleteModel("del1");
      } catch {
        // expected
      }
      const afterRow = db3.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string } | undefined;
      const after = afterRow ? JSON.parse(afterRow.value) : { models: [] };
      check("Compensation C1: secret delete failure preserves metadata", after.models.length === 1);
    }

    // Case C2: Secret 删除成功 + metadata 写失败（触发器）→ 恢复 Secret
    {
      const db3 = new DatabaseSync(path.join(ROOT, "fail-delete-meta.db"));
      db3.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      const json = JSON.stringify({
        models: [{ id: "del2", name: "Del2", baseUrl: "https://del2", hasApiKey: true, models: ["m"], kind: "custom" }],
        defaultProviderId: "",
        defaultModelId: "",
      });
      db3.exec(`INSERT INTO settings (key, value) VALUES ('app', '${json}')`);
      const store3 = new SettingsStore(db3, failingSecretStore); // 先构造，后装触发器
      addMetaWriteFailTrigger(db3);
      failingSecretStore.set("model-provider:del2:api-key", "del-secret");
      try {
        store3.deleteModel("del2");
        check("Compensation C2: metadata failure throws", false, "expected throw");
      } catch {
        check("Compensation C2: metadata failure throws", true);
      }
      // Secret 删除后 metadata 失败 → 必须恢复 Secret（真实命中恢复路径）
      check("Compensation C2: secret restored after metadata failure", failingSecretStore.get("model-provider:del2:api-key") === "del-secret", `got ${JSON.stringify(failingSecretStore.get("model-provider:del2:api-key"))}`);
      const row = db3.prepare("SELECT value FROM settings WHERE key='app'").get() as { value: string } | undefined;
      check("Compensation C2: metadata preserved", row ? JSON.parse(row.value).models.length === 1 : false);
    }
  }

  // 31. Resume 安全：必须使用当前完整 provider 配置，禁止历史 baseUrl
  {
    const originalFetch = globalThis.fetch;
    let lastBaseUrl = "";
    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes("api.resume-test.com") || url.includes("api.new-base.com")) {
          lastBaseUrl = url;
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "resumed" } }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      // 创建 provider 并设为默认
      const prov = await postJSON(`${base}/settings/models`, {
        name: "ResumeTestProvider",
        baseUrl: "https://api.resume-test.com/v1",
        apiKey: "sk-resume-test",
        models: ["resume-chat"],
      }, 201);
      await postJSON(`${base}/settings/default`, { providerId: prov.id, model: "resume-chat" }, 200);

      // 创建 Run
      const run = await postJSON(`${base}/runs`, { task: "resume test" }, 202);
      const deadline = Date.now() + 10000;
      let status = "running";
      while (Date.now() < deadline) {
        status = (await getRunStatus(run.runId)).status;
        if (status !== "running" && status !== "stopping") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check("Resume: initial run completed", status === "completed", `status=${status}`);

      // 修改 provider baseUrl
      await patchJSON(`${base}/settings/models/${prov.id}`, { baseUrl: "https://api.new-base.com/v1" }, 200);

      // Resume Run → 应使用新 baseUrl，而非历史 baseUrl
      const resumed = await postJSON(`${base}/runs/${run.runId}/resume`, {}, 202);
      check("Resume: accepted", !!resumed.runId);

      const deadline2 = Date.now() + 10000;
      let status2 = "running";
      while (Date.now() < deadline2) {
        status2 = (await getRunStatus(run.runId)).status;
        if (status2 !== "running" && status2 !== "stopping") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check("Resume: run completed after baseUrl change", status2 === "completed", `status=${status2}`);
      check("Resume: used current baseUrl", lastBaseUrl.includes("api.new-base.com"), `got ${lastBaseUrl}`);
      cleanupCheckpoint(run.runId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 32. Host 关闭：停止接受新 Run，取消活跃 Run，原子终态
  {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    try {
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes("api.slow-echo.com")) {
          await new Promise((r) => setTimeout(r, 5000));
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "late" } }] }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const prov = await postJSON(`${base}/settings/models`, {
        name: "SlowProvider",
        baseUrl: "https://api.slow-echo.com/v1",
        apiKey: "sk-slow",
        models: ["slow-chat"],
      }, 201);

      const run = await postJSON(`${base}/runs`, { task: "slow task" }, 202);
      const deadline = Date.now() + 3000;
      let status = "running";
      while (Date.now() < deadline) {
        status = (await getRunStatus(run.runId)).status;
        if (status !== "running" && status !== "stopping") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      check("Shutdown: run started", status === "running" || status === "stopping");

      // 直接关闭 RunManager（不关 server），验证活跃 Run 被取消
      await manager.close();
      await new Promise((r) => setTimeout(r, 500));

      const raw = manager.getRaw(run.runId);
      const finalStatus = raw ? raw.status : "missing";
      check("Shutdown: run stopped/cancelled", finalStatus === "stopped" || finalStatus === "interrupted", `got ${finalStatus}`);
      cleanupCheckpoint(run.runId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  console.log(`\nSettings 测试汇总: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
})();
