// 内容寻址附件库（docs/attachment-v2-content-store.md P0 期）。
// 设计要点：
// - 字节按 sha256 去重：同一份图片/文件全库只有一个对象，永不覆盖
// - 原子发布：tmp/ 暂存 → fsync → hardlink 至 objects/<前2>/<sha256> → chmod 0444
//   （hardlink 在同目录内是原子的；并发同 sha 只有一个胜者，败者清理自身 tmp）
// - workspace 可见性：同卷 hardlink（共享 inode 零拷贝，agent 看到同一份只读文件），
//   跨卷/受限回退为 copy；同名冲突追加 -2/-3… 后缀（内容寻址下同名不同字节合法共存）
// - 旧数据兼容：历史消息里的 workspace 相对路径引用继续可读，本模块只管新写入

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';

// 数据根与 sqlite-store 同根：<项目根>/.data/attachments/v1（payaso.db 同级）。
// PAYASO_ATTACHMENT_STORE 可覆盖（测试指向临时目录，不污染仓库）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function getAttachmentStoreRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.PAYASO_ATTACHMENT_STORE?.trim();
  return override ? path.resolve(override) : path.join(REPO_ROOT, '.data', 'attachments', 'v1');
}

export function attachmentSha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export interface StoredAttachmentObject {
  sha256: string;
  storePath: string;
  /** true = 库里已有同字节对象（本次未重复写入） */
  existed: boolean;
}

const OBJECT_MODE = 0o444;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

function objectsDir(root: string, sha256: string): string {
  return path.join(root, 'objects', sha256.slice(0, 2));
}

// 原子发布一个对象。bytes 必须已经是最终字节（调用方负责归一化，P1 接入 sharp）。
export function putAttachmentObject(storeRoot: string, bytes: Buffer): StoredAttachmentObject {
  const sha256 = attachmentSha256(bytes);
  const finalPath = path.join(objectsDir(storeRoot, sha256), sha256);
  if (fs.existsSync(finalPath)) {
    return { sha256, storePath: finalPath, existed: true };
  }
  const tmpDir = path.join(storeRoot, 'tmp');
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${sha256.slice(0, 16)}-${crypto.randomUUID()}`);
  const fd = fs.openSync(tmpPath, 'wx');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let existed = false;
  try {
    // hardlink 在同目录内原子：并发写同 sha 时只有一个 link 成功，其余 EEXIST。
    fs.linkSync(tmpPath, finalPath);
    fs.chmodSync(finalPath, OBJECT_MODE);
  } catch {
    existed = fs.existsSync(finalPath);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* tmp 已被并发胜者清理等情况，忽略 */
    }
  }
  return { sha256, storePath: finalPath, existed };
}

// 启动/定期清扫：tmp/ 内超龄孤儿（发布中断残留）。只删 tmp，永不触碰 objects。
export function sweepAttachmentTmp(storeRoot: string, now = Date.now()): number {
  const tmpDir = path.join(storeRoot, 'tmp');
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidate = path.join(tmpDir, entry.name);
    try {
      const stat = fs.statSync(candidate);
      if (now - stat.mtimeMs > TMP_MAX_AGE_MS) {
        fs.unlinkSync(candidate);
        removed += 1;
      }
    } catch {
      /* 并发被清理等情况，忽略 */
    }
  }
  return removed;
}

// 进程级一次性清扫（首次附件写入时触发，每次进程生命周期至多一次）。
const sweptStores = new Set<string>();
export function sweepAttachmentTmpOnce(storeRoot: string): void {
  if (sweptStores.has(storeRoot)) return;
  sweptStores.add(storeRoot);
  sweepAttachmentTmp(storeRoot);
}

export interface WorkspacePublishResult {
  /** workspace 相对路径（消息/agent 可见副本） */
  relPath: string;
  /** true = 跨卷/受限回退为字节拷贝；false = hardlink 共享 inode */
  copied: boolean;
}

// 把库内对象发布进 workspace 供 agent 可见。
// - 同卷 hardlink（零拷贝，共享 0444 只读语义）
// - EXDEV/EPERM（跨卷、只读文件系统等）→ copy 回退
// - 目标名 EEXIST（同名不同字节）→ stem-2/ext、stem-3/ext … 追加后缀，永不覆盖
export function publishAttachmentIntoWorkspace(
  storePath: string,
  workspaceRoot: string,
  directory: string,
  fileName: string,
): WorkspacePublishResult {
  const baseDir = resolveWorkspacePath(workspaceRoot, directory);
  assertInsideRoot(workspaceRoot, baseDir);
  fs.mkdirSync(baseDir, { recursive: true });

  const safeStem = publishStem(fileName);
  let target = path.join(baseDir, safeStem.fileName);

  for (let attempt = 2; ; attempt += 1) {
    try {
      fs.linkSync(storePath, target);
      return { relPath: toWorkspaceRel(workspaceRoot, target), copied: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'EEXIST') {
        target = path.join(baseDir, `${safeStem.stem}-${attempt}${safeStem.ext}`);
        continue;
      }
      // 跨卷 / 受限文件系统 → 拷贝回退（COPYFILE_EXCL：同样不覆盖既有目标）
      try {
        fs.copyFileSync(storePath, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, OBJECT_MODE);
        return { relPath: toWorkspaceRel(workspaceRoot, target), copied: true };
      } catch (copyErr) {
        const copyCode = (copyErr as NodeJS.ErrnoException | null)?.code;
        if (copyCode === 'EEXIST') {
          target = path.join(baseDir, `${safeStem.stem}-${attempt}${safeStem.ext}`);
          continue;
        }
        throw copyErr;
      }
    }
  }
}

function publishStem(fileName: string): { stem: string; ext: string; fileName: string } {
  const safe = path
    .basename(fileName)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_');
  const ext = path.extname(safe);
  let stem = ext ? safe.slice(0, -ext.length) : safe;
  if (!stem) stem = 'attachment';
  return { stem, ext, fileName: safe };
}

function toWorkspaceRel(workspaceRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(workspaceRoot), absolutePath).split(path.sep).join('/');
}
