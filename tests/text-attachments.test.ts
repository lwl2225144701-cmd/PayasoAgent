// 消息文本附件：校验、真实文件工具链、历史与压缩引用、下载及隔离副本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemorySecretStore } from '../src/host/secrets/secret-store.js';
import { RunManager } from '../src/host/run-manager.js';
import { SqliteRunStore } from '../src/host/persistence/sqlite-store.js';
import { requestAttachments } from '../src/host/routes/route-context.js';
import { prepareAttachments } from '../src/host/attachments/normalize.js';
import { extractPdfText } from '../src/host/attachments/pdf.js';
import { writeAttachmentFile, publishAttachments } from '../src/host/attachments/publish.js';
import { getAttachmentStoreRoot, restoreAttachment, putAttachmentObject } from '../src/attachments/store.js';
import { DefaultContextHarness } from '../src/harness/context-harness.js';
import { needsExtractionRefresh } from '../src/host/attachments/refresh-extraction.js';
import { EXTRACTOR_VERSION } from '../src/host/attachments/extraction-version.js';
import {
  createAgentExecutionContext,
  createDefaultRuntimeServices,
} from '../src/bootstrap/runtime-bootstrap.js';
import { createScratchpad } from '../src/runtime/scratchpad.js';
import { runAgent } from '../src/runtime/agent.js';
import { loadCheckpoint } from '../src/persistence/file-checkpoint-store.js';
import { silentRuntimeObserver } from '../src/runtime/observer-port.js';
import { readDownloadChecked } from '../src/host/routes/static-handler.js';
import { attachmentKind, MAX_OFFICE_BYTES, MAX_TEXT_BYTES } from '../src/attachment-policy.js';
import { attachmentManifest } from '../src/harness/attachment-manifest.js';
import { deflateRawSync } from 'node:zlib';
import type { ChatMessage } from '../src/llm/llm.js';

// 手工拼一个最小 zip（docx/pptx/xlsx 共用）：局部头 + deflate 条目 + 中央
// 目录 + EOCD，不依赖任何 zip 库，字段布局与 attachment-zip.ts 的解析一一对应。
function buildZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [nameStr, content] of Object.entries(entries)) {
    const name = Buffer.from(nameStr, 'utf8');
    const data = deflateRawSync(Buffer.from(content, 'utf8'));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(content), 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(content), 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); // 局部头偏移
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function buildMinimalDocx(documentXml: string, opts: { skipDocument?: boolean } = {}): Buffer {
  return opts.skipDocument ? buildZip({}) : buildZip({ 'word/document.xml': documentXml });
}

// 最小 PDF：单个 FlateDecode 文本流。content 是 BT…ET 文本对象里的指令。
function buildPdf(content: string): Buffer {
  const stream = deflateRawSync(Buffer.from(`BT /F1 12 Tf 72 720 Td ${content} ET`, 'latin1'));
  return Buffer.concat([
    Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n<< /Length ' +
        stream.length +
        ' /Filter /FlateDecode >>\nstream\n',
      'latin1',
    ),
    stream,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1'),
  ]);
}

// 含 Type0 + ToUnicode 的最小中文 PDF：builtin 快路径遇 /Type0 抛 Unsupported，
// pdfjs 兜底用 ToUnicode CMap 把 CID <0001><0002> 映射为「你好」。
function buildCjkPdf(): Buffer {
  const content = 'BT /F1 12 Tf 72 720 Td <0001 0002> Tj ET\n';
  const toUnicode = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <4F60>
<0002> <597D>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /CIDToGIDMap /Identity /W [0 [600]] >>',
    `<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`,
    '<< /Type /FontDescriptor /FontName /TestFont /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// WinAnsiEncoding + 十六进制高位字节文本：内建逐字节解出 C1 控制字符（不可读），
// pdfjs 按编码表解出 Š/Œ/Ž —— 复刻真实故障「无 ToUnicode 字体子集」的最小夹具。
function buildGarbageFontPdf(): Buffer {
  const content = 'BT /F1 12 Tf 72 720 Td <8A 8C 8E 41 42> Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payaso-text-att-'));
