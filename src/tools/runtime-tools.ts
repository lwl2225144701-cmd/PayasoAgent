// 模块: Runtime 工具（grep / createDir / moveFile / deleteFile / shell）
// 安全契约与 filesystem.ts 一致：
// - LLM 只传工作区内相对路径；真实路径由 ToolContext.workspaceRoot + 双重路径校验
// - 全部显式声明 effect（副作用语义必须明确）
// - shell 以当前 context.workspaceRoot 为 cwd；文件系统边界由 macOS OS Sandbox 强制执行
// v1.5 融合身份机制：路径类工具用 canonicalPathKey 做操作 identity 归一化（不暴露宿主绝对路径）。
// v1.7：searchText → grep（目录递归搜索）；createDir 移出核心（hidden），write 已覆盖其核心场景。

import fs from 'node:fs';
import path from 'node:path';
import { getNetworkMode } from '../network-mode.js';
import { storedPermissionMode } from '../permission-mode.js';
import {
  MacOSSandbox,
  type MacOSSandboxResult,
  probeSandboxAvailability,
} from '../sandbox/macos-sandbox.js';
import { discoverShellHost, runUncontainedShell } from '../sandbox/shell-host.js';
import {
  assertWritableZone,
  canonicalPathKey,
  isProbablyBinary,
  MAX_READ_BYTES,
  resolveAuthorizedPath,
} from './filesystem.js';
import { RequiredRuntimeToolUnavailableError, register, registerAlias } from './tools.js';

// ---- ① grep（原 searchText，目录递归搜索）----
register({
  name: 'grep',
  description:
    '在工作区内递归搜索文本子串（非正则）。支持指定文件或目录路径，结果数量可限，所有访问严格限制在 Workspace 内，自动跳过二进制文件与超大文件，禁止跟随 symlink 避免逃逸。',
  effect: 'read',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '.').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return `path:${key ?? JSON.stringify(rel)}:pattern:${args.pattern}:max:${args.maxResults ?? 100}`;
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要查找的文本子串（非正则）' },
      path: { type: 'string', description: '工作区内相对路径，文件或目录（默认当前目录 .）' },
      maxResults: { type: 'number', description: '最多返回的匹配行数（默认 100，上限 500）' },
    },
    required: ['pattern'],
  },
  execute: async (args, context) => {
    const pattern = String(args.pattern ?? '');
    if (!pattern) throw new Error('缺少参数 pattern');

    const rel = String(args.path ?? '.').trim();
    const maxResults = Math.min(Number(args.maxResults ?? 100) || 100, 500);

    const real = resolveAuthorizedPath(context, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(real);
    } catch {
      throw new Error(`路径不存在: ${rel}`);
    }

    const matches: Array<{ file: string; line: number; content: string }> = [];
    let filesVisited = 0;
    const MAX_DEPTH = 32;
    const MAX_FILES = 5000;

    function searchInFile(filePath: string): 'ok' | 'too_big' | 'binary' | 'error' {
      if (filesVisited >= MAX_FILES) return 'error';
      filesVisited++;
      let fst: fs.Stats;
      try {
        fst = fs.lstatSync(filePath);
      } catch {
        return 'error';
      }
      if (fst.size > MAX_READ_BYTES) return 'too_big';
      let buf: Buffer;
      try {
        buf = fs.readFileSync(filePath);
      } catch {
        return 'error';
      }
      if (isProbablyBinary(buf)) return 'binary';
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({ file: filePath, line: i + 1, content: lines[i] });
        }
      }
      return 'ok';
    }

    function walk(dir: string, depth: number): void {
      if (depth > MAX_DEPTH || filesVisited >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (filesVisited >= MAX_FILES) break;
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue; // 跳过 symlink，避免逃逸和无限递归
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          searchInFile(full);
        }
      }
    }

    if (st.isFile()) {
      const status = searchInFile(real);
      if (status === 'too_big') {
        return `[sandbox-tool-invalid] 文件过大，无法搜索（限制 ${MAX_READ_BYTES} 字节）: ${rel}`;
      }
      if (status === 'binary') {
        return `[sandbox-tool-invalid] 二进制文件，不支持文本搜索: ${rel}`;
      }
    } else if (st.isDirectory()) {
      walk(real, 0);
    } else {
      throw new Error(`不是文件也不是目录: ${rel}`);
    }

    if (matches.length === 0) return `未找到 "${pattern}"（${rel}）`;

    const lines: string[] = [];
    for (const m of matches) {
      const relPath = path.relative(context.workspaceRoot, m.file);
      lines.push(`${relPath}:${m.line}:${m.content}`);
    }
    const summary = `找到 ${matches.length} 处匹配（共扫描 ${filesVisited} 个文件）`;
    return [...lines, summary].join('\n');
  },
  validateResult: (result) => {
    if (typeof result === 'string' && result.startsWith('[sandbox-tool-invalid]')) {
      return { valid: false, reason: '文件过大或二进制，无法搜索' };
    }
    return true;
  },
});
registerAlias('grep', 'searchText');

