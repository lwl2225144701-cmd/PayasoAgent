// 模块: 模型配置 API 测试 — 覆盖 CRUD、Secret 隔离、校验、错误响应
// 用法: npx tsx tests/settings.test.ts（确定性，无真实网络；SecretStore = Memory）

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
const server = createHostServer(new RunManager(createDefaultRunStore(secretStore)));
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function getRunStatus(runId: string): Promise<{ status: string }> {
  const body = await (await fetch(`${base}/runs/${runId}`)).json();
  return { status: body.status };
}
function cleanupCheckpoint(runId: string): void {
  fs.rmSync(checkpointPath(runId), { force: true });
}

async function getJSON(url: string, expectedStatus = 200): Promise<any> {
  const res = await fetch(url);
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function postJSON(url: string, body: any, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function patchJSON(url: string, body: any, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  return res.status === 204 ? null : res.json();
}

async function delJSON(url: string, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, { method: "DELETE" });
  check(`${url} status ${expectedStatus}`, res.status === expectedStatus, `got ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---- 测试开始 ----

(async () => {
  // 1. 默认列表：未配置密钥的内置模板不显示（必须显示已配置的才有意义）
  let list = await getJSON(`${base}/settings/models`);
  check("GET default empty (builtin unconfigured hidden)", Array.isArray(list.models) && list.models.length === 0);

  // 1b. 内置模板入口：templateId 命中未配置内置时补齐配置（不新建记录）
  let tplAdded = await postJSON(`${base}/settings/models`, {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-template-1234",
    models: ["deepseek-chat"],
    templateId: "deepseek-chat",
  }, 201);
  check("template add keeps builtin id", tplAdded.id === "deepseek-chat");
  check("template add keeps builtin kind", tplAdded.kind === "builtin");
  check("template add has key", tplAdded.hasApiKey === true && tplAdded.apiKeyMasked === "********");
  let afterTpl = await getJSON(`${base}/settings/models`);
  check("template add visible in list", afterTpl.models.some((m: any) => m.id === "deepseek-chat" && m.hasApiKey === true));

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
  check("POST dup name 400", dupName.message === "Provider with same name or baseUrl already exists");

  // 4. 重复 baseUrl 拒绝
  let dupUrl = await postJSON(`${base}/settings/models`, {
    name: "Other",
    baseUrl: "https://api.test.com",
    apiKey: "sk-other",
    models: ["other"],
  }, 400);
  check("POST dup baseUrl 400", dupUrl.message === "Provider with same name or baseUrl already exists");

  // 5. 非法 URL 拒绝
  let badUrl = await postJSON(`${base}/settings/models`, {
    name: "Bad",
    baseUrl: "ftp://example.com",
    apiKey: "sk-bad",
    models: ["bad"],
  }, 400);
  check("POST bad url 400", badUrl.message === "baseUrl must be a valid HTTP/HTTPS URL");

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

  // 13. 内置 provider 不可删除（返回 404）
  let builtin = list.models.find((m: any) => m.kind === "builtin") ?? { id: "deepseek-chat" };
  let delBuiltinStatus = await (await fetch(`${base}/settings/models/${builtin.id}`, { method: "DELETE" })).status;
  check("DELETE builtin rejected", delBuiltinStatus === 404);

  // 14. 删除成功返回 { deleted: true }
  let deleted = await delJSON(`${base}/settings/models/${created.id}`);
  check("DELETE returns deleted:true", deleted.deleted === true);

  // 15. 删除后不存在
  let afterDel = await getJSON(`${base}/settings/models/${created.id}`, 404);
  check("GET after delete 404", afterDel.error === "not_found");

  // 16. 列表最终：已配置内置 DeepSeek + 1 个自定义 Dedup（未配置内置隐藏）
  let finalList = await getJSON(`${base}/settings/models`);
  check("final list count", finalList.models.length === 2);
  check("final list builtin count", finalList.models.filter((m: any) => m.kind === "builtin").length === 1);

  // 17. 设置默认模型：校验矩阵（未知 404 / 空 400 / 未配置密钥 400）
  let unknownDefault = await postJSON(`${base}/settings/default`, { providerId: "not-exist", model: "m" }, 404);
  check("default unknown provider 404", unknownDefault.error === "not_found");

  let emptyDefault = await postJSON(`${base}/settings/default`, { providerId: "   " }, 400);
  check("default empty providerId 400", emptyDefault.message === "providerId is required");

  let unconfiguredDefault = await postJSON(`${base}/settings/default`, { providerId: "openai-gpt4o", model: "gpt-4o" }, 400);
  check("default unconfigured builtin 400", unconfiguredDefault.message === "Provider has no API key configured");

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

  // 22. 环境配置导入：baseUrl 匹配已有 provider 时填进该 provider（不新建）
  {
    const store = new SettingsStore(new DatabaseSync(":memory:"), new MemorySecretStore());
    const imported = store.importEnvFallback({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai-env-5678",
      model: "gpt-4o",
    });
    check("env import matched builtin", imported?.providerId === "openai-gpt4o" && imported.modelId === "gpt-4o");
    const openai = store.listViews().find(p => p.id === "openai-gpt4o");
    check("env import filled builtin key", !!openai && openai.hasApiKey && openai.apiKeyMasked === "********");
    check("env import kept builtin catalog", !!openai && openai.models.includes("gpt-4o") && openai.models.length >= 4);
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
        { baseUrl: touch.baseUrl, providerId: touch.id },
        200,
      );
      check("available-models via providerId", JSON.stringify(viaProvider.models) === JSON.stringify(["touch-max", "touch-pro"]));

      // 未配置密钥的 provider 且不传 apiKey → 400；缺 baseUrl → 400
      let noKey = await postJSON(`${base}/settings/available-models`, { baseUrl: "https://api.stepfun.com/v1", providerId: "stepfun-step" }, 400);
      check("available-models without key 400", noKey.message === "no API key available for this provider");
      let noUrl = await postJSON(`${base}/settings/available-models`, { providerId: touch.id }, 400);
      check("available-models without baseUrl 400", noUrl.message === "baseUrl is required");
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
    const runJson = JSON.stringify(await (await fetch(`${base}/runs/${runId12}`)).json());
    const eventsText = await (await fetch(`${base}/runs/${runId12}/events?live=0`)).text();
    const settingsAll = JSON.stringify(await (await fetch(`${base}/settings/models`)).json());
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

  console.log(`\nSettings 测试汇总: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
})();
