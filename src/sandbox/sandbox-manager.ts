// 模块: SandboxManager — 最小安全工作区路径管理
// 职责边界：只做"安全路径解析/校验/工作区生命周期"，不接入 read/write/shell 工具，不改 Agent Loop。
// 核心原则：在给 Agent 文件权限之前，先证明它无法逃出 sandbox。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认 sandbox 根：<项目根>/sandbox（本文件位于 src/sandbox/，向上两级为项目根）
// 可用环境变量 SANDBOX_ROOT 覆盖（便于测试指向临时目录，不污染仓库）
const DEFAULT_SANDBOX_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'sandbox',
);

export function getSandboxRoot(): string {
  const env = process.env.SANDBOX_ROOT;
  return env ? path.resolve(env) : DEFAULT_SANDBOX_ROOT;
}

// runId 只允许文件系统/URL 安全字符：字母数字、-、_；禁止路径分隔符、绝对路径、.. 等
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeRunId(runId: string): void {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new Error(`非法 runId（禁止 ../、绝对路径或路径分隔符）: ${JSON.stringify(runId)}`);
  }
}

// 当前 runId 的 workspace 根绝对路径：<sandboxRoot>/workspaces/<runId>
export function getRunWorkspaceRoot(runId: string): string {
  assertSafeRunId(runId);
  return path.join(getSandboxRoot(), 'workspaces', runId);
}

// Canonicalize an explicitly authorized workspace root. This is the only
// representation carried by Host/Runtime after a user selects a directory.
export function canonicalizeWorkspaceRoot(rootPath: string): string {
  const raw = String(rootPath ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error('Workspace 路径必须是绝对路径');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(raw);
  } catch {
    throw new Error('Workspace 目录不存在或不可访问');
  }
  if (!stat.isDirectory()) throw new Error('Workspace 路径必须指向目录');
  return fs.realpathSync.native(raw);
}

// ---- 1. createWorkspace ----
// 创建 input/work/output 三个子目录；已存在时安全复用（recursive）
export function createWorkspace(runId: string): string {
  const root = getRunWorkspaceRoot(runId);
  for (const sub of ['input', 'work', 'output']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

// ---- 2. resolvePath ----
// 只解析到当前 runId workspace 内；禁止绝对路径 / .. 穿越 / Windows 盘符；返回规范化绝对路径
export function resolvePath(runId: string, relativePath: string): string {
  return resolveWorkspacePath(getRunWorkspaceRoot(runId), relativePath);
}

// Resolve an LLM-provided relative path against a Runtime-authorized root.
// The root itself never comes from Tool args.
export function resolveWorkspacePath(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const p = String(relativePath ?? '');
  if (p.length === 0) throw new Error('相对路径不能为空');
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    throw new Error(`禁止绝对路径: ${relativePath}`);
  }
  const segs = p.split(/[\\/]+/);
  if (segs.includes('..')) {
    throw new Error(`禁止路径穿越（..）: ${relativePath}`);
  }
  const resolved = path.resolve(root, ...segs);
  // 双保险：解析结果必须仍在 workspace 内
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径逃逸: ${relativePath}`);
  }
  return resolved;
}

// 取某路径"最近存在的祖先"的 realpath（目标本身不存在时向上找，如 macOS /var → /private/var）
function realpathOfNearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return fs.realpathSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      cur = parent;
    }
  }
}

// ---- 3. assertInsideWorkspace ----
// 校验"最终真实路径"不能逃出 workspace（含 symlink 解析）；
// 目标不存在时向上找最近存在的祖先做 realpath 校验，保证父路径仍在 sandbox 内。
export function assertInsideWorkspace(runId: string, targetPath: string): void {
  assertInsideRoot(getRunWorkspaceRoot(runId), targetPath);
}

// Real-path containment check shared by legacy per-run sandboxes and real
// user-selected workspaces. Non-existing targets are checked via their nearest
// existing ancestor; symlink traversal remains fail-closed.
export function assertInsideRoot(rootPath: string, targetPath: string): void {
  // 必须先检查未解析的 workspace 根。若先 realpath 再 lstat，根 symlink
  // 已被折叠成目标目录，后续 isSymbolicLink() 将永远无法命中。
  const unresolvedRoot = path.resolve(rootPath);
  let unresolvedRootStat: fs.Stats;
  try {
    unresolvedRootStat = fs.lstatSync(unresolvedRoot);
  } catch {
    throw new Error(`workspace 根不存在或不可访问: ${targetPath}`);
  }
  if (unresolvedRootStat.isSymbolicLink()) {
    throw new Error(`workspace 根是 symlink，拒绝: ${targetPath}`);
  }
  if (!unresolvedRootStat.isDirectory()) {
    throw new Error(`workspace 根不是目录，拒绝: ${targetPath}`);
  }

  // 再解析真实路径：保留 macOS /var → /private/var 等父级系统 symlink 兼容。
  const root = fs.realpathSync.native(unresolvedRoot);
  const abs = path.resolve(String(targetPath));
  const realAbs = realpathOfNearestExisting(abs);

  // 3.1 字符串级：绝对路径必须位于 root 之下（快速失败，拒绝明显的逃逸）
  if (realAbs !== root && !realAbs.startsWith(root + path.sep)) {
    throw new Error(`逃出 workspace: ${targetPath}`);
  }

  // 3.2 真实路径级：基准 = root 的 realpath（处理 macOS /var→/private/var 等系统级 symlink）
  const realBase = root; // root 已在上方通过 realpathOfNearestExisting 解析
  let cur = realAbs;
  for (;;) {
    // 未越出字符串 root 才继续；越出说明目标及所有祖先都不存在 → fail-closed
    if (cur !== realBase && !cur.startsWith(realBase + path.sep)) {
      throw new Error(`无法解析到 sandbox 内的路径: ${targetPath}`);
    }
    try {
      const real = fs.realpathSync(cur);
      if (real !== realBase && !real.startsWith(realBase + path.sep)) {
        throw new Error(`symlink 逃逸: ${targetPath} → ${real}`);
      }
      break; // 该层真实路径安全（realpath 会解析整条祖先链）
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err; // 非"不存在"错误（如权限）直接抛
      // 目标不存在：若该层本身是悬空 symlink 则拒绝
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(cur);
      } catch {
        st = undefined;
      }
      if (st?.isSymbolicLink()) {
        throw new Error(`symlink 逃逸（悬空链接）: ${targetPath}`);
      }
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error(`无法解析路径: ${targetPath}`);
      cur = parent;
    }
  }
}

// ---- 4. cleanupWorkspace ----
// 只能删除当前 runId 对应 workspace；绝不允许删除 sandbox/、workspaces/ 或任何上级/其他目录
export function cleanupWorkspace(runId: string): void {
  const sandboxRoot = getSandboxRoot();
  const workspacesDir = path.join(sandboxRoot, 'workspaces');
  const root = getRunWorkspaceRoot(runId); // runId 已校验（禁止 .. / 分隔符 / 绝对路径）

  // 防御：root 必须是 workspaces 下的单个 runId 段（单层，无分隔符）
  const rel = path.relative(workspacesDir, root);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel) ||
    rel.includes(path.sep)
  ) {
    throw new Error(`非法 workspace 根，禁止删除: ${root}`);
  }
  if (root === sandboxRoot || root === workspacesDir) {
    throw new Error('禁止删除 sandbox 根目录或 workspaces 目录');
  }

  fs.rmSync(root, { recursive: true, force: true });
}