function missingShellToolName(stderr: string): string | undefined {
  // Only normalize the shell's own command lookup failure. Do not inspect or
  // rewrite the model command, and do not mistake an arbitrary program's
  // "package not found"/similar diagnostic for a missing executable.
  const match = stderr.match(
    /(?:^|\n)\/bin\/sh:\s+(?:\d+:\s+)?([A-Za-z0-9][A-Za-z0-9._+-]*):\s+(?:command not found|not found)\s*$/m,
  );
  return match?.[1];
}

// ---- ② createDir（移出核心工具集，write 已支持自动创建父目录）----
// 保留 hidden 别名，不破坏已有测试和调用方的兼容性
register({
  name: 'createDir',
  description:
    '创建单个目录。Read Only 禁止；Workspace Write 仅限 Workspace；Full access 可用绝对路径。父目录必须已存在。（已移出核心工具集，write 支持自动创建父目录）',
  effect: 'idempotent',
  hidden: true,
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '当前 Workspace 内相对目录路径，如 src/generated' },
    },
    required: ['path'],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? '').trim();
    if (!rel) throw new Error('缺少参数 path');
    assertWritableZone(rel, context);
    const real = resolveAuthorizedPath(context, rel);

    // 父目录必须已存在
    const parent = path.dirname(real);
    try {
      if (!fs.lstatSync(parent).isDirectory()) throw new Error('父路径不是目录');
    } catch (err) {
      if (real === parent) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`父目录不存在，不自动创建: ${rel}`);
      }
      throw err;
    }
    // 目标已存在且是目录 → 幂等；已存在且是文件 → 拒绝
    try {
      const st = fs.lstatSync(real);
      if (st.isDirectory()) return `目录已存在(幂等): ${rel}`;
      throw new Error(`目标已存在但不是目录，无法创建: ${rel}`);
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code !== 'ENOENT' &&
        !(err as Error).message.includes('目标已存在')
      ) {
        throw err;
      }
    }
    fs.mkdirSync(real);
    return `创建目录成功: ${rel}`;
  },
});

// ---- ③ moveFile ----
register({
  name: 'moveFile',
  description:
    '移动文件。Read Only 禁止；Workspace Write 的 source/target 仅限 Workspace；Full access 可用绝对路径。会破坏源位置。',
  effect: 'non_idempotent',
  getOperationKey: (args, context) => {
    const src = String(args.source ?? '').trim();
    const dst = String(args.target ?? '').trim();
    const sk = context ? canonicalPathKey(context, src) : null;
    const dk = context ? canonicalPathKey(context, dst) : null;
    return `src:${sk ?? JSON.stringify(src)}:dst:${dk ?? JSON.stringify(dst)}`;
  },
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源相对路径，如 work/a.txt' },
      target: { type: 'string', description: '目标相对路径，如 work/sub/b.txt' },
    },
    required: ['source', 'target'],
  },
  execute: async (args, context) => {
    const src = String(args.source ?? '').trim();
    const dst = String(args.target ?? '').trim();
    if (!src) throw new Error('缺少参数 source');
    if (!dst) throw new Error('缺少参数 target');
    assertWritableZone(src, context);
    assertWritableZone(dst, context);
    const realSrc = resolveAuthorizedPath(context, src);
    const realDst = resolveAuthorizedPath(context, dst);

    try {
      if (!fs.lstatSync(realSrc).isFile()) throw new Error('源不是普通文件');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`源文件不存在: ${src}`);
      }
      throw err;
    }
    // 目标已存在 → 拒绝（避免静默覆盖；让副作用分类语义清晰）
    try {
      fs.lstatSync(realDst);
      throw new Error(`目标已存在，拒绝覆盖（如需覆盖请先删除目标）: ${dst}`);
    } catch (err) {
      if (!(err as Error).message.includes('目标已存在')) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      } else {
        throw err;
      }
    }
    fs.renameSync(realSrc, realDst);
    return `移动成功: ${src} → ${dst}`;
  },
});

