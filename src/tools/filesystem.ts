// 模块: Sandbox 文件工具（只读 ls / read + 受控写入 write + 精确编辑 edit）
// 安全契约：LLM 只传工作区内相对路径；真实路径由 Runtime 注入的 ToolContext.workspaceRoot +
// resolveWorkspacePath / assertInsideRoot 解析与校验。
// 核心原则：模型决定读取什么，Runtime 决定在哪里执行。
// v1.5 融合身份机制：路径类工具用 canonicalPathKey 做操作 identity 归一化（不暴露宿主绝对路径）。
// v1.7：readFile→read / writeFile→write / listDir→ls 重命名，保留 hidden 别名兼容；
//       新增 edit 工具（oldText/newText 精确替换，禁止重叠，保留换行风格）。
// v1.8：read 不再限制文本大小 — 超大文本截断 + continuation hint（offset 续读）；
//       图片省略提示；其他二进制按乱码文本截断返回。

import fs from 'node:fs';
import path from 'node:path';
import { storedPermissionMode } from '../permission-mode.js';
import {
  assertInsideRoot,
  getRunWorkspaceRoot,
  resolveWorkspacePath,
} from '../sandbox/sandbox-manager.js';
import {
  type SliceBudget,
  TOOL_OUTPUT_HEAD_BYTES,
  TOOL_OUTPUT_MAX_BYTES,
  TOOL_OUTPUT_TAIL_BYTES,
  utf8ByteLength,
  utf8Head,
} from '../tool-output-budget.js';
import { register, registerAlias, type ToolContext } from './tools.js';

// 单文件读入内存的上限/单行上限（安全阈值，不是模型可见的输出预算）。
// 模型可见的输出预算统一由 tool-output-budget.ts 决定：read 自己按该预算
// 切片，Runtime guard 因此对 read 永不触发（宣称契约 == 执行契约）。
export const MAX_READ_BYTES = 64 * 1024; // 64KB

// v1.9 read 双限截断：按行号读取时，行数与字节数双限，取先到者。
const MAX_READ_LINES = 500; // 单次最多返回 500 行
const MAX_LINE_NUMBER_WIDTH = 6; // 行号列宽上限（999999 行）
// 整文件读入内存（用于按行切片）的上限；超过则退化为字节窗口读取（老路径）。
const FULL_READ_TEXT_BYTES = 2 * 1024 * 1024; // 2MB

