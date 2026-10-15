// 模块: settings 测试共享 harness — Host 服务器 + HTTP 断言助手 + PASS/FAIL 计数收尾
// 用法: import { check, getJSON, postJSON, reportAndExit, ... } from './helpers/settings-harness.js';
//       tests/settings-*.test.ts 各套件（Provider CRUD / 默认模型 / Keychain 契约 / legacy 迁移 /
//       能力预算 / Run 生命周期）共用：确定性环境（SecretStore = Memory，无真实网络），
//       每个套件独立子进程各自持有一份服务器与临时库。
// 来源: 自原 tests/settings.test.ts（1672 行）按测试域拆分时抽出，函数签名与原文件保持一致。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createDefaultRunStore } from '../../src/host/persistence/sqlite-store.js';
import { RunManager } from '../../src/host/run-manager.js';
import { MemorySecretStore } from '../../src/host/secrets/secret-store.js';
import { createHostServer } from '../../src/host/server.js';
import { checkpointPath } from '../../src/persistence/file-checkpoint-store.js';

export const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-settings-test-'));
process.env.SANDBOX_ROOT = ROOT;
process.env.PAYASO_DB_PATH = path.join(ROOT, 'payaso.db');
fs.mkdirSync(ROOT, { recursive: true });

// SecretStore 注入 Memory 实现：确定性测试绝不触碰用户本机 Keychain
export const secretStore = new MemorySecretStore();
export const store = createDefaultRunStore(secretStore);
export const manager = new RunManager(store);
export const TEST_TOKEN = 'test-token-00000000000000000000000000000000';
const server = createHostServer(manager, TEST_TOKEN);
await new Promise<void>((r) => server.listen(0, () => r()));
export const port = (server.address() as { port: number }).port;
export const base = `http://127.0.0.1:${port}`;

let passed = 0,
  failed = 0;
export function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

export async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

export async function getRunStatus(runId: string): Promise<{ status: string }> {
  const body = await (
    await fetch(`${base}/runs/${runId}`, { headers: await authHeaders() })
  ).json();
  return { status: body.status };
}
export function cleanupCheckpoint(runId: string): void {
  fs.rmSync(checkpointPath(runId), { force: true });
}

export async function getJSON(url: string, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, { headers: await authHeaders() });
  const text = await res.text().catch(() => '');
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

export async function postJSON(url: string, body: any, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
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

export async function patchJSON(url: string, body: any, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
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

export async function delJSON(url: string, expectedStatus = 200): Promise<any> {
  const res = await fetch(url, { method: 'DELETE', headers: await authHeaders() });
  const text = await res.text().catch(() => '');
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

export async function postJSONWithOrigin(
  url: string,
  body: any,
  origin: string,
): Promise<{ status: number }> {
  const u = new URL(url);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const client = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      const headers = [
        `POST ${u.pathname} HTTP/1.1`,
        `Host: ${u.host}`,
        `Origin: ${origin}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(payload)}`,
        'Connection: close',
        '',
        payload,
      ].join('\r\n');
      client.write(headers);
    });
    const chunks: Buffer[] = [];
    client.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
    });
    client.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const match = raw.match(/HTTP\/\d\.\d (\d+)/);
      console.log(`[raw request] status=${match ? match[1] : '?'} raw=${raw.slice(0, 200)}`);
      resolve({ status: match ? parseInt(match[1], 10) : 0 });
    });
    client.on('error', reject);
  });
}

/** 收尾：打印汇总行并按失败数决定退出码（与原 settings.test.ts 的 runner 约定一致）。 */
export function reportAndExit(): never {
  console.log(`\nSettings 测试汇总: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
}
