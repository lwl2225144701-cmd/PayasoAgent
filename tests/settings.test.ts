// 模块: 模型配置 API 测试 — 覆盖 CRUD、脱敏、校验、错误响应
// 用法: npm run test:host （复用 host 测试的 server 启动方式）

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHostServer } from "../src/host/server.js";
import { createWorkspace, getSandboxRoot } from "../src/sandbox/sandbox-manager.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-settings-test-"));
process.env.SANDBOX_ROOT = ROOT;
process.env.PAYASO_DB_PATH = path.join(ROOT, "payaso.db");
fs.mkdirSync(ROOT, { recursive: true });

const server = createHostServer();
await new Promise<void>((r) => server.listen(0, () => r()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
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
  // 1. 空列表
  let list = await getJSON(`${base}/settings/models`);
  check("GET empty list", Array.isArray(list.models) && list.models.length === 0);

  // 2. 创建 provider
  let created = await postJSON(`${base}/settings/models`, {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-abcdef1234567890",
    models: ["deepseek-chat", "deepseek-reasoner"],
  }, 201);
  check("POST created has id", typeof created.id === "string" && created.id.length > 0);
  check("POST created name", created.name === "DeepSeek");
  check("POST created apiKeyMasked", created.apiKeyMasked === "****7890");
  check("POST created hasApiKey", created.hasApiKey === true);
  check("POST created models", created.models.length === 2);
  check("POST created status", created.status === "unchecked");

  // 3. 重复 name 拒绝
  let dupName = await postJSON(`${base}/settings/models`, {
    name: "DeepSeek",
    baseUrl: "https://api.other.com",
    apiKey: "sk-other",
    models: ["other"],
  }, 400);
  check("POST dup name 400", dupName.message === "Provider with same name or baseUrl already exists");

  // 4. 重复 baseUrl 拒绝
  let dupUrl = await postJSON(`${base}/settings/models`, {
    name: "Other",
    baseUrl: "https://api.deepseek.com",
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
    name: "DeepSeek Updated",
  });
  check("PATCH name updated", updated.name === "DeepSeek Updated");
  check("PATCH apiKey unchanged", updated.apiKeyMasked === "****7890" && updated.hasApiKey === true);

  // 9. 更新清除 apiKey（传 null）
  let cleared = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: null,
  });
  check("PATCH apiKey cleared", cleared.apiKeyMasked === "****" && cleared.hasApiKey === false);

  // 10. 更新替换 apiKey
  let replaced = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: "new-key-9999",
  });
  check("PATCH apiKey replaced", replaced.apiKeyMasked === "****9999" && replaced.hasApiKey === true);

  // 11. 空字符串 apiKey 拒绝
  let emptyKey = await patchJSON(`${base}/settings/models/${created.id}`, {
    apiKey: "   ",
  }, 400);
  check("PATCH empty apiKey 400", emptyKey.message === "apiKey must be non-empty or null");

  // 12. 非法 UUID 拒绝
  let badId = await getJSON(`${base}/settings/models/not-a-uuid`, 400);
  check("GET bad id 400", badId.message === "invalid_model_id");

  let badIdPatch = await patchJSON(`${base}/settings/models/not-a-uuid`, { name: "x" }, 400);
  check("PATCH bad id 400", badIdPatch.message === "invalid_model_id");

  let badIdDel = await delJSON(`${base}/settings/models/not-a-uuid`, 400);
  check("DELETE bad id 400", badIdDel.message === "invalid_model_id");

  // 13. 删除成功返回 { deleted: true }
  let deleted = await delJSON(`${base}/settings/models/${created.id}`);
  check("DELETE returns deleted:true", deleted.deleted === true);

  // 14. 删除后不存在
  let afterDel = await getJSON(`${base}/settings/models/${created.id}`, 404);
  check("GET after delete 404", afterDel.error === "not_found");

  // 15. 列表最终只剩 Dedup
  let finalList = await getJSON(`${base}/settings/models`);
  check("final list count", finalList.models.length === 1);

  console.log(`\nSettings 测试汇总: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
})();