// 读文件 [offset, offset+length) 字节范围（UTF-8 安全由调用方保证边界）。
function readFileRange(real: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(real, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// 超大文本（≥FULL_READ_TEXT_BYTES）的降级读取：字节窗口 + 字节 offset 续读。
// 与行号路径互斥——这种文件通常是无换行的压缩/数据文件，行号无意义。
function readTextByByteWindow(real: string, total: number, _rel: string, byteOffset = 0): string {
  const remaining = Math.max(0, total - byteOffset);
  const buf = readFileRange(real, byteOffset, Math.min(MAX_READ_BYTES, remaining));
  const body = buf.toString('utf8');
  const endOffset = byteOffset + buf.length;
  if (endOffset >= total) return body;
  return (
    `${body}\n[READ TRUNCATED]\n` +
    `[READ 提示] 文件共 ${total} 字节（超大文本，按字节窗口读取）。` +
    `已读至 offset=${endOffset}，剩余可用 offset=${endOffset}（字节偏移）续读。`
  ).trim();
}

// ---- 行感知输出预算切片 ----
// read 的窗口可能远大于模型可见预算（例如 500 行 × 长行）。这里按整行边界
// 保留头部 + 尾部，把中间省略掉，并给出**精确**的续读区间，使每一页都必然
// 落在预算内、且模型能逐段读完整文件（不丢内容，只分页）。
export interface NumberedWindowSlice {
  text: string;
  /** 省略的行数（0 = 未省略，仅因单行超长而字节截断） */
  omittedLines: number;
  /** 省略区间的起止行号（1-based，含）；无省略时为 0 */
  omittedFromLine: number;
  omittedToLine: number;
  /** 续读该省略区间的参数 */
  resumeOffset: number;
  resumeLimit: number;
  truncated: boolean;
}

export function sliceNumberedWindow(
  numberedLines: string[],
  startLine: number,
  budget: SliceBudget = {},
): NumberedWindowSlice {
  const maxBytes = budget.maxBytes ?? TOOL_OUTPUT_MAX_BYTES;
  const headBudget = budget.headBytes ?? TOOL_OUTPUT_HEAD_BYTES;
  const tailBudget = budget.tailBytes ?? TOOL_OUTPUT_TAIL_BYTES;
  const marker = budget.marker ?? '[READ TRUNCATED]';

  const full = numberedLines.join('\n');
  if (utf8ByteLength(full) <= maxBytes) {
    return {
      text: full,
      omittedLines: 0,
      omittedFromLine: 0,
      omittedToLine: 0,
      resumeOffset: 0,
      resumeLimit: 0,
      truncated: false,
    };
  }

  // 头部：整行累加；首个超长行允许字节截断，保证头部必有内容。
  let headCount = 0;
  let headBytes = 0;
  for (let i = 0; i < numberedLines.length; i++) {
    const lineBytes = utf8ByteLength(numberedLines[i]) + 1;
    if (i > 0 && headBytes + lineBytes > headBudget) break;
    headCount++;
    headBytes += lineBytes;
    if (headBytes > headBudget) break;
  }
  let headText = numberedLines.slice(0, headCount).join('\n');
  const headLineTruncated = headCount === 1 && utf8ByteLength(headText) > headBudget;
  if (headLineTruncated) headText = utf8Head(headText, headBudget);

  // 尾部：从末尾整行累加，且不与头部重叠。
  let tailStart = numberedLines.length;
  let tailBytes = 0;
  for (let i = numberedLines.length - 1; i >= headCount; i--) {
    const lineBytes = utf8ByteLength(numberedLines[i]) + 1;
    if (tailBytes + lineBytes > tailBudget) break;
    tailBytes += lineBytes;
    tailStart = i;
  }
  const tailText = numberedLines.slice(tailStart).join('\n');

  const omittedLines = Math.max(0, tailStart - headCount);
  const omittedFromLine = startLine + headCount;
  const omittedToLine = startLine + tailStart - 1;
  const lastLine = startLine + numberedLines.length - 1;

  const hint: string[] = [];
  if (omittedLines > 0) {
    hint.push(
      `[READ 提示] 本次窗口第 ${startLine}-${lastLine} 行共 ${numberedLines.length} 行，` +
        `受 ${maxBytes} 字节输出预算省略中间 ${omittedLines} 行（第 ${omittedFromLine}-${omittedToLine} 行）。` +
        `用 offset=${omittedFromLine} limit=${omittedLines} 续读该段；或用 grep 先定位再精读。`,
    );
  } else if (headLineTruncated) {
    hint.push(
      `[READ 提示] 第 ${startLine} 行单行超过 ${headBudget} 字节，已按字节截断显示。` +
        `可用 shell: sed -n '${startLine}p' <file> | head -c 128K 查看片段。`,
    );
  } else {
    hint.push(
      `[READ 提示] 本次窗口第 ${startLine}-${lastLine} 行超过 ${maxBytes} 字节输出预算，已保留首尾并省略中间。`,
    );
  }

  return {
    text: [headText, marker, tailText, ...hint].filter(Boolean).join('\n'),
    omittedLines,
    omittedFromLine: omittedLines > 0 ? omittedFromLine : 0,
    omittedToLine: omittedLines > 0 ? omittedToLine : 0,
    resumeOffset: omittedFromLine,
    resumeLimit: omittedLines,
    truncated: true,
  };
}

// 拒绝路径的统一脱敏消息：只回显相对路径，不泄露宿主机绝对路径
function rejectPath(rel: string): never {
  throw new Error(`路径被拒绝（仅允许工作区内相对路径，禁止穿越/绝对路径/symlink 逃逸）: ${rel}`);
}

// 解析 + 双重校验（resolvePath 字符串级 + assertInsideWorkspace 真实路径级）
// 任何逃逸（.. / 绝对路径 / symlink 指向外部）→ BLOCKED（tool_error）
function canonicalHostPath(workspaceRoot: string, input: string): string {
  const candidate = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(workspaceRoot, input);
  // Resolve every existing ancestor so paths traversing directory symlinks are
  // canonical even when the final file does not exist yet.
  let existing = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return path.join(real, ...suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw err;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function resolveAuthorizedPath(context: ToolContext, rel: string): string {
  if (storedPermissionMode(context.permissionMode) === 'full-access') {
    try {
      return canonicalHostPath(context.workspaceRoot, rel);
    } catch {
      rejectPath(rel);
    }
  }
  try {
    const real = resolveWorkspacePath(context.workspaceRoot, rel);
    assertInsideRoot(context.workspaceRoot, real);
    return real;
  } catch {
    rejectPath(rel);
  }
}

// v1.5: 归一化相对路径为稳定的 operation key（用于 getOperationKey）。
// 内部先做 resolvePath 安全解析，再剥离工作区根前缀，返回以 "/" 分隔的相对路径。
// 这样 ./work/a.txt 与 work/a.txt（含 ./ 多余段）归一化为同一 key，且不暴露宿主绝对路径。
// 若路径非法（穿越/绝对），返回 null，由调用方回退保守处理。
export function canonicalPathKey(context: ToolContext, rel: string): string | null {
  try {
    const real = resolveAuthorizedPath(context, rel);
    if (storedPermissionMode(context.permissionMode) === 'full-access') {
      return `host:${real.split(path.sep).join('/')}`;
    }
    const relKey = path.relative(context.workspaceRoot, real);
    // 统一分隔符为 "/"（跨平台稳定）；剥离头部 "./"
    const norm = relKey.split(path.sep).join('/').replace(/^\.\//, '');
    return norm === '' ? '/' : norm;
  } catch {
    return null;
  }
}

// 视觉读图用：把真实路径转成工作区相对路径（"/" 分隔）。
// full-access 下读取工作区外文件时返回 null —— 图片物化与前端预览都以
// 工作区为根，工作区外图片无法随消息传输，调用方回退文本占位。
function workspaceRelativePath(context: ToolContext, real: string): string | null {
  const relKey = path.relative(context.workspaceRoot, real);
  if (relKey.startsWith('..') || path.isAbsolute(relKey)) return null;
  const norm = relKey.split(path.sep).join('/').replace(/^\.\//, '');
  return norm === '' || norm === '..' ? null : norm;
}

// 简单二进制检测：NUL 字节或大量不可打印控制字符（UTF-8 多字节 >0x7F 不误判）
export function isProbablyBinary(buf: Buffer): boolean {
  const sample = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  let control = 0;
  for (const b of sample) {
    if (b === 0x00) return true; // NUL 字节 → 明确二进制
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++;
  }
  return control > sample.length / 10;
}

// ---- 原子写入辅助（供 write / edit 复用）----
function atomicWriteContent(real: string, content: string, rel: string): string {
  const tmp = path.join(
    path.dirname(real),
    `.${path.basename(real)}.payaso-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, real);
  } catch (_err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
    throw new Error(`写入失败: ${rel}`);
  }
  return `写入成功: ${rel}`;
}

// ---- 可写区权限（write / edit / moveFile / deleteFile 共用）----
export const MAX_WRITE_BYTES = 1024 * 1024; // 1MB

// 可写顶层目录白名单（权限规则：input/ 只读，仅 work/ 与 output/ 可写）
const WRITABLE_TOP_LEVEL = new Set(['work', 'output']);

// 权限规则的字符串级首段校验：禁止写入 input/，也禁止任何非白名单顶层目录
export function assertWritableZone(rel: string, context: ToolContext): void {
  const permissionMode = storedPermissionMode(context.permissionMode);
  if (permissionMode === 'read-only') {
    throw new Error('操作被拒绝：当前 Run 为 Read Only，禁止修改文件系统');
  }
  if (permissionMode === 'full-access') return;
  // Legacy no-Workspace mode keeps input/ read-only and work/output writable.
  // An explicitly authorized real Workspace is writable throughout its root.
  const legacyRoot = path.resolve(getRunWorkspaceRoot(context.runId));
  const activeRoot = path.resolve(context.workspaceRoot);
  if (activeRoot !== legacyRoot) return;
  const first = String(rel).split(/[\\/]+/)[0];
  if (!first || !WRITABLE_TOP_LEVEL.has(first)) {
    throw new Error(
      `路径被拒绝（仅允许写入工作区内 work/ 与 output/ 目录，禁止写入 input/）: ${rel}`,
    );
  }
}

// ---- ① ls（原 listDir）----
register({
  name: 'ls',
  description:
    '列出目录条目（名称与类型 file/directory），不递归。Read Only/Workspace Write 下 path 必须是 Workspace 相对路径；Full access 下也可使用绝对路径。',
  effect: 'read',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内相对目录路径，如 work 或 input' },
    },
    required: ['path'],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? '').trim();
    if (!rel) throw new Error('缺少参数 path');
    const real = resolveAuthorizedPath(context, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`目录不存在: ${rel}`);
    }
    if (!st.isDirectory()) throw new Error(`不是目录（路径指向文件）: ${rel}`);
    const entries = fs
      .readdirSync(real, { withFileTypes: true })
      .map((e) => {
        // 不跟随 symlink：仅列出条目本身（访问该条目时由 guardPath 拦截逃逸）
        const type = e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other';
        return { name: e.name, type };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) return `目录 ${rel} 为空`;
    return (
      `目录 ${rel} 内容（${entries.length} 项）:\n` +
      entries.map((e) => `  [${e.type}] ${e.name}`).join('\n')
    );
  },
});
registerAlias('ls', 'listDir');

// ---- ② read（文本截断 + continuation hint；图片省略；其他二进制乱码截断）----

// 图片 magic bytes 检测：JPEG / PNG / GIF / WebP / BMP，返回 kind 与 MIME
function sniffImage(buf: Buffer): { kind: string; mimeType: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'JPEG', mimeType: 'image/jpeg' };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'PNG', mimeType: 'image/png' };
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { kind: 'GIF', mimeType: 'image/gif' };
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { kind: 'WebP', mimeType: 'image/webp' };
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { kind: 'BMP', mimeType: 'image/bmp' };
  }
  return null;
}

// 视觉模型下单张图片的最大字节数（超限返回文本提示，不塞进上下文）。
const MAX_IMAGE_READ_BYTES = 8 * 1024 * 1024;

register({
  name: 'read',
  description:
    '读取文件内容，返回时每行带行号前缀（格式"行号→内容"，行号仅为定位用，不是文件内容；用 edit 复制 oldText 时请勿包含行号前缀）。默认返回前 500 行；用 offset 从指定行号续读、limit 限定本次行数。单次返回受 16KB 输出预算限制：超预算时保留首尾并在中间标注省略区间，提示中会给出精确的 offset/limit 续读参数（内容不丢失，只是分页）。图片文件：当前模型支持视觉时直接返回图片供查看分析（JPEG/PNG/GIF/WebP/BMP，≤8MB），否则返回省略提示。Read Only/Workspace Write 下仅限 Workspace；Full access 下可使用绝对路径。',
  effect: 'read',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 0);
    return `path:${key ?? JSON.stringify(rel)}:line:${offset}:${limit}`;
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内相对文件路径，如 input/demo.txt' },
      offset: {
        type: 'number',
        description: '起始行号（1-based，含该行），默认 1。续读时用上一次返回末尾提示的行号。',
      },
      limit: {
        type: 'number',
        description: '本次最多读取的行数，默认 500。',
      },
    },
    required: ['path'],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? '').trim();
    if (!rel) throw new Error('缺少参数 path');
    let startLine = Number(args.offset ?? 1);
    if (!Number.isFinite(startLine) || startLine < 1) startLine = 1;
    let limit = Number(args.limit ?? MAX_READ_LINES);
    if (!Number.isFinite(limit) || limit < 1) limit = MAX_READ_LINES;

    const real = resolveAuthorizedPath(context, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`文件不存在: ${rel}`);
    }
    if (st.isDirectory()) throw new Error(`是目录，无法读取: ${rel}`);
    if (st.size === 0) return '[READ 提示] 文件为空。';

    // 读头部用于图片嗅探（图片无论大小都只需头部 magic）
    const headLen = Math.min(MAX_READ_BYTES, st.size);
    const headBuf = readFileRange(real, 0, headLen);
    const image = sniffImage(headBuf);
    if (image) {
      if (context.vision !== true) {
        return (
          `[图片文件省略] ${rel}: ${image.kind} 图片（文件共 ${st.size} 字节）。` +
          `当前模型不支持视觉输入，无法查看图片内容。`
        );
      }
      if (st.size > MAX_IMAGE_READ_BYTES) {
        return (
          `[图片过大省略] ${rel}: ${image.kind} 图片（文件共 ${st.size} 字节，` +
          `上限 ${MAX_IMAGE_READ_BYTES} 字节）。图片过大未载入上下文，请缩小后再读。`
        );
      }
      const relPath = workspaceRelativePath(context, real);
      if (!relPath) {
        return (
          `[工作区外图片省略] ${rel}: ${image.kind} 图片。视觉读图仅支持工作区内文件，` +
          `可先将图片复制到工作区再用 read 读取。`
        );
      }
      return {
        content:
          `[图片] ${rel}: ${image.kind} 图片（${st.size} 字节）。` +
          `图片已随本结果提供，可直接查看并分析其内容。`,
        images: [{ mimeType: image.mimeType, path: relPath }],
      };
    }

    // ---- 文本路径 ----
    // 超大文件（≥2MB）退化为字节窗口读取（老路径），避免整文件进内存；
    // 此时无法给行号，按字节 offset 续读。这种文件通常是无换行的压缩/数据文件。
    if (st.size >= FULL_READ_TEXT_BYTES) {
      const byteOffset = Number(args.offset ?? 0);
      const safeByte =
        Number.isFinite(byteOffset) && byteOffset >= 0 ? Math.min(byteOffset, st.size) : 0;
      return readTextByByteWindow(real, st.size, rel, safeByte);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(real, 'utf8');
    } catch {
      throw new Error(`读取失败: ${rel}`);
    }
    // 剥离 BOM（仅显示用，edit 写回时自行保留）
    const hadBom = raw.charCodeAt(0) === 0xfeff;
    const text = hadBom ? raw.slice(1) : raw;

    // split 保留语义：末尾换行不产生多余空行
    const lines = text.split('\n');
    const totalLines = lines.length;

    if (startLine > totalLines) {
      throw new Error(
        `Offset ${startLine} 超出文件末尾（共 ${totalLines} 行）。请用 1..${totalLines} 之间的行号。`,
      );
    }

    const startIdx = startLine - 1;
    const endIdx = Math.min(startIdx + limit, totalLines);
    const windowLines = lines.slice(startIdx, endIdx);

    // 行号列宽（不超过 6 位）
    const width = Math.min(MAX_LINE_NUMBER_WIDTH, String(totalLines).length);
    const numberedLines = windowLines.map(
      (line, i) => `${String(startLine + i).padStart(width, ' ')}→${line}`,
    );
    const lastShownLine = startLine + windowLines.length - 1;
    const hasMoreLines = endIdx < totalLines;

    const hints: string[] = [];
    if (hadBom) hints.push('[READ 提示] 文件含 UTF-8 BOM（已在显示中剥离）。');

    // 超长单行：窗口内若某行本身超 64KB，提示用字节窗口/shell
    const hugeLine = windowLines.find((l) => utf8ByteLength(l) > MAX_READ_BYTES);
    if (hugeLine) {
      const hugeLineNo = startLine + windowLines.indexOf(hugeLine);
      hints.push(
        `[READ 提示] 第 ${hugeLineNo} 行单行超过 ${MAX_READ_BYTES} 字节（疑似压缩/无换行文件）。` +
          `可用 shell: sed -n '${hugeLineNo}p' ${rel} | head -c 128K 查看片段。`,
      );
    }

    // 窗口之后仍有内容：始终给出窗口续读提示（超预算时与"中间省略区间"
    // 提示并存——两者指向不同区段，缺一模型就会以为文件读完了）。
    if (hasMoreLines) {
      hints.push(
        `[READ 提示] 本次窗口显示到第 ${lastShownLine} 行，共 ${totalLines} 行。` +
          `用 offset=${lastShownLine + 1} 续读剩余 ${totalLines - lastShownLine} 行。`,
      );
    }

    // 输出预算：与 Runtime guard 同一份预算（tool-output-budget.ts）。
    // 超预算时保留整行头部 + 整行尾部，并给出**精确**的中间续读区间，
    // 每一页都必然可被模型完整读取（分页而非丢内容）。
    const sliced = sliceNumberedWindow(numberedLines, startLine);
    return [sliced.text, ...hints].filter(Boolean).join('\n');
  },
  validateResult: (result) => {
    // read 不再产生 invalid 结果（截断/图片省略/二进制都有效返回），
    // 保留钩子以防未来扩展重新引入 invalid 语义。
    if (typeof result === 'string' && result.startsWith('[sandbox-tool-invalid]')) {
      return { valid: false, reason: '结果不可用' };
    }
    return true;
  },
});
registerAlias('read', 'readFile');

// ---- ③ write（原 writeFile，自动创建父目录）----
register({
  name: 'write',
  description:
    '新建文件或整体覆盖写入文本文件（UTF-8，单次≤1MB，原子写入）。修改已存在的文件时优先用 edit（精确替换，更快更省）；仅当新建文件、或改动覆盖文件大部分内容、或多次 edit 仍失败时才用 write 整体写入。Read Only 禁止；Workspace Write 仅限 Workspace；Full access 可用绝对路径。父目录不存在时自动创建。',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '当前 Workspace 内相对文件路径，如 src/note.txt 或 work-test.txt',
      },
      content: { type: 'string', description: '要写入的 UTF-8 文本内容' },
    },
    required: ['path', 'content'],
  },
  effect: 'idempotent',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    const content = String(args.content ?? '');
    // 用长度+简单校验和区分不同内容（不嵌入全文，避免 key 过大）
    let sum = 0;
    for (let i = 0; i < content.length; i++) sum = (sum + content.charCodeAt(i)) % 1_000_000;
    const pathPart = key !== null ? key : JSON.stringify(rel);
    return `path:${pathPart}:contentLen:${Buffer.byteLength(content, 'utf8')}:sum:${sum}`;
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? '').trim();
    const content = args.content;
    if (!rel) throw new Error('缺少参数 path');
    if (typeof content !== 'string') throw new Error('content 必须是字符串（仅支持 UTF-8 文本）');

    // 权限规则①：仅允许写入 work/ 与 output/，禁止 input/ 及其他目录
    assertWritableZone(rel, context);

    // 单次写入限制：超限直接拒绝，不产生文件（同 read 的"结果不可用"模式，避免无谓重试）
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      return `[sandbox-tool-invalid] 内容过大，超过单次写入限制 ${MAX_WRITE_BYTES} 字节，未写入: ${rel}`;
    }

    // 权限规则②：resolvePath（字符串级：禁止 ../、绝对路径）+ assertInsideWorkspace（真实路径级：symlink 逃逸）双重校验
    const real = resolveAuthorizedPath(context, rel);

    // 自动创建父目录
    const dir = path.dirname(real);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 目标存在且为目录 → 拒绝；目标不存在或为普通文件 → 允许（覆盖写入）
    try {
      const tst = fs.lstatSync(real);
      if (tst.isDirectory()) throw new Error(`是目录，无法作为文件写入: ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT：目标不存在，允许新建
    }

    return atomicWriteContent(real, content, rel);
  },
  validateResult: (result) => {
    if (typeof result === 'string' && result.startsWith('[sandbox-tool-invalid]')) {
      return { valid: false, reason: '内容过大，未写入' };
    }
    return true;
  },
});
registerAlias('write', 'writeFile');

// ---- ④ edit（精确替换，oldText/newText）----
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEditPatch(
  rel: string,
  original: string,
  ranges: Array<{ index: number; matched: string; newText: string }>,
): string {
  const lines = (s: string) => s.split('\n');
  const out: string[] = [`编辑成功: ${rel} (${ranges.length} 处修改)`, `--- ${rel}`, `+++ ${rel}`];
  for (const r of ranges) {
    const startLine = original.slice(0, r.index).split('\n').length;
    const oldLines = lines(r.matched);
    const newLines = lines(r.newText);
    out.push(`@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`);
    for (const l of oldLines) out.push(`-${l}`);
    for (const l of newLines) out.push(`+${l}`);
  }
  return out.join('\n');
}

// 字符偏移 → { 行号(1-based), 列号(1-based) }
function lineColAt(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const lastNl = before.lastIndexOf('\n');
  const col = (lastNl === -1 ? index : index - lastNl - 1) + 1;
  return { line, col };
}

// 取指定偏移所在行的实际内容（裁掉行尾，限长）
function lineContentAt(text: string, index: number, maxLen = 120): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = text.length;
  const raw = text.slice(lineStart, lineEnd);
  const trimmed = raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
  return JSON.stringify(trimmed);
}

// 列出 oldText 在归一化内容中的所有匹配起始偏移
function allMatches(text: string, needle: string): number[] {
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i === -1) break;
    hits.push(i);
    from = i + Math.max(1, needle.length);
  }
  return hits;
}

// 折叠空白后定位：找出"忽略空格差异"后最接近 oldText 的位置。
// 返回首个能按"去空白"匹配上的行号 + 该位置实际内容，用于提示模型"缩进/空白抄错了"。
function fuzzyLocate(normalized: string, oldText: string): { line: number; actual: string } | null {
  const srcLines = normalized.split('\n');
  // 用 oldText 首行（去首尾空白）作为锚点
  const anchor = oldText.split('\n')[0]?.trim();
  if (!anchor) return null;
  const srcStripped = srcLines.map((l) => l.replace(/\s+/g, ' ').trim());
  const anchorStripped = anchor.replace(/\s+/g, ' ').trim();
  const hitLine = srcStripped.findIndex((l) => l?.includes(anchorStripped));
  if (hitLine === -1) return null;
  return { line: hitLine + 1, actual: JSON.stringify(srcLines[hitLine].slice(0, 120)) };
}

// 构造 edit 失败时可操作的诊断信息（帮助模型一次修复，避免回退到整文件 write）。
function editNotFoundError(
  normalized: string,
  oldText: string,
  editIndex: number,
  totalEdits: number,
): string {
  const which = totalEdits > 1 ? `第 ${editIndex + 1}/${totalEdits} 处 edit 的` : '';
  const parts: string[] = [
    `${which}oldText 在文件中未精确匹配（前80字符）: ${JSON.stringify(oldText.slice(0, 80))}`,
  ];

  // ① 忽略空白能找到 → 几乎肯定是缩进/空格抄错
  const fuzzy = fuzzyLocate(normalized, oldText);
  if (fuzzy) {
    parts.push(
      `提示: 忽略空白差异后，最接近的内容在第 ${fuzzy.line} 行，实际内容为 ${fuzzy.actual} —— 你的 oldText 缩进/空格与文件不一致。请用 read 重新读取该行，逐字符复制（含缩进），不要凭记忆补空白。`,
    );
    return parts.join('\n');
  }

  // ② oldText 的某个子行能找到 → 定位到大致行号
  const probe = oldText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 8)
    .sort((a, b) => b.length - a.length)[0];
  if (probe) {
    const idx = normalized.indexOf(probe);
    if (idx !== -1) {
      const { line } = lineColAt(normalized, idx);
      parts.push(
        `提示: oldText 中的某片段在第 ${line} 行附近，但整段未完整匹配。可能原因: 相邻行内容/缩进不符，或 oldText 跨越的边界不对。请 read offset 覆盖该区域后重新复制完整 oldText。`,
      );
      return parts.join('\n');
    }
  }

  parts.push(
    '提示: 文件中找不到任何相关片段，oldText 可能已被之前的编辑改动或来自错误文件。请先 read 该文件确认当前内容，再重新构造 edit；若改动范围确实很大，可改用 write 整文件写入。',
  );
  return parts.join('\n');
}