process.env.PAYASO_HOME = root;
process.env.PAYASO_ATTACHMENT_STORE = path.join(root, 'objects-store');
process.env.PAYASO_CHECKPOINT_DIR = path.join(root, 'checkpoints');
const ws = path.join(root, 'workspace');
fs.mkdirSync(ws);
const originalFetch = globalThis.fetch;
let checks = 0;
function check(ok: unknown) {
  assert.ok(ok);
  checks++;
}
const input = (name: string, bytes: Buffer, mimeType = '') => ({
  name,
  mimeType,
  dataBase64: bytes.toString('base64'),
});
try {
  const bytes = Buffer.from('{"compilerOptions":{"target":"ATTACHMENT_SENTINEL_47"}}');
  const parsed = requestAttachments({ attachments: [input('配置.json', bytes)] });
  const prepared = await prepareAttachments(parsed);
  check(prepared[0].mimeType === 'text/plain');
  check(Buffer.from(prepared[0].dataBase64, 'base64').equals(bytes));
  check(attachmentKind('AGENTS.md', '') === 'text');
  for (const name of ['archive.zip', 'program.exe', 'schema.bin']) {
    assert.throws(() => requestAttachments({ attachments: [input(name, bytes)] }));
    checks++;
  }
  for (const [name, expected] of [
    ['a.docx', 'docx'],
    ['a.pptx', 'pptx'],
    ['a.xlsx', 'xlsx'],
    ['a.pdf', 'pdf'],
    ['a.doc', 'binary'],
    ['a.ppt', 'binary'],
  ] as const) {
    check(attachmentKind(name, '') === expected);
  }
  assert.throws(() =>
    requestAttachments({ attachments: [input('a.txt', Buffer.alloc(MAX_TEXT_BYTES + 1))] }),
  );
  checks++;
  assert.throws(() =>
    requestAttachments({ attachments: [{ name: 'a.txt', mimeType: '', dataBase64: 'YR==' }] }),
  );
  checks++;
  assert.throws(() =>
    requestAttachments({ attachments: Array.from({ length: 5 }, () => input('a.txt', bytes)) }),
  );
  checks++;
  for (const invalid of [Buffer.from([0xff, 0xfe, 0x41]), Buffer.from('a\0b')]) {
    await assert.rejects(
      prepareAttachments(requestAttachments({ attachments: [input('bad.txt', invalid)] })),
    );
    checks++;
  }
  await prepareAttachments(
    requestAttachments({ attachments: [input('bom.txt', Buffer.from('\ufeff中文'))] }),
  );
  checks++;
  await prepareAttachments(
    requestAttachments({ attachments: [input('broken.json', Buffer.from('{'))] }),
  );
  checks++;
  const saved = writeAttachmentFile({
    workspaceRoot: ws,
    directory: 'input/attachments',
    fileName: 'config.json',
    dataBase64: prepared[0].dataBase64,
    independentCopy: true,
  });
  const duplicate = writeAttachmentFile({
    workspaceRoot: ws,
    directory: 'input/attachments',
    fileName: 'config.json',
    dataBase64: prepared[0].dataBase64,
    independentCopy: true,
  });
  check(saved.relPath !== duplicate.relPath);
  const empty = await prepareAttachments(
    requestAttachments({ attachments: [input('empty.txt', Buffer.alloc(0))] }),
  );
  const emptySaved = writeAttachmentFile({
    workspaceRoot: ws,
    directory: 'input/attachments',
    fileName: 'empty.txt',
    dataBase64: empty[0].dataBase64,
    independentCopy: true,
  });
  check(fs.statSync(path.join(ws, emptySaved.relPath)).size === 0);
  const object = path.join(
    getAttachmentStoreRoot(),
    'objects',
    saved.sha256.slice(0, 2),
    saved.sha256,
  );
  const local = path.join(ws, saved.relPath);
  check(fs.statSync(object).ino !== fs.statSync(local).ino);
  fs.chmodSync(local, 0o600);
  fs.writeFileSync(local, 'changed');
  check(fs.readFileSync(object).equals(bytes));
  restoreAttachment(ws, saved.relPath, saved.sha256);
  check(fs.readFileSync(local, 'utf8') === 'changed');
  fs.unlinkSync(local);
  restoreAttachment(ws, saved.relPath, saved.sha256);

  // ---- .docx：zip 解包 + word/document.xml 文本提取（原件不变，prepare 单独提取正文）----
  check(attachmentKind('方案补充.docx', '') === 'docx');
  check(attachmentKind('legacy.doc', '') === 'binary'); // 旧版 .doc 走二进制原样通道
  const documentXml =
    '<w:document><w:body><w:p><w:r><w:t>DOCX_SENTINEL_91</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p></w:body></w:document>';
  const docx = buildMinimalDocx(documentXml);
  const preparedDocx = await prepareAttachments(
    requestAttachments({ attachments: [input('方案补充.docx', docx)] }),
  );
  check(Buffer.from(preparedDocx[0].dataBase64, 'base64').equals(docx));
  const docxText = preparedDocx[0].extraction!.text!;
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
  const tableText = (
    await prepareAttachments(
      requestAttachments({ attachments: [input('表格.docx', buildMinimalDocx(tableXml))] }),
    )
  )[0].extraction!.text!;
  check(tableText === '字段\t类型\nchunk_id\t\n');
  // 回归：mc:Fallback（同内容的 VML 降级副本）只提取一次
  const fallbackXml =
    '<w:p><mc:AlternateContent><mc:Choice><w:r><w:t>唯一内容</w:t></w:r></mc:Choice>' +
    '<mc:Fallback><w:r><w:t>唯一内容</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>';
  const fallbackText = (
    await prepareAttachments(
      requestAttachments({ attachments: [input('去重.docx', buildMinimalDocx(fallbackXml))] }),
    )
  )[0].extraction!.text!;
  check(fallbackText === '唯一内容\n');
  check(fallbackText.split('唯一内容').length - 1 === 1);
  // 无法提取保留原件并报告失败；超限上传拒绝
  check(
    (
      await prepareAttachments(
        requestAttachments({
          attachments: [input('假.docx', Buffer.from('PK\u0003\u0004 not a zip at all'))],
        }),
      )
    )[0].extraction?.status === 'failed',
  );
  check(
    (
      await prepareAttachments(
        requestAttachments({
          attachments: [input('空.docx', buildMinimalDocx('', { skipDocument: true }))],
        }),
      )
    )[0].extraction?.status === 'failed',
  );
  assert.throws(() =>
    requestAttachments({ attachments: [input('大.docx', Buffer.alloc(MAX_OFFICE_BYTES + 1))] }),
  );
  checks++;

  // ---- .pptx：zip 解包 + slideN.xml 的 <a:t> 文本，按幻灯片分节 ----
  const pptx = buildZip({
    'ppt/slides/slide1.xml':
      '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>PPTX_标题一</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide2.xml':
      '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第二页要点</a:t></a:r></a:p><a:p><a:r><a:t>另起一行</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  });
  const pptxText = (
    await prepareAttachments(requestAttachments({ attachments: [input('汇报.pptx', pptx)] }))
  )[0].extraction!.text!;
  check(pptxText.includes('--- 幻灯片 1 ---'));
  check(pptxText.includes('PPTX_标题一'));
  check(pptxText.includes('--- 幻灯片 2 ---'));
  check(pptxText.includes('第二页要点\n另起一行'));
  check(!pptxText.includes('<a:'));

  // ---- .xlsx：共享串 + 各 sheet 还原 TSV（空列占位保持对齐） ----
  const xlsx = buildZip({
    'xl/sharedStrings.xml':
      '<sst><si><t>字段</t></si><si><r><t>值</t></r></si><si><t>行二字段</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="D2"><v>跳过C列</v></c></row>' +
      '</sheetData></worksheet>',
  });
  const xlsxText = (
    await prepareAttachments(requestAttachments({ attachments: [input('清单.xlsx', xlsx)] }))
  )[0].extraction!.text!;
  check(xlsxText.includes('--- Sheet 1 ---'));
  check(xlsxText.includes('字段\t值'));
  check(xlsxText.includes('行二字段\t42\t\t跳过C列'));

  // ---- .pdf：FlateDecode 流 Tj 文本提取；无法提取时记录失败，不创建占位正文 ----
  const pdfText = (
    await prepareAttachments(
      requestAttachments({ attachments: [input('文档.pdf', buildPdf('(Hello PDF world) Tj'))] }),
    )
  )[0].extraction!.text!;
  check(pdfText.includes('Hello PDF world'));
  const scanned = (
    await prepareAttachments(
      requestAttachments({
        attachments: [input('扫描.pdf', buildPdf('0 0 1 rg 10 10 100 100 re f'))],
      }),
    )
  )[0].extraction!.text!;
  check(scanned === undefined);
  check(
    (
      await prepareAttachments(
        requestAttachments({ attachments: [input('假.pdf', Buffer.from('not a pdf'))] }),
      )
    )[0].extraction?.status === 'failed',
  );

  // 原件下载字节不变，正文独立 .txt；续聊清单同时保留原件与正文引用。
  const publishedDoc = publishAttachments(ws, 'document-test', preparedDocx).views[0];
  const downloadedDoc = readDownloadChecked(ws, publishedDoc.path);
  check(downloadedDoc.ok && downloadedDoc.buffer.equals(docx));
  check(publishedDoc.extraction?.path?.endsWith('.txt'));
  check(
    fs
      .readFileSync(path.join(ws, publishedDoc.extraction!.path!), 'utf8')
      .includes('DOCX_SENTINEL_91'),
  );
  check(
    attachmentManifest([
      publishedDoc as import('../src/attachment-types.js').TextAttachmentRef,
    ]).includes(publishedDoc.extraction!.path!),
  );
  for (const item of [publishedDoc, publishedDoc.extraction!]) {
    const filePath = path.join(ws, item.path!);
    fs.unlinkSync(filePath);
    restoreAttachment(ws, item.path!, item.sha256!);
    check(fs.existsSync(filePath));
  }
  const beforeFailedPublish = fs.readdirSync(path.join(ws, 'input/attachments')).sort();
  assert.throws(() =>
    publishAttachments(ws, 'failed-batch', [
      preparedDocx[0],
      { name: 'empty.png', mimeType: 'image/png', dataBase64: '' },
    ]),
  );
  checks++;
  check(
    JSON.stringify(fs.readdirSync(path.join(ws, 'input/attachments')).sort()) ===
      JSON.stringify(beforeFailedPublish),
  );

  const rawPdf = Buffer.from(
    '%PDF-1.4\n<< /Length 33 >>\nstream\nBT (Uncompressed sentinel) Tj ET\nendstream',
  );
  const rawPrepared = (await prepareAttachments([input('plain.pdf', rawPdf)]))[0];
  check(rawPrepared.extraction?.text === 'Uncompressed sentinel');
  check(rawPrepared.extraction?.status === 'partial');
  check(rawPrepared.extraction?.message?.includes('pdf-official'));
  check(rawPrepared.extraction?.message?.includes('若工作区提供'));
  const mappedPdf = (
    await prepareAttachments([input('mapped.pdf', Buffer.from('%PDF-1.4 /Type0 /ToUnicode'))])
  )[0];
  check(mappedPdf.extraction?.status === 'failed');
  check(mappedPdf.extraction?.message?.includes('pdf-official'));
  check(mappedPdf.extraction?.message?.includes('原件已保留'));
  check(Buffer.from(mappedPdf.dataBase64, 'base64').toString() === '%PDF-1.4 /Type0 /ToUnicode');
  // 中文 PDF（Type0 + ToUnicode）：builtin 抛 Unsupported → pdfjs 兜底提取出中文
  const cjkPdf = (await prepareAttachments([input('cjk.pdf', buildCjkPdf())]))[0];
  check(cjkPdf.extraction?.status === 'partial');
  check(cjkPdf.extraction?.text?.includes('你好'));
  // 无 ToUnicode 字体子集：builtin 逐字节解出 C1 乱码（曾以 partial 落盘二进制 .txt），
  // 乱码闸门判定能力不足 → pdfjs 按 WinAnsiEncoding 解出真实文本。
  const garbageFontPdf = (await prepareAttachments([input('garbage.pdf', buildGarbageFontPdf())]))[0];
  check(garbageFontPdf.extraction?.status === 'partial');
  check(garbageFontPdf.extraction?.text === 'ŠŒŽAB');
  // 超时保护：Run 创建路径上的附件提取不得被畸形/超复杂 PDF 挂死（1ms 预算必超时）。
  {
    const previous = process.env.PAYASO_PDF_EXTRACT_TIMEOUT_MS;
    process.env.PAYASO_PDF_EXTRACT_TIMEOUT_MS = '1';
    try {
      const timeoutError = await extractPdfText(buildCjkPdf()).then(
        () => null,
        (err: Error) => err,
      );
      check(timeoutError !== null && /超时/.test(timeoutError.message));
      // 超时错误是结构化 TimeoutAbortError：不冒充「引擎能力不足」，不会触发回退死循环。
      check((timeoutError as { name?: string } | null)?.name === 'TimeoutAbortError');
    } finally {
      if (previous === undefined) delete process.env.PAYASO_PDF_EXTRACT_TIMEOUT_MS;
      else process.env.PAYASO_PDF_EXTRACT_TIMEOUT_MS = previous;
    }
  }
  const oversizedXml = buildMinimalDocx('a'.repeat(9 * 1024 * 1024));
  const boundedDoc = (await prepareAttachments([input('large.docx', oversizedXml)]))[0];
  check(boundedDoc.extraction?.status === 'failed');
  check(boundedDoc.extraction?.message?.includes('超限'));
  const largePdf = Buffer.alloc(9 * 1024 * 1024);
  fs.writeFileSync(path.join(ws, 'large.pdf'), largePdf);
  const downloadLarge = readDownloadChecked(ws, 'large.pdf');
  check(downloadLarge.ok && downloadLarge.buffer.equals(largePdf));

  // ---- .doc/.ppt：旧版二进制原样保留（mimeType 透传，字节不变） ----
  const docBytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
  const docPrepared = await prepareAttachments(
    requestAttachments({ attachments: [input('旧方案.doc', docBytes, 'application/msword')] }),
  );
  check(docPrepared[0].mimeType === 'application/msword');
  check(Buffer.from(docPrepared[0].dataBase64, 'base64').equals(docBytes));
  check(
    attachmentManifest([{ name: '旧方案.doc', path: 'x.doc', kind: 'binary' }]).includes(
      '二进制附件',
    ),
  );
  check(
    attachmentManifest([{ name: 'a.txt', path: 'a.txt', kind: 'text' }]).includes('文本用 read'),
  );
  check(
    attachmentManifest([
      {
        name: 'plain.pdf',
        path: 'plain.pdf',
        kind: 'binary',
        extraction: { status: 'partial', path: 'plain.txt' },
      },
    ]).includes('pdf-official'),
  );
  check(fs.readFileSync(local).equals(bytes));
  check(readDownloadChecked(ws, saved.relPath).ok);
  check(!readDownloadChecked(ws, '../objects-store').ok);
  fs.symlinkSync(root, path.join(ws, 'escape'));
  check(!readDownloadChecked(ws, 'escape/objects-store').ok);
  assert.throws(() => restoreAttachment(ws, 'escape/nope.txt', saved.sha256));
  checks++;

  const ref = {
    name: '配置.json',
    path: saved.relPath,
    sizeBytes: bytes.length,
    sha256: saved.sha256,
  };
  const harness = new DefaultContextHarness({
    permissionMode: 'read-only',
    model: 'attachment-test',
  });
  harness.setTextAttachments([ref, { ...publishedDoc, kind: 'binary' }]);
  const transcript = harness.createTranscript('检查附件');
  check(transcript.at(-1)?.content.includes(saved.relPath));
  check(!transcript.at(-1)?.content.includes('ATTACHMENT_SENTINEL_47'));
  check(transcript.at(-1)?.images === undefined);
  const historyHarness = new DefaultContextHarness({
    permissionMode: 'read-only',
    model: 'attachment-test',
  });
  const history = historyHarness.createTranscript('继续检查', [
    ...transcript,
    { role: 'assistant', content: 'done' },
  ]);
  check(history[1].textAttachments?.[0].sha256 === saved.sha256);
  historyHarness.restoreState({
    conversationSummary: '已看过配置',
    summarizedMessageCount: 2,
    plan: { revision: 0, items: [] },
  });
  const view = await historyHarness.prepareTurn(history, createScratchpad('继续检查'), []);
  check(
    view.messages.some(
      (message) => message.role === 'user' && message.content.includes(saved.relPath),
    ),
  );

  check(view.messages.some((message) => message.content.includes(publishedDoc.extraction!.path!)));
  check(history[1].textAttachments?.[1].extraction?.sha256 === publishedDoc.extraction?.sha256);

  // 模型替身只根据附件清单发 read，第二轮必须收到真实文件工具结果。
  let calls = 0;
  const seen: ChatMessage[][] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body.messages);
    const readPath = calls === 0 ? saved.relPath : publishedDoc.extraction!.path;
    const message =
      calls++ < 2
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: `read-${calls}`,
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ path: readPath }) },
              },
            ],
          }
        : { role: 'assistant', content: 'ATTACHMENT_SENTINEL_47' };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const result = await runAgent('读取上传配置', undefined, {
    executionContext: createAgentExecutionContext({
      runId: 'text-attachment-run',
      workspaceRoot: ws,
      permissionMode: 'read-only',
    }),
    ...createDefaultRuntimeServices(),
    observer: silentRuntimeObserver,
    contextHarness: harness,
    modelConfig: {
      model: 'attachment-test',
      baseUrl: 'https://attachment.test/v1',
      apiKey: 'test-only',
      vision: false,
    },
  });
  check(result === 'ATTACHMENT_SENTINEL_47');
  check(
    seen[1].some(
      (message) => message.role === 'tool' && message.content.includes('ATTACHMENT_SENTINEL_47'),
    ),
  );
  check(
    seen[2].some(
      (message) => message.role === 'tool' && message.content.includes('DOCX_SENTINEL_91'),
    ),
  );
  const checkpoint = loadCheckpoint('text-attachment-run');
  check(
    checkpoint?.messages.some((message) => message.textAttachments?.[0].sha256 === saved.sha256),
  );
  check(!JSON.stringify(checkpoint).includes(prepared[0].dataBase64));
  check(
    checkpoint?.messages.some(
      (message) => message.textAttachments?.[1].extraction?.path === publishedDoc.extraction?.path,
    ),
  );

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
        attachments: [prepared[0], preparedDocx[0]],
      });
      const started = store
        .listEvents(created.runId)
        .map(({ event }) => event)
        .find((event) => event.type === 'run_started');
      check(
        started?.type === 'run_started' &&
          started.attachments?.[1].extraction?.status === 'extracted',
      );
      check(!JSON.stringify(started).includes(docxText));
      const attachmentDir = path.join(
        root,
        'sandbox',
        'workspaces',
        created.runId,
        'input',
        'attachments',
      );
      check(fs.existsSync(attachmentDir));
      check(
        fs
          .readdirSync(attachmentDir)
          .some((file) => fs.readFileSync(path.join(attachmentDir, file)).equals(bytes)),
      );
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

  // ---- 恢复刷新：旧版本提取产物在新一轮 Run 启动时被现行逻辑重提 ----
  // 复刻真实故障：冯子微 PDF（无 ToUnicode）在乱码闸门上线前落盘了二进制 .txt，
  // 事件不可变、同会话重试只按 sha 还原旧字节 —— 修复后必须让旧会话也读到新产物。
  check(needsExtractionRefresh({ path: 'a.pdf', extraction: { status: 'partial', path: 'a.txt', extractorVersion: EXTRACTOR_VERSION } }, ws) === false);
  check(needsExtractionRefresh({ path: 'a.pdf', extraction: { status: 'failed' } }, ws) === false);
  check(needsExtractionRefresh({ path: 'a.pdf' }, ws) === false);
  check(needsExtractionRefresh({ path: 'a.pdf', extraction: { status: 'partial', path: 'a.txt' } }, ws) === true);
  check(needsExtractionRefresh({ path: 'a.pdf', extraction: { status: 'partial', path: 'a.txt', extractorVersion: '1' } }, ws) === true);
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
    const waitTerminal = async (runId: string): Promise<string | null> => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const status = manager.get(runId)?.status;
        if (status === 'completed' || status === 'failed' || status === 'stopped') return status;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return null;
    };
    try {
      const preparedGarbage = (await prepareAttachments([input('garbage.pdf', buildGarbageFontPdf())]))[0];
      const first = manager.createInSession('上传附件', undefined, {
        permissionMode: 'read-only',
        attachments: [preparedGarbage],
      });
      const firstStarted = store
        .listEvents(first.runId)
        .map(({ event }) => event)
        .find((event) => event.type === 'run_started');
      const real = firstStarted?.attachments?.[0];
      check(Boolean(real?.extraction?.path));
      check((await waitTerminal(first.runId)) === 'completed');

      // 「做旧」成修复前的状态：store 里存入 builtin 解出的乱码字节，事件引用它的
      // sha 且不带 extractorVersion —— 恢复时会按 sha 还原这段乱码。
      const legacyBytes = Buffer.from('\u008a\u008c\u008eAB', 'latin1');
      const legacyObject = putAttachmentObject(getAttachmentStoreRoot(), legacyBytes);
      const legacyRef = {
        name: real!.name,
        path: real!.path,
        sha256: real!.sha256,
        kind: 'binary' as const,
        mimeType: real!.mimeType,
        extraction: {
          status: 'partial' as const,
          path: real!.extraction!.path!,
          sha256: legacyObject.sha256,
        },
      };
      store.appendEvent(first.runId, {
        type: 'run_started',
        runId: first.runId,
        timestamp: new Date().toISOString(),
        attachments: [legacyRef],
      });

      // 第二轮同会话读取：恢复循环还原乱码后按版本重提，磁盘产物应变成现行逻辑的输出。
      // 复用会话的 workspace 是会话级（第一轮的），恢复与重提都落在那里。
      const second = manager.createInSession('再读一次', first.sessionId, {
        permissionMode: 'read-only',
      });
      check((await waitTerminal(second.runId)) === 'completed');
      const sessionWorkspace = store.getSession(first.sessionId)?.workspaceRoot ?? '';
      check(Boolean(sessionWorkspace));
      const refreshed = fs.readFileSync(path.join(sessionWorkspace, legacyRef.extraction.path), 'utf8');
      check(refreshed === 'ŠŒŽAB');
      // 刷新后保持只读语义（与其余附件文件一致，agent 不可改）。
      check((fs.statSync(path.join(sessionWorkspace, legacyRef.extraction.path)).mode & 0o222) === 0);
      // 刷新记账在宿主侧台账：同一 workspace 再判不再过期。
      check(!needsExtractionRefresh(legacyRef, sessionWorkspace));
    } finally {
      await manager.close();
    }
  }
  console.log(`text-attachments: ${checks} checks PASS`);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
