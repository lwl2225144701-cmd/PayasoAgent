// 消息文本附件：校验、真实文件工具链、历史与压缩引用、下载及隔离副本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { requestAttachments } from '../src/host/routes/route-context.js';
import { prepareAttachments } from '../src/runtime/attachment-normalize.js';
import { writeAttachmentFile } from '../src/runtime/image-materialize.js';
import { getAttachmentStoreRoot, restoreTextAttachment } from '../src/runtime/attachment-store.js';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import { createAgentExecutionContext, createDefaultRuntimeServices } from '../src/bootstrap/runtime-bootstrap.js';
import { createScratchpad } from '../src/runtime/scratchpad.js';
import { runAgent } from '../src/runtime/agent.js';
import { loadCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import { readDownloadChecked } from '../src/host/routes/static-handler.js';
import { attachmentKind, MAX_TEXT_BYTES } from '../src/attachment-policy.js';
import type { ChatMessage } from '../src/llm/llm.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-text-att-'));
process.env.PAYASO_HOME = root;
process.env.PAYASO_ATTACHMENT_STORE = path.join(root, 'objects-store');
process.env.PAYASO_CHECKPOINT_DIR = path.join(root, 'checkpoints');
const ws = path.join(root, 'workspace'); fs.mkdirSync(ws);
const originalFetch = globalThis.fetch;
let checks = 0;
function check(ok: unknown) { assert.ok(ok); checks++; }
const input = (name: string, bytes: Buffer, mimeType = '') => ({ name, mimeType, dataBase64: bytes.toString('base64') });
try {
  const bytes = Buffer.from('{"compilerOptions":{"target":"ATTACHMENT_SENTINEL_47"}}');
  const parsed = requestAttachments({ attachments: [input('配置.json', bytes)] });
  const prepared = await prepareAttachments(parsed);
  check(prepared[0].mimeType === 'text/plain');
  check(Buffer.from(prepared[0].dataBase64, 'base64').equals(bytes));
  check(attachmentKind('AGENTS.md', '') === 'text');
  for (const name of ['archive.zip', 'document.pdf', 'program.exe']) {
    assert.throws(() => requestAttachments({ attachments: [input(name, bytes)] })); checks++;
  }
  assert.throws(() => requestAttachments({ attachments: [input('a.txt', Buffer.alloc(MAX_TEXT_BYTES + 1))] })); checks++;
  assert.throws(() => requestAttachments({ attachments: [{ name: 'a.txt', mimeType: '', dataBase64: 'YR==' }] })); checks++;
  assert.throws(() => requestAttachments({ attachments: Array.from({ length: 5 }, () => input('a.txt', bytes)) })); checks++;
  for (const invalid of [Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('a\0b')]) {
    await assert.rejects(prepareAttachments(requestAttachments({ attachments: [input('bad.txt', invalid)] }))); checks++;
  }
  await prepareAttachments(requestAttachments({ attachments: [input('bom.txt', Buffer.from('\ufeff中文'))] })); checks++;
  await prepareAttachments(requestAttachments({ attachments: [input('broken.json', Buffer.from('{'))] })); checks++;
  const saved = writeAttachmentFile({ workspaceRoot: ws, directory: 'input/attachments', fileName: 'config.json', dataBase64: prepared[0].dataBase64, independentCopy: true });
  const duplicate = writeAttachmentFile({ workspaceRoot: ws, directory: 'input/attachments', fileName: 'config.json', dataBase64: prepared[0].dataBase64, independentCopy: true });
  check(saved.relPath !== duplicate.relPath);
  const empty = await prepareAttachments(requestAttachments({ attachments: [input('empty.txt', Buffer.alloc(0))] }));
  const emptySaved = writeAttachmentFile({ workspaceRoot: ws, directory: 'input/attachments', fileName: 'empty.txt', dataBase64: empty[0].dataBase64, independentCopy: true });
  check(fs.statSync(path.join(ws, emptySaved.relPath)).size === 0);
  const object = path.join(getAttachmentStoreRoot(), 'objects', saved.sha256.slice(0, 2), saved.sha256);
  const local = path.join(ws, saved.relPath);
  check(fs.statSync(object).ino !== fs.statSync(local).ino);
  fs.chmodSync(local, 0o600); fs.writeFileSync(local, 'changed');
  check(fs.readFileSync(object).equals(bytes));
  restoreTextAttachment(ws, saved.relPath, saved.sha256);
  check(fs.readFileSync(local, 'utf8') === 'changed');
  fs.unlinkSync(local); restoreTextAttachment(ws, saved.relPath, saved.sha256);
  check(fs.readFileSync(local).equals(bytes));
  check(readDownloadChecked(ws, saved.relPath).ok);
  check(!readDownloadChecked(ws, '../objects-store').ok);
  fs.symlinkSync(root, path.join(ws, 'escape'));
  check(!readDownloadChecked(ws, 'escape/objects-store').ok);
  assert.throws(() => restoreTextAttachment(ws, 'escape/nope.txt', saved.sha256)); checks++;

  const ref = { name: '配置.json', path: saved.relPath, sizeBytes: bytes.length, sha256: saved.sha256 };
  const harness = new DefaultContextHarness({ permissionMode: 'read-only', model: 'attachment-test' });
  harness.setTextAttachments([ref]);
  const transcript = harness.createTranscript('检查附件');
  check(transcript.at(-1)?.content.includes(saved.relPath));
  check(!transcript.at(-1)?.content.includes('ATTACHMENT_SENTINEL_47'));
  check(transcript.at(-1)?.images === undefined);
  const historyHarness = new DefaultContextHarness({ permissionMode: 'read-only', model: 'attachment-test' });
  const history = historyHarness.createTranscript('继续检查', [...transcript, { role: 'assistant', content: 'done' }]);
  check(history[1].textAttachments?.[0].sha256 === saved.sha256);
  historyHarness.restoreState({ conversationSummary: '已看过配置', summarizedMessageCount: 2, plan: { revision: 0, items: [] } });
  const view = await historyHarness.prepareTurn(history, createScratchpad('继续检查'), []);
  check(view.messages.some((message) => message.role === 'user' && message.content.includes(saved.relPath)));

  // 模型替身只根据附件清单发 read，第二轮必须收到真实文件工具结果。
  let calls = 0;
  const seen: ChatMessage[][] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body.messages);
    const message = calls++ === 0 ? { role: 'assistant', content: '', tool_calls: [{ id: 'read-att', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: saved.relPath }) } }] } : { role: 'assistant', content: 'ATTACHMENT_SENTINEL_47' };
    return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const result = await runAgent('读取上传配置', undefined, {
    executionContext: createAgentExecutionContext({ runId: 'text-attachment-run', workspaceRoot: ws, permissionMode: 'read-only' }),
    ...createDefaultRuntimeServices(), observer: silentRuntimeObserver,
    contextHarness: harness,
    modelConfig: { model: 'attachment-test', baseUrl: 'https://attachment.test/v1', apiKey: 'test-only', vision: false },
  });
  check(result === 'ATTACHMENT_SENTINEL_47');
  check(seen[1].some((message) => message.role === 'tool' && message.content.includes('ATTACHMENT_SENTINEL_47')));
  const checkpoint = loadCheckpoint('text-attachment-run');
  check(checkpoint?.messages.some((message) => message.textAttachments?.[0].sha256 === saved.sha256));
  check(!JSON.stringify(checkpoint).includes(prepared[0].dataBase64));

  // 回归（Host 集成）：旧式 per-run 工作区要等 startAgent 才创建，而附件落盘
  // 更早 —— 默认工作区的首个带附件 Run 曾必现「workspace 根不存在或不可访问」
  // 400。这里的 PAYASO_HOME 全新，sandbox/workspaces/<runId> 必然不存在，
  // 正是线上报错的场景；createInSession 必须先建工作区再落附件。
  {
    const store = new SqliteRunStore(':memory:', new MemorySecretStore());
    const manager = new RunManager(store);
    store.addModelProvider({
      name: 'attachment-provider',
      baseUrl: 'https://attachment.test/v1',
      apiKey: 'test-only',
      models: ['attachment-test'],
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    try {
      const created = manager.createInSession('读取上传配置', undefined, {
        permissionMode: 'read-only',
        attachments: [{ name: '配置.json', mimeType: 'text/plain', dataBase64: prepared[0].dataBase64 }],
      });
      const attachmentDir = path.join(root, 'sandbox', 'workspaces', created.runId, 'input', 'attachments');
      check(fs.existsSync(attachmentDir));
      check(fs.readdirSync(attachmentDir).some((file) => fs.readFileSync(path.join(attachmentDir, file)).equals(bytes)));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const status = manager.get(created.runId)?.status;
        if (status === 'completed' || status === 'failed' || status === 'stopped') {
          check(status === 'completed');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await manager.close();
    }
  }
  console.log(`text-attachments: ${checks} checks PASS`);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