function editMultipleError(
  normalized: string,
  oldText: string,
  count: number,
  editIndex: number,
  totalEdits: number,
): string {
  const which = totalEdits > 1 ? `第 ${editIndex + 1}/${totalEdits} 处 edit 的` : '';
  const positions = allMatches(normalized, oldText)
    .map((i) => {
      const { line } = lineColAt(normalized, i);
      return `第 ${line} 行(${lineContentAt(normalized, i, 60)})`;
    })
    .join('、');
  return (
    `${which}oldText 在文件中出现 ${count} 次（必须恰好 1 次），拒绝编辑: ${JSON.stringify(oldText.slice(0, 60))}\n` +
    `提示: 分别出现在 ${positions}。请在 oldText 中包含更多前后相邻行（上一行/下一行）使其唯一，但不要扩大到无关代码。`
  );
}

// edit 参数容错：兼容三种模型输出变体
//  1) edits 是 JSON 字符串（部分模型会把数组序列化成字符串）
//  2) edits 是单个 edit 对象（漏包数组）
//  3) legacy：顶层 oldText/newText
function normalizeEditArgs(args: Record<string, unknown>): Array<{
  oldText: string;
  newText: string;
}> {
  if (typeof args.oldText === 'string' && typeof args.newText === 'string' && args.edits == null) {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  let edits: unknown = args.edits;
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      throw new Error('edits 参数是无效的 JSON 字符串，请直接传数组');
    }
  }
  if (edits && typeof edits === 'object' && !Array.isArray(edits)) {
    edits = [edits];
  }
  return Array.isArray(edits) ? (edits as Array<{ oldText: string; newText: string }>) : [];
}

