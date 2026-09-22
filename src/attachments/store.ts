// 内容寻址附件库（docs/attachment/attachment-v2-content-store.md P0 期）。
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
import { appDataPath } from '../app-paths.js';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';

// 附件库跟随应用数据目录，避免写入 npm 安装目录。
// PAYASO_ATTACHMENT_STORE 可覆盖（测试指向临时目录，不污染仓库）。

export function getAttachmentStoreRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.PAYASO_ATTACHMENT_STORE?.trim();
  return override ? path.resolve(override) : appDataPath('attachments', 'v1');
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
    // win32 跳过只读位：chmod 0444 在 Windows 映射为只读属性，会锁死后续删除
    if (process.platform !== 'win32') fs.chmodSync(finalPath, OBJECT_MODE);
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
  independentCopy = false,
): WorkspacePublishResult {
  const baseDir = resolveWorkspacePath(workspaceRoot, directory);
  assertInsideRoot(workspaceRoot, baseDir);
  fs.mkdirSync(baseDir, { recursive: true });

  const safeStem = publishStem(fileName);
  let target = path.join(baseDir, safeStem.fileName);

  for (let attempt = 2; ; attempt += 1) {
    try {
      if (independentCopy) {
        fs.copyFileSync(storePath, target, fs.constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') fs.chmodSync(target, OBJECT_MODE);
        return { relPath: toWorkspaceRel(workspaceRoot, target), copied: true };
      }
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
        if (process.platform !== 'win32') fs.chmodSync(target, OBJECT_MODE);
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
  // 只滤真正危险的字符：路径分隔符已被 basename 去掉；这里保留 Unicode 字母/
  // 数字/组合记号（含中文、日文等）与内部空格（Windows 只禁结尾空格），其余
  // （控制字符、符号、tab/换行）替换为 _ —— 中文附件名在磁盘上保持可读，多个
  // 中文名不再挤成一串下划线。结尾的点/空白对 Windows 无效，剥掉；全空时由
  // 下方兜底为 attachment。
  const safe = path
    .basename(fileName)
    .replace(/[^\p{L}\p{N}\p{M}._ -]/gu, '_')
    .replace(/[.\s]+$/, '')
    .replace(/^\.+/, '_');
  const ext = path.extname(safe);
  let stem = ext ? safe.slice(0, -ext.length) : safe;
  if (!stem) stem = 'attachment';
  return { stem, ext, fileName: safe };
}

function toWorkspaceRel(workspaceRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(workspaceRoot), absolutePath).split(path.sep).join('/');
}

// 只恢复缺失的文本副本；已有文件不覆盖。失败由调用方保留为可见缺失。
export function restoreAttachment(workspaceRoot: string, relPath: string, sha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('非法附件内容键');
  const target = resolveWorkspacePath(workspaceRoot, relPath);
  assertInsideRoot(workspaceRoot, target);
  if (fs.existsSync(target)) return;
  const storeRoot = getAttachmentStoreRoot();
  const source = path.join(storeRoot, 'objects', sha256.slice(0, 2), sha256);
  assertInsideRoot(storeRoot, source);
  const bytes = fs.readFileSync(source);
  if (attachmentSha256(bytes) !== sha256) throw new Error('附件对象损坏');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: OBJECT_MODE });
}