// ---- ④ deleteFile ----
register({
  name: 'deleteFile',
  description:
    '删除文件（不递归删除目录）。Read Only 禁止；Workspace Write 仅限 Workspace；Full access 可用绝对路径。',
  effect: 'idempotent',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return key !== null ? `path:${key}` : `path:${JSON.stringify(rel)}`;
  },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内相对文件路径，如 work/a.txt' },
    },
    required: ['path'],
  },
  execute: async (args, context) => {
    const rel = String(args.path ?? '').trim();
    if (!rel) throw new Error('缺少参数 path');
    assertWritableZone(rel, context);
    const real = resolveAuthorizedPath(context, rel);

    try {
      const st = fs.lstatSync(real);
      if (st.isDirectory()) throw new Error(`是目录，请勿用 deleteFile 删除目录: ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return `文件不存在(幂等): ${rel}`;
      }
      throw err;
    }
    fs.rmSync(real, { force: true });
    return `删除成功: ${rel}`;
  },
});

// ---- ⑤ shell ----
register({
  name: 'shell',
  description:
    '执行一条 shell 命令（cwd=Workspace，非交互，timeout 10s，输出限64KB；macOS 走 OS Sandbox，其他平台需审批模式）。文件访问服从当前 Read Only/Workspace Write/Full access 权限；网络能力跟随全局 network.mode（默认 on=联网）。',
  effect: 'non_idempotent',
  // v2.0 Network Control：shell 具备网络能力。第一版保守策略——不对 curl/wget/git
  // 做命令识别；network.mode=off 时整个 shell 被统一拒绝（tools.ts execute 检查）。
  capabilities: { network: true },
  getOperationKey: (args) => `cmd:${String(args.command ?? '').trim()}`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要在当前 Workspace 根目录执行的 shell 命令' },
    },
    required: ['command'],
  },
  execute: async (args, context) => {
    const cmd = String(args.command ?? '').trim();
    if (!cmd) throw new Error('缺少参数 command');

    const workspaceRoot = context.workspaceRoot;
    const permissionMode = storedPermissionMode(context.permissionMode);
    const workDir = workspaceRoot;
    // v2.0 Network Control：shell 的网络能力跟随全局 network.mode ——
    // on → 允许网络；off → execute() 已在执行前拒绝，绝不会走到这里。
    const networkAccess = getNetworkMode() === 'on';
    // HOME/TMPDIR must stay under the same authorized root. Use an ephemeral
    // per-call directory so npm/tsx caches never become project artifacts.
    const runtimeDir =
      permissionMode === 'read-only'
        ? null
        : fs.mkdtempSync(path.join(workspaceRoot, '.payaso-shell-'));
    const home = runtimeDir ?? workspaceRoot;
    const tmpdir = runtimeDir ?? workspaceRoot;

    // 双通道（docs/windows-mac-compat.md §3）：
    // - macOS：Seatbelt 沙箱，fail-closed——sandbox-exec 不可用即拒绝，绝不静默降级
    // - 其他平台：无 OS 沙箱原语，默认同样拒绝（延续"绝不静默降低遏制"原则），
    //   仅当用户显式选择审批模式或设置 PAYASO_SHELL_UNSANDBOXED=1 才放行
    let result: MacOSSandboxResult;
    try {
      if (process.platform === 'darwin') {
        // Fail-closed gate（darwin 原语义，保持不变）：sandbox-exec 不可用即拒绝。
        // probeSandboxAvailability 单进程缓存；macOS 26 等无法应用 profile 的
        // 版本会在这里返回 false，绝不静默降级为无沙箱执行。
        if (!(await probeSandboxAvailability())) {
          throw new Error(
            'Shell tool unavailable: macOS OS sandbox (sandbox-exec) cannot be applied on this system ' +
              '(sandbox_apply: Operation not permitted). Refusing to run an unsandboxed shell to preserve ' +
              'filesystem containment.',
          );
        }
        const sandbox = MacOSSandbox.forWorkspace(workspaceRoot, permissionMode, networkAccess);
        result = await sandbox.run(cmd, {
          cwd: workDir,
          home,
          tmpdir,
          signal: context.signal,
          onEvent: (event) => {
            if (event === 'started') {
              context.onSandboxEvent?.({ type: 'shell_sandbox_started', platform: 'macos' });
            } else {
              context.onSandboxEvent?.({
                type: 'shell_sandbox_denied',
                platform: 'macos',
                reason: 'workspace_policy',
              });
            }
          },
        });
      } else {
        // 非 darwin：fail-closed，放行需显式同意（仅环境开关；full-access 只放宽
        // 文件边界，不隐含允许无沙箱命令执行）
        if (process.env.PAYASO_SHELL_UNSANDBOXED !== '1') {
          throw new Error(
            'Shell unavailable on this platform: 当前平台无 macOS OS Sandbox，' +
              '为保持文件系统遏制默认拒绝。请设置 PAYASO_SHELL_UNSANDBOXED=1 ' +
              '显式允许无沙箱 shell 后重试（默认关闭）。',
          );
        }
        const host = await discoverShellHost();
        if (!host) {
          throw new Error(
            'Shell unavailable: 未找到 bash 解释器。Windows 请安装 Git for Windows ' +
              '(https://git-scm.com) 后重试。',
          );
        }
        result = await runUncontainedShell(host, cmd, {
          cwd: workDir,
          home,
          tmpdir,
          signal: context.signal,
        });
      }
    } finally {
      if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
    }

    if (result.denied) {
      // Do not expose stderr or host paths to the LLM/context.
      throw new Error('Shell operation denied by workspace sandbox.');
    }

    const missingTool = result.exitCode !== 0 ? missingShellToolName(result.stderr) : undefined;
    if (missingTool !== undefined) {
      // Discovery happens once at process start; a missing optional host tool
      // is a normal recoverable tool error, not a Runtime crash.
      throw new RequiredRuntimeToolUnavailableError(missingTool);
    }

    const head = result.timedOut
      ? '[shell-timeout] 命令超时(10000ms)或强制终止\n'
      : `[shell-exit-${result.exitCode ?? -1}]\n`;
    return (head + result.stdout + result.stderr).trim();
  },
});

// ---- ⑥ loadSkill ----
// 只读工具：加载工作区内 .payaso/skills/<name>/SKILL.md 的完整内容。
// Skill 正文作为 tool 消息进入 transcript，复用裁剪 / 摘要 / checkpoint 全套机制。
// 安全：name 必须是 kebab-case，解析后路径必须落在 .payaso/skills/ 下。
register({
  name: 'loadSkill',
  description:
    'Load a skill definition file from the workspace skill registry. Returns the full SKILL.md content as a tool message. Use this when you need the step-by-step workflow for a specific task type.',
  effect: 'read',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'kebab-case skill name (from the Available Skills list in system prompt)',
      },
    },
    required: ['name'],
  },
  execute: async (args, context) => {
    const rawName = String(args.name ?? '').trim();
    if (!rawName) throw new Error('缺少参数 name');
    // 严格限定字符集，避免路径逃逸
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(rawName)) {
      throw new Error('skill 名称格式不合法（小写字母 + 连字符，最长 64 字符）');
    }
    const relPath = path.join('.payaso', 'skills', rawName, 'SKILL.md');
    const fullPath = resolveAuthorizedPath(context, relPath);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) throw new Error('skill 文件不存在');
      // 上限 32KB，超过的截断（transcript 还有输出卫士二次保险）
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.length > 32 * 1024) {
        return content.slice(0, 32 * 1024) + '\n...[skill content truncated]';
      }
      return content;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`skill 不存在: ${rawName}`);
      }
      throw err;
    }
  },
});