// 返回首个非空行的前导缩进（空格/tab）
function firstNonEmptyLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim() !== '');
  return l ?? '';
}
function leadingIndent(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

// 保守 fuzzy 匹配：仅当 oldText 作为"整行块"在文件中唯一出现、
// 且与文件的差异只在行首/行尾空白（缩进/尾部空格）时才命中。
// 返回命中的真实字符区间（用文件里的实际文本作为替换目标，非空白字符原样保留）。
// 不满足"唯一整行块"一律返回 null（调用方走报错诊断，绝不猜测）。
function fuzzyApplyMatch(
  text: string,
  oldText: string,
): { index: number; matchedText: string } | null {
  if (oldText.length < 8) return null; // 过短的 oldText 不做 fuzzy，防误命中
  const srcLines = text.split('\n');
  const oldLines = oldText.split('\n');
  // 去掉 oldText 首尾的空行（模型常多带换行），但保留中间行结构
  let first = 0;
  let last = oldLines.length - 1;
  while (first <= last && oldLines[first].trim() === '') first++;
  while (last >= first && oldLines[last].trim() === '') last--;
  if (first > last) return null;
  const oldBlock = oldLines.slice(first, last + 1);
  // 每行 trim（行首缩进 + 行尾空白都视为可容错差异），但行内字符必须逐字一致
  const oldCmp = oldBlock.map((l) => l.trim());
  const srcCmp = srcLines.map((l) => l.trim());
  if (oldCmp.some((l) => l.length < 2)) return null; // 块内不接受近空行，防误匹配

  const hitStartLines: number[] = [];
  for (let s = 0; s + oldCmp.length <= srcCmp.length; s++) {
    let ok = true;
    for (let k = 0; k < oldCmp.length; k++) {
      if (srcCmp[s + k] !== oldCmp[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hitStartLines.push(s);
  }
  if (hitStartLines.length !== 1) return null; // 必须唯一

  const startLine = hitStartLines[0];
  const endLine = startLine + oldCmp.length - 1;
  // 计算字符偏移：行起始
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of srcLines) {
    lineStarts.push(acc);
    acc += l.length + 1; // +1 for '\n'
  }
  const startIndex = lineStarts[startLine];
  const endIndex = endLine + 1 < srcLines.length ? lineStarts[endLine + 1] - 1 : text.length;
  return { index: startIndex, matchedText: text.slice(startIndex, endIndex) };
}

register({
  name: 'edit',
  description:
    '在文件中精确替换文本（oldText→newText），支持多次编辑。改已有文件时优先用 edit 而非 write 整文件重写。oldText 必须与文件内容逐字符完全一致（含缩进/空格/换行，建议先用 read 取得原文再复制）且在文件中恰好出现一次；若出现多次，请把相邻的上一行/下一行也纳入 oldText 使其唯一。多次匹配或找不到均拒绝并返回最接近位置提示；edits 不能重叠。自动保留原文件换行风格（LF/CRLF）。',
  effect: 'non_idempotent',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    const edits = JSON.stringify(args.edits ?? []);
    return `path:${key ?? JSON.stringify(rel)}:edits:${edits}`;
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '当前 Workspace 内相对文件路径' },
      edits: {
        type: 'array',
        description: '精确替换列表，按顺序执行',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: '要被替换的原文（必须唯一匹配）' },
            newText: { type: 'string', description: '替换后的新文本' },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? '').trim();
    if (!rel) throw new Error('缺少参数 path');

    // 参数容错：edits 数组 / JSON 字符串 / 单对象 / legacy 顶层 oldText+newText
    const edits = normalizeEditArgs(args as Record<string, unknown>);
    if (edits.length === 0) throw new Error('edits 不能为空');
    for (const e of edits) {
      if (typeof e.oldText !== 'string' || typeof e.newText !== 'string') {
        throw new Error('edits 中每一项必须包含 oldText 和 newText（字符串）');
      }
      if (e.oldText.length === 0) throw new Error('oldText 不能为空');
    }

    assertWritableZone(rel, context);
    const real = resolveAuthorizedPath(context, rel);

    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`文件不存在: ${rel}`);
    }
    if (st.isDirectory()) throw new Error(`是目录，无法编辑: ${rel}`);
    if (st.size > MAX_READ_BYTES) {
      return `[sandbox-tool-invalid] 文件过大，无法编辑（限制 ${MAX_READ_BYTES} 字节）: ${rel}`;
    }

    let rawContent: string;
    try {
      rawContent = fs.readFileSync(real, 'utf8');
    } catch {
      throw new Error(`读取失败: ${rel}`);
    }

    // BOM：剥离后匹配/替换，写回时还原（UTF-8 BOM \uFEFF）
    const hadBom = rawContent.charCodeAt(0) === 0xfeff;
    const contentNoBom = hadBom ? rawContent.slice(1) : rawContent;
    // CRLF：归一到 LF 匹配，写回时还原
    const hasCRLF = contentNoBom.includes('\r\n');
    const normalized = hasCRLF ? contentNoBom.replace(/\r\n/g, '\n') : contentNoBom;

    interface AppliedRange {
      index: number;
      matched: string; // 实际被替换的文本（exact=oldText；fuzzy=文件真实行块）
      newText: string;
      fuzzy: boolean;
    }

    // 定位每一次 edit：exact 优先；不中则保守 fuzzy（整行块、唯一、仅空白差异）
    const ranges: AppliedRange[] = [];
    const fuzzyEdits = new Set<number>();
    for (let ei = 0; ei < edits.length; ei++) {
      const e = edits[ei];
      const idx = normalized.indexOf(e.oldText);
      if (idx !== -1) {
        // exact 命中但落在行内（oldText 起点不是行首），说明它实际是某行
        // 去掉缩进后的子串——此时仍按整行 fuzzy 处理，保证替换目标包含真实缩进。
        const atLineStart = idx === 0 || normalized[idx - 1] === '\n';
        const isStandalone =
          idx + e.oldText.length === normalized.length ||
          normalized[idx + e.oldText.length] === '\n';
        if (atLineStart && isStandalone) {
          ranges.push({ index: idx, matched: e.oldText, newText: e.newText, fuzzy: false });
          continue;
        }
        // 行内命中 → 尝试整行 fuzzy（唯一才应用）
        const hit = fuzzyApplyMatch(normalized, e.oldText);
        if (hit) {
          ranges.push({
            index: hit.index,
            matched: hit.matchedText,
            newText: e.newText,
            fuzzy: true,
          });
          fuzzyEdits.add(ei);
          continue;
        }
        // fuzzy 也不中，退回 exact 行内替换（保持旧行为）
        ranges.push({ index: idx, matched: e.oldText, newText: e.newText, fuzzy: false });
        continue;
      }
      // exact 不中 → 保守 fuzzy
      const hit = fuzzyApplyMatch(normalized, e.oldText);
      if (hit) {
        ranges.push({
          index: hit.index,
          matched: hit.matchedText,
          newText: e.newText,
          fuzzy: true,
        });
        fuzzyEdits.add(ei);
        continue;
      }
      throw new Error(editNotFoundError(normalized, e.oldText, ei, edits.length));
    }

    // 严格检查：exact edit 必须恰好出现一次（fuzzy 已保证唯一整行块）
    for (let ei = 0; ei < edits.length; ei++) {
      if (fuzzyEdits.has(ei)) continue;
      const e = edits[ei];
      const count = (normalized.match(new RegExp(escapeRegex(e.oldText), 'g')) || []).length;
      if (count !== 1) {
        throw new Error(editMultipleError(normalized, e.oldText, count, ei, edits.length));
      }
    }

    // 检查重叠（用实际替换区间）
    ranges.sort((a, b) => a.index - b.index);
    for (let i = 1; i < ranges.length; i++) {
      const prev = ranges[i - 1];
      const curr = ranges[i];
      if (prev.index + prev.matched.length > curr.index) {
        throw new Error('edits 存在重叠修改，拒绝执行');
      }
    }

    // 逆序应用（用 matched 作为被替换文本，fuzzy 时即文件真实内容）
    // fuzzy 整行替换：newText 通常不带源文件缩进，自动补回源行块的基线缩进，
    // 避免"改一行丢缩进"破坏代码格式。
    let result = normalized;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i];
      let replacement = r.newText;
      if (r.fuzzy) {
        const srcIndent = leadingIndent(firstNonEmptyLine(r.matched));
        const newFirstLine = firstNonEmptyLine(r.newText);
        if (srcIndent && newFirstLine) {
          const newIndent = leadingIndent(newFirstLine);
          if (srcIndent.length > newIndent.length) {
            const pad = srcIndent.slice(newIndent.length);
            replacement = r.newText
              .split('\n')
              .map((line) => (line.trim() === '' ? line : pad + line))
              .join('\n');
          }
        }
      }
      result = result.slice(0, r.index) + replacement + result.slice(r.index + r.matched.length);
    }

    if (hasCRLF) {
      result = result.replace(/\n/g, '\r\n');
    }
    if (hadBom) {
      result = `\uFEFF${result}`;
    }

    if (result === rawContent) {
      return `无修改: ${rel}`;
    }

    const patch = buildEditPatch(rel, normalized, ranges);
    atomicWriteContent(real, result, rel);
    const fuzzyNote =
      fuzzyEdits.size > 0 ? `（其中 ${fuzzyEdits.size} 处按缩进/空白容错匹配）` : '';
    return `${patch}${fuzzyNote}`;
  },
  validateResult: (result) => {
    if (typeof result === 'string' && result.startsWith('[sandbox-tool-invalid]')) {
      return { valid: false, reason: '文件过大，无法编辑' };
    }
    return true;
  },
});
