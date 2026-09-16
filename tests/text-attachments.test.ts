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
import { attachmentKind, MAX_DOCX_BYTES, MAX_TEXT_BYTES } from '../src/attachment-policy.js';
import { deflateRawSync } from 'node:zlib';
import type { ChatMessage } from '../src/llm/llm.js';

// 手工拼一个最小 docx：单条目 zip（局部头 + deflate 的 word/document.xml +
// 中央目录 + EOCD），不依赖任何 zip 库，字段布局与 attachment-docx.ts 的
// 解析一一对应。
function buildMinimalDocx(documentXml: string, opts: { skipDocument?: boolean } = {}): Buffer {
  const name = Buffer.from('word/document.xml', 'utf8');
  const data = deflateRawSync(Buffer.from(documentXml, 'utf8'));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(documentXml), 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(documentXml), 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // 局部头偏移
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(local.length + name.length + data.length, 16);
  if (opts.skipDocument) {
    // 没有任何条目的合法空 zip：EOCD 直接跟在空局部头后（仅作缺正文用例）
    return Buffer.concat([eocd]);
  }
  return Buffer.concat([local, name, data, central, name, eocd]);
}

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

  // ---- .docx：zip 解包 + word/document.xml 文本提取（prepare 阶段归一为 text/plain）----
  check(attachmentKind('方案补充.docx', '') === 'docx');
  check(attachmentKind('legacy.doc', '') === null); // 旧版二进制 .doc 不放行
  const documentXml =
    '<w:document><w:body><w:p><w:r><w:t>DOCX_SENTINEL_91</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p></w:body></w:document>';
  const docx = buildMinimalDocx(documentXml);
  const preparedDocx = await prepareAttachments(requestAttachments({ attachments: [input('方案补充.docx', docx)] }));
  check(preparedDocx[0].mimeType === 'text/plain');
  const docxText = Buffer.from(preparedDocx[0].dataBase64, 'base64').toString('utf8');
  check(docxText.includes('DOCX_SENTINEL_91'));
  check(docxText.includes('A&B\tC\nD'));
  check(docxText.startsWith('DOCX_SENTINEL_91'));
  // 回归：<w:tc>/<w:tr>/<w:tbl>/<w:type> 不得被当成 <w:t> 文本节点（曾把整段
  // 表格 XML 吞进输出 —— 模型侧表现为"表格 XML 重复膨胀 + 单元格内容缺失"）
  check(!docxText.includes('<w:'));
  const tableXml =
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>类型</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>chunk_id</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t/></w:r></w:p></w:tc></w:tr></w:tbl>';
  const tableText = Buffer.from(
    (await prepareAttachments(requestAttachments({ attachments: [input('表格.docx', buildMinimalDocx(tableXml))] })))[0].dataBase64,
    'base64',
  ).toString('utf8');
  check(tableText === '字段\t类型\nchunk_id\t\n');
  // 回归：mc:Fallback（同内容的 VML 降级副本）只提取一次
  const fallbackXml =
    '<w:p><mc:AlternateContent><mc:Choice><w:r><w:t>唯一内容</w:t></w:r></mc:Choice>' +
    '<mc:Fallback><w:r><w:t>唯一内容</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>';
  const fallbackText = Buffer.from(
    (await prepareAttachments(requestAttachments({ attachments: [input('去重.docx', buildMinimalDocx(fallbackXml))] })))[0].dataBase64,
    'base64',
  ).toString('utf8');
  check(fallbackText === '唯一内容\n');
  check(fallbackText.split('唯一内容').length - 1 === 1);
  // 非 zip 字节 / 缺正文 / 超限 / 旧 .doc 全部拒绝
  await assert.rejects(prepareAttachments(requestAttachments({ attachments: [input('假.docx', Buffer.from('PK\u0003\u0004 not a zip at all'))] })));
  await assert.rejects(prepareAttachments(requestAttachments({ attachments: [input('空.docx', buildMinimalDocx('', { skipDocument: true }))] })));
  assert.throws(() => requestAttachments({ attachments: [input('大.docx', Buffer.alloc(MAX_DOCX_BYTES + 1))] }));
  assert.throws(() => requestAttachments({ attachments: [input('旧文档.doc', bytes)] })); checks += 9;
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
