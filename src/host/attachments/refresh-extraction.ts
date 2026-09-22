// 会话恢复时的过期提取刷新。
// 背景：提取产物（extraction.path 指向的正文文件）一旦落盘就固化了——历史事件不可变，
// 同会话重试只是按 sha256 恢复旧字节。提取逻辑升级（如乱码闸门）后，旧会话读到的
// 仍是旧代码的产物。这里按版本判定过期，恢复原件后用现行逻辑重提并覆盖。
// 说明：
// - 事件里的 extraction.sha256/sizeBytes 不更新（历史不可变）；刷新的只是 path
//   指向的文件内容，read 工具按 path 取内容，元数据陈旧无功能影响。
// - failed 状态无产物可刷（path 为空）：旧判定保持 failed，Agent 仍可走 skill 处理原件。
// - 刷新台账放在宿主侧（appDataPath），不进工作区：agent 无感，且跨会话共享同一
//   workspace 的刷新状态。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appDataPath } from '../../app-paths.js';
import type { AttachmentExtraction } from '../../attachment-types.js';
import { extractDocxText } from './docx.js';
import { extractPdfText } from './pdf.js';
import { extractPptxText } from './pptx.js';
import { extractXlsxText } from './xlsx.js';
import { EXTRACTOR_VERSION } from './extraction-version.js';

/** 按扩展名路由的重提函数表：与 normalize.ts 的 dispatch 保持一致。 */
const EXTRACTORS: Record<string, (bytes: Buffer) => Promise<string> | string> = {
  '.pdf': extractPdfText,
  '.docx': extractDocxText,
  '.pptx': extractPptxText,
  '.xlsx': extractXlsxText,
};

/** 刷新台账结构：extraction.path（workspace 相对）→ 已刷到的版本。 */
type Ledger = Record<string, string>;

/** 需要刷新的最小输入：原件路径 + 提取引用（HostAttachment / TextAttachmentRef 均满足）。 */
interface RefreshableAttachment {
  path: string;
  extraction?: AttachmentExtraction;
}

function ledgerPathFor(workspaceRoot: string): string {
  const key = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 32);
  return appDataPath('extraction-refresh', `${key}.json`);
}

function readLedger(workspaceRoot: string): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPathFor(workspaceRoot), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Ledger) : {};
  } catch {
    return {};
  }
}

function writeLedger(workspaceRoot: string, ledger: Ledger): void {
  const file = ledgerPathFor(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger));
  fs.renameSync(tmp, file);
}

function resolveInside(root: string, relative: string): string | null {
  const target = path.resolve(root, relative);
  const base = path.resolve(root);
  return target !== base && target.startsWith(base + path.sep) ? target : null;
}

/** 产物是否过期：事件自带版本已是最新 → 否；否则看宿主台账里记住的刷新版本。 */
export function needsExtractionRefresh(file: RefreshableAttachment, workspaceRoot: string): boolean {
  const extraction = file.extraction;
  if (!extraction?.path || extraction.status === 'failed') return false;
  if (extraction.extractorVersion === EXTRACTOR_VERSION) return false;
  return readLedger(workspaceRoot)[extraction.path] !== EXTRACTOR_VERSION;
}

/**
 * 用现行提取逻辑重提并覆盖 extraction.path 指向的产物文件。
 * 任何失败（原件缺失、格式不支持、提取抛错、结果为空、写入失败）都静默返回 false：
 * 保留旧产物，下一轮 run 启动时自然重试，不让恢复链路被提取故障拖死。
 */
export async function refreshExtraction(
  file: RefreshableAttachment,
  workspaceRoot: string,
): Promise<boolean> {
  if (!needsExtractionRefresh(file, workspaceRoot)) return false;
  const extraction = file.extraction!;
  const extractor = EXTRACTORS[path.extname(file.path).toLowerCase()];
  if (!extractor) return false;

  const originalPath = resolveInside(workspaceRoot, file.path);
  const extractionTarget = resolveInside(workspaceRoot, extraction.path!);
  if (!originalPath || !extractionTarget) return false;

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(originalPath);
  } catch {
    return false; // 原件没恢复出来，无从重提
  }
  let text: string;
  try {
    text = await extractor(bytes);
  } catch {
    return false; // 现行逻辑也解不了：保留旧产物下轮再试
  }
  if (!text.trim()) return false;
  try {
    // 恢复出来的产物带只读 mode（store 的 OBJECT_MODE 0444，agent 只读语义）：
    // 先删除再写，写完继续保持只读，与其余附件文件一致。
    fs.rmSync(extractionTarget, { force: true });
    fs.writeFileSync(extractionTarget, text, { mode: 0o444 });
  } catch {
    return false;
  }
  const ledger = readLedger(workspaceRoot);
  ledger[extraction.path!] = EXTRACTOR_VERSION;
  writeLedger(workspaceRoot, ledger);
  return true;
}