// 模块: Runtime 工具（grep / glob / createDir / moveFile / deleteFile / shell / loadSkill）
// 安全契约与 filesystem.ts 一致：
// - LLM 只传工作区内相对路径；真实路径由 ToolContext.workspaceRoot + 双重路径校验
// - 全部显式声明 effect（副作用语义必须明确）
// - shell 以当前 context.workspaceRoot 为 cwd；文件系统边界由 macOS OS Sandbox 强制执行
// v1.5 融合身份机制：路径类工具用 canonicalPathKey 做操作 identity 归一化（不暴露宿主绝对路径）。
// v1.7：searchText → grep（目录递归搜索）；createDir 移出核心（hidden），write 已覆盖其核心场景。
// v1.9：grep 升级为正则 + 默认忽略 node_modules/.git/dist 等；新增 glob 工具；
//       两者共用 workspace-scan.ts 的 walker 与 ignore 策略，并各自遵守输出预算。

import fs from 'node:fs';
import path from 'node:path';
import { getNetworkMode } from '../network-mode.js';
import { storedPermissionMode } from '../permission-mode.js';
import { MacOSSandbox, type MacOSSandboxResult, probeSandboxAvailability } from '../sandbox/macos-sandbox.js';
import { createShellScratch } from '../sandbox/shell-scratch.js';
import {
  resolveShellToolTimeout,
  SHELL_TIMEOUT_DEFAULT_MS,
  SHELL_TIMEOUT_MAX_MS,
  SHELL_TIMEOUT_MIN_MS,
  shellTimeoutPolicy,
} from '../sandbox/shell-timeout.js';
import { discoverShellHost, runUncontainedShell } from '../sandbox/shell-host.js';
import { classifyShellCommand } from '../sandbox/shell-command-effect.js';
import {
  getBackgroundJob,
  killBackgroundJob,
  listBackgroundJobs,
  startBackgroundJob,
  waitForBackgroundJob,
} from '../sandbox/background-jobs.js';
import { TOOL_OUTPUT_MAX_BYTES, utf8ByteLength } from '../tool-output-budget.js';
import {
  assertWritableZone,
  canonicalPathKey,
  isProbablyBinary,
  MAX_READ_BYTES,
  resolveAuthorizedPath,
} from './filesystem.js';
import { compileGlob } from './glob-pattern.js';
import { resolveSkillRelativePath } from '../host/workspace-instructions.js';
import {
  RequiredRuntimeToolUnavailableError,
  register,
  registerAlias,
  type ToolContext,
} from './tools.js';
import { scanWorkspaceFiles, SEARCH_MAX_FILE_BYTES } from './workspace-scan.js';

// ---- ① grep（正则 + 默认忽略依赖/构建目录）----
// v1.9：pattern 现在是正则（JavaScript 语法）。旧的字面量子串搜索仍然可用
// （字面量本身是合法正则），但 `a.b` 这类模式语义变为正则——因此结果里会明确
// 回显所用 pattern。默认跳过 node_modules/.git/dist 等（includeIgnored 可关闭），
// 否则 5000 文件预算会被依赖目录吃光，"搜索项目"等于没搜。
register({
  name: 'grep',
  description:
    '在工作区内递归搜索正则表达式（JavaScript RegExp 语法，非字面量）。可指定文件或目录路径；默认跳过 node_modules/.git/dist/build/coverage 等依赖与产物目录（includeIgnored=true 可包含）。自动跳过二进制与超大文件，禁止跟随 symlink 避免逃逸。结果按文件分组并受 16KB 输出预算约束。',
  effect: 'read',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '.').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return `path:${key ?? JSON.stringify(rel)}:re:${args.pattern}:max:${args.maxResults ?? 100}:ignored:${args.includeIgnored === true}`;
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          '正则表达式（JavaScript 语法），如 "function\\\\s+\\\\w+" 或 "TODO|FIXME"。含特殊字符时请正确转义。',
      },
      path: { type: 'string', description: '工作区内相对路径，文件或目录（默认当前目录 .）' },
      maxResults: { type: 'number', description: '最多返回的匹配行数（默认 100，上限 500）' },
      includeIgnored: {
        type: 'boolean',
        description:
          '是否搜索默认忽略的目录（node_modules/.git/dist 等）。默认 false；仅在明确需要时开启。',
      },
    },
    required: ['pattern'],
  },
  execute: async (args, context) => {
    const pattern = String(args.pattern ?? '');
    if (!pattern) throw new Error('缺少参数 pattern');
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      // 非法正则 = 确定性失败（错误分类器不会重试），消息里给出解析器的原因。
      throw new Error(`pattern 不是合法的正则表达式: ${(err as Error).message}`);
    }

    const rel = String(args.path ?? '.').trim();
    const maxResults = Math.min(Math.max(1, Number(args.maxResults ?? 100) || 100), 500);
    const includeIgnored = args.includeIgnored === true;

    const real = resolveAuthorizedPath(context, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(real);
    } catch {
      throw new Error(`路径不存在: ${rel}`);
    }

    // 直接指向单文件时保留旧语义：过大/二进制 → invalid（区别于"没找到"）。
    if (stat.isFile()) {
      if (stat.size > SEARCH_MAX_FILE_BYTES) {
        return `[sandbox-tool-invalid] 文件过大，无法搜索（限制 ${SEARCH_MAX_FILE_BYTES} 字节）: ${rel}`;
      }
      const buf = fs.readFileSync(real);
      if (isProbablyBinary(buf)) {
        return `[sandbox-tool-invalid] 二进制文件，不支持文本搜索: ${rel}`;
      }
    } else if (!stat.isDirectory()) {
      throw new Error(`不是文件也不是目录: ${rel}`);
    }

    const scan = scanWorkspaceFiles({
      root: context.workspaceRoot,
      baseDir: real,
      ignore: !includeIgnored,
    });

    const budget = TOOL_OUTPUT_MAX_BYTES - 512; // 给汇总行留余量
    const groups = new Map<string, string[]>();
    let matchCount = 0;
    let filesScanned = 0;
    let skippedLarge = 0;
    let bytes = 0;
    let budgetHit = false;

    for (const file of scan.files) {
      if (matchCount >= maxResults || budgetHit) break;
      if (file.size > SEARCH_MAX_FILE_BYTES) {
        skippedLarge++;
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(file.absPath);
      } catch {
        continue;
      }
      if (isProbablyBinary(buf)) continue;
      filesScanned++;

      const lines = buf.toString('utf8').split('\n');
      const hits: string[] = [];
      for (let i = 0; i < lines.length && matchCount < maxResults; i++) {
        if (!regex.test(lines[i])) continue;
        const rendered = `  ${i + 1}: ${lines[i].length > 400 ? `${lines[i].slice(0, 400)}…` : lines[i]}`;
        const renderedBytes = utf8ByteLength(rendered) + 1;
        if (bytes + renderedBytes > budget) {
          budgetHit = true;
          break;
        }
        bytes += renderedBytes;
        hits.push(rendered);
        matchCount++;
      }
      if (hits.length > 0) groups.set(file.relPath, hits);
    }

    if (matchCount === 0) {
      return `未找到 "${pattern}"（${rel}；已扫描 ${filesScanned} 个文件${includeIgnored ? '' : '，已忽略依赖/产物目录'}）`;
    }

    const lines: string[] = [];
    for (const [file, hits] of groups) {
      lines.push(file, ...hits);
    }
    const notes: string[] = [
      `找到 ${matchCount} 处匹配（扫描 ${filesScanned} 个文件）${includeIgnored ? '' : '，已忽略依赖/产物目录'}`,
    ];
    if (budgetHit) {
      notes.push(
        `[grep 提示] 结果已达 ${TOOL_OUTPUT_MAX_BYTES} 字节输出预算上限，仅返回前 ${matchCount} 处匹配；请用更精确的 pattern 或 path 缩小范围。`,
      );
    }
    if (matchCount >= maxResults) notes.push(`[grep 提示] 已达 maxResults=${maxResults} 上限。`);
    if (skippedLarge > 0) notes.push(`[grep 提示] 跳过 ${skippedLarge} 个超过 ${SEARCH_MAX_FILE_BYTES} 字节的文件。`);
    if (scan.truncated) notes.push('[grep 提示] 文件数达到扫描上限，结果可能不完整。');
    return [...lines, ...notes].join('\n');
  },
  validateResult: (result) => {
    if (typeof result === 'string' && result.startsWith('[sandbox-tool-invalid]')) {
      return { valid: false, reason: '文件过大或二进制，无法搜索' };
    }
    return true;
  },
});
registerAlias('grep', 'searchText');

// ---- ①.5 glob（按模式查找文件）----
// 与 grep 共用 walker/ignore：grep 找内容，glob 找文件名。模型此前只能靠
// shell 的 find（10s 超时 + 输出预算 + 沙箱），现在有原生工具。
register({
  name: 'glob',
  description:
    '按 glob 模式查找工作区内的文件（支持 *、?、**、{a,b}），返回工作区相对路径，按最近修改时间排序。默认跳过 node_modules/.git/dist 等依赖与产物目录（includeIgnored=true 可包含）。禁止跟随 symlink 逃逸。',
  effect: 'read',
  getOperationKey: (args, context) => {
    const rel = String(args.path ?? '.').trim();
    const key = context ? canonicalPathKey(context, rel) : null;
    return `path:${key ?? JSON.stringify(rel)}:glob:${args.pattern}:max:${args.maxResults ?? 100}:ignored:${args.includeIgnored === true}`;
  },
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'glob 模式，如 "src/**/*.ts"、"**/*.{json,md}"、"*.test.ts"。* 匹配单层任意字符，** 匹配任意层目录。',
      },
      path: { type: 'string', description: '工作区内相对起始目录（默认当前目录 .）' },
      maxResults: { type: 'number', description: '最多返回的文件数（默认 100，上限 500）' },
      includeIgnored: {
        type: 'boolean',
        description:
          '是否包含默认忽略的目录（node_modules/.git/dist 等）。默认 false；仅在明确需要时开启。',
      },
    },
    required: ['pattern'],
  },
  execute: async (args, context) => {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) throw new Error('缺少参数 pattern');
    let compiled: ReturnType<typeof compileGlob>;
    try {
      compiled = compileGlob(pattern);
    } catch (err) {
      throw new Error(`pattern 不是合法的 glob: ${(err as Error).message}`);
    }

    const rel = String(args.path ?? '.').trim();
    const maxResults = Math.min(Math.max(1, Number(args.maxResults ?? 100) || 100), 500);
    const includeIgnored = args.includeIgnored === true;

    const real = resolveAuthorizedPath(context, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(real);
    } catch {
      throw new Error(`路径不存在: ${rel}`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`不是文件也不是目录: ${rel}`);
    }

    const scan = scanWorkspaceFiles({
      root: context.workspaceRoot,
      baseDir: real,
      ignore: !includeIgnored,
    });
    const matched = scan.files
      .filter((file) => compiled.regex.test(file.relPath))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.relPath < b.relPath ? -1 : 1));

    if (matched.length === 0) {
      return `未找到匹配 "${pattern}" 的文件（起始路径 ${rel}；已扫描 ${scan.files.length} 个文件${includeIgnored ? '' : '，已忽略依赖/产物目录'}）`;
    }

    const budget = TOOL_OUTPUT_MAX_BYTES - 512;
    const lines: string[] = [];
    let bytes = 0;
    let budgetHit = false;
    for (const file of matched) {
      if (lines.length >= maxResults) break;
      const rendered = `${file.relPath} (${file.size} bytes)`;
      const renderedBytes = utf8ByteLength(rendered) + 1;
      if (bytes + renderedBytes > budget) {
        budgetHit = true;
        break;
      }
      bytes += renderedBytes;
      lines.push(rendered);
    }

    const notes = [`找到 ${matched.length} 个匹配文件（共扫描 ${scan.files.length} 个）`];
    if (lines.length < matched.length) {
      notes.push(
        `[glob 提示] 仅返回前 ${lines.length} 个（${budgetHit ? `${TOOL_OUTPUT_MAX_BYTES} 字节输出预算` : `maxResults=${maxResults}`} 上限）。`,
      );
    }
    if (scan.truncated) notes.push('[glob 提示] 文件数达到扫描上限，结果可能不完整。');
    return [...lines, ...notes].join('\n');
  },
});

// 从 shell stderr 识别"命令缺失"（导出供测试纯函数直接验证，不依赖真实沙箱）。
// Only normalize the shell's own command lookup failure. Do not inspect or
// rewrite the model command, and do not mistake an arbitrary program's
// "package not found"/similar diagnostic for a missing executable.
export function missingShellToolName(stderr: string): string | undefined {
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

// ---- ⑤ shell（前台 + 后台）----
// 前台：等待命令结束（超时由 shell-timeout 策略收敛）。
// 后台（background=true）：立即返回 jobId，由 shellJob 轮询/终止；长测试、构建
// 不再占满整个回合。两条路径共用同一受管 scratch 与沙箱执行器。
async function executeContainedShell(
  command: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<MacOSSandboxResult> {
  const workspaceRoot = context.workspaceRoot;
  const permissionMode = storedPermissionMode(context.permissionMode);
  // Scratch（HOME/TMPDIR）：所有权限模式下都放在受管临时根目录，而不是
  // Workspace 内。Read Only 下命令仍需要可写的缓存目录（npm/npx/git/tsx），
  // 而 Workspace 必须保持只读；Workspace Write 下也避免污染用户项目。
  const scratch = createShellScratch(context.runId);
  try {
    // 双通道（docs/windows-mac-compat.md §3）：
    // - macOS：Seatbelt 沙箱，fail-closed——sandbox-exec 不可用即拒绝，绝不静默降级
    // - 其他平台：无 OS 沙箱原语，默认同样拒绝（延续"绝不静默降低遏制"原则），
    //   仅当用户显式选择审批模式或设置 PAYASO_SHELL_UNSANDBOXED=1 才放行
    let result: MacOSSandboxResult;
    if (process.platform === 'darwin') {
      if (!(await probeSandboxAvailability())) {
        throw new Error(
          'Shell tool unavailable: macOS OS sandbox (sandbox-exec) cannot be applied on this system ' +
            '(sandbox_apply: Operation not permitted). Refusing to run an unsandboxed shell to preserve ' +
            'filesystem containment.',
        );
      }
      // v1.10 回归修复：运行时注入 context.networkMode；测试/CLI 缺省时回退全局
      // getNetworkMode()（默认 on）。若按 undefined 判为 off，沙箱 profile 加
      // (deny network*)，会连带拦截 AF_UNIX socket 创建 → tsx/npx listen EPERM。
      const networkAccess = (context.networkMode ?? getNetworkMode()) === 'on';
      const sandbox = MacOSSandbox.forWorkspace(workspaceRoot, permissionMode, networkAccess, {
        scratchRoots: [scratch.path],
      });
      result = await sandbox.run(command, {
        cwd: workspaceRoot,
        home: scratch.path,
        tmpdir: scratch.path,
        timeoutMs,
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
      result = await runUncontainedShell(host, command, {
        cwd: workspaceRoot,
        home: scratch.path,
        tmpdir: scratch.path,
        timeoutMs,
        signal: context.signal,
      });
    }
    if (result.denied) {
      // Do not expose stderr or host paths to the LLM/context.
      throw new Error(
        'Shell operation denied by the workspace sandbox (filesystem policy). ' +
          'The command attempted to write outside the allowed roots.',
      );
    }
    const missingTool = result.exitCode !== 0 ? missingShellToolName(result.stderr) : undefined;
    if (missingTool !== undefined) {
      // Discovery happens once at process start; a missing optional host tool
      // is a normal recoverable tool error, not a Runtime crash.
      throw new RequiredRuntimeToolUnavailableError(missingTool);
    }
    return result;
  } finally {
    scratch.dispose();
  }
}

function formatShellResult(result: MacOSSandboxResult, timeoutMs: number): string {
  const head = result.timedOut
    ? `[shell-timeout] 命令超时(${timeoutMs}ms)或强制终止\n`
    : `[shell-exit-${result.exitCode ?? -1}]\n`;
  return (head + result.stdout + result.stderr).trim();
}

register({
  name: 'shell',
  description:
    `执行一条 shell 命令（cwd=Workspace，非交互，输出限 ${Math.round(TOOL_OUTPUT_MAX_BYTES / 1024)}KB；macOS 走 OS Sandbox，其他平台需审批模式）。` +
    `前台默认超时 ${Math.round(SHELL_TIMEOUT_DEFAULT_MS / 1000)}s；background=true 且未传 timeoutMs 时默认 ${Math.round(SHELL_TIMEOUT_MAX_MS / 1000)}s；` +
    `可用 timeoutMs 调整（上限 ${Math.round(SHELL_TIMEOUT_MAX_MS / 1000)}s，下限 ${Math.round(SHELL_TIMEOUT_MIN_MS / 1000)}s）。` +
    `超时会整树终止并返回 [shell-timeout]。background=true 时立即返回 jobId，用 shellJob wait 等待（长测试、构建用），不要用 shell sleep 轮询。` +
    `分钟级命令的输出请先重定向到工作区文件（如 .payaso/logs/xxx.log），再用 read/grep 按需复查：tail/grep 管道会切掉关键失败行，为换一个切片重复执行同一条长命令是纯浪费。` +
    `HOME/TMPDIR 是单次 shell 调用的可写 scratch，调用结束即删除，不能跨调用传文件，也不代表 Workspace 可写。` +
    `非零退出不算验证通过；若 Read Only 权限阻止测试写文件，结果是不确定，不能据此宣称代码无缺陷。` +
    `文件访问服从当前 Read Only/Workspace Write/Full access 权限；网络能力跟随全局 network.mode（默认 on=联网）。`,
  effect: 'non_idempotent',
  // v1.9：按命令细化 effect —— 只读命令（ls/git log/find 等，且不含 shell 组合
  // 或重定向）声明为 read，避免副作用守卫回放缓存结果。后台作业始终视为
  // non_idempotent：同一条命令不应因为"只读"而启动第二个作业。
  resolveEffect: (args) =>
    args.background === true
      ? 'non_idempotent'
      : classifyShellCommand(String(args.command ?? '')).effect,
  // v2.0 Network Control：shell 具备网络能力。第一版保守策略——不对 curl/wget/git
  // 做命令识别；network.mode=off 时整个 shell 被统一拒绝（tools.ts execute 检查）。
  capabilities: { network: true },
  getOperationKey: (args) =>
    `cmd:${String(args.command ?? '').trim()}:bg:${args.background === true}`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要在当前 Workspace 根目录执行的 shell 命令' },
      timeoutMs: {
        type: 'number',
        description:
          `可选：本次命令的超时毫秒数（${SHELL_TIMEOUT_MIN_MS}-${SHELL_TIMEOUT_MAX_MS}，超出范围会被收敛）。` +
          `前台不传使用运行时默认值；后台不传使用运行时上限。`,
      },
      background: {
        type: 'boolean',
        description:
          '可选：true 时命令在后台运行并立即返回 jobId（不阻塞本轮），优先用 shellJob wait 等待结果。适合长测试、构建、安装。',
      },
    },
    required: ['command'],
  },
  execute: async (args, context) => {
    const cmd = String(args.command ?? '').trim();
    if (!cmd) throw new Error('缺少参数 command');
    const timeoutMs = resolveShellToolTimeout(
      args.timeoutMs,
      args.background === true,
      shellTimeoutPolicy(),
    );

    if (args.background === true) {
      const job = startBackgroundJob({
        runId: context.runId,
        command: cmd,
        parentSignal: context.signal,
        executor: (signal) =>
          executeContainedShell(cmd, { ...context, signal }, timeoutMs),
      });
      return (
        `[shell-background] jobId=${job.jobId} status=running timeoutMs=${timeoutMs}\n` +
        `命令: ${cmd}\n` +
        `等待: shellJob {action:"wait", jobId:"${job.jobId}", waitMs:30000}\n` +
        `也可继续其他工作，稍后再 wait；不要用 shell sleep 轮询。`
      );
    }

    const result = await executeContainedShell(cmd, context, timeoutMs);
    return formatShellResult(result, timeoutMs);
  },
});

// ---- ⑤.5 shellJob（后台作业控制）----
// 只读查询 + 幂等终止；作业生命周期由 Host 在 Run 终态统一回收。
register({
  name: 'shellJob',
  description:
    '等待/查看/终止 shell 后台作业。优先用 "wait" 有界等待，避免反复 status/output 或 shell sleep。action: "list" 列出本 Run 全部作业；"wait" 最多等待 waitMs 后返回最新状态和完成输出；"status" 查状态；"output" 取回已完成输出；"kill" 终止。作业随 Run 结束自动清理。',
  effect: 'idempotent',
  getOperationKey: (args) => `job:${String(args.action ?? '')}:${String(args.jobId ?? '')}`,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'wait', 'status', 'output', 'kill'],
        description: 'list / wait / status / output / kill',
      },
      jobId: {
        type: 'string',
        description: '作业 id（如 job-1）；action=list 时可省略',
      },
      waitMs: {
        type: 'number',
        description: 'action=wait 时最多等待的毫秒数，默认 30000，范围 100-30000。',
      },
    },
    required: ['action'],
  },
  execute: async (args, context) => {
    const action = String(args.action ?? '').trim();
    const jobId = String(args.jobId ?? '').trim();

    // 先校验 action：schema 的 enum 已挡住模型的非法值，这里保证直接调用方
    // 也拿到"未知 action"而不是误导性的"作业不存在"。
    if (!['list', 'wait', 'status', 'output', 'kill'].includes(action)) {
      throw new Error(`未知 action: ${action}（可用 list / wait / status / output / kill）`);
    }

    if (action === 'list') {
      const jobs = listBackgroundJobs(context.runId);
      if (jobs.length === 0) return '当前 Run 没有后台作业。';
      return jobs
        .map(
          (job) =>
            `${job.jobId} [${job.status}] ${job.command}（启动 ${job.startedAt}${job.finishedAt ? `，结束 ${job.finishedAt}` : ''}）`,
        )
        .join('\n');
    }

    if (!jobId) throw new Error(`action=${action} 需要参数 jobId`);
    let job = getBackgroundJob(context.runId, jobId);
    if (!job) throw new Error(`后台作业不存在: ${jobId}（用 shellJob {action:"list"} 查看）`);

    if (action === 'wait') {
      const requested = Number(args.waitMs);
      const waitMs = Number.isFinite(requested)
        ? Math.min(30_000, Math.max(100, Math.floor(requested)))
        : 30_000;
      job = await waitForBackgroundJob(context.runId, jobId, waitMs, context.signal);
      if (!job) throw new Error(`后台作业不存在: ${jobId}`);
      if (job.status === 'running') {
        return `${job.jobId} [running] 等待 ${waitMs}ms 后仍在运行；可继续工作，稍后再次 wait。`;
      }
      const body = job.output?.trim() ? job.output : '(无输出)';
      return `[${job.jobId} ${job.status}]\n${body}${job.error ? `\n[error] ${job.error}` : ''}`;
    }

    if (action === 'status') {
      return (
        `${job.jobId} [${job.status}] ${job.command}\n` +
        `启动: ${job.startedAt}${job.finishedAt ? `\n结束: ${job.finishedAt}` : ''}` +
        (job.error ? `\n错误: ${job.error}` : '') +
        (job.status === 'running' ? '\n（仍在运行；优先用 action:"wait" 等待，或 action:"kill" 终止）' : '')
      );
    }

    if (action === 'output') {
      if (job.status === 'running') {
        return `${job.jobId} 仍在运行中，暂无输出（完成后用 action:"output" 取回）。`;
      }
      const body = job.output?.trim() ? job.output : '(无输出)';
      return `[${job.jobId} ${job.status}]\n${body}${job.error ? `\n[error] ${job.error}` : ''}`;
    }

    if (action === 'kill') {
      const existed = killBackgroundJob(context.runId, jobId);
      if (!existed) throw new Error(`后台作业不存在: ${jobId}`);
      const after = getBackgroundJob(context.runId, jobId);
      return `已请求终止 ${jobId}（当前状态: ${after?.status ?? 'unknown'}）。`;
    }

    // 不可达：action 已在上方白名单校验
    throw new Error(`未知 action: ${action}`);
  },
});

// ---- ⑥ loadSkill ----
// 只读工具：加载工作区内 .payaso/skills/<name>/SKILL.md 的完整内容。
// Skill 正文作为 tool 消息进入 transcript，复用裁剪 / 摘要 / checkpoint 全套机制。
// 安全：name 必须是 kebab-case，解析后路径必须落在 .payaso/skills/ 下。
register({
  name: 'loadSkill',
  description:
    'Load a skill definition file from the workspace skill registry (.payaso/skills, .claude/skills, .pi/skills). Returns the full SKILL.md content as a tool message. Use this when you need the step-by-step workflow for a specific task type.',
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
    // v1.9：与 Host 共用同一发现策略（.payaso / .claude / .pi，优先级顺序）。
    const relPath = resolveSkillRelativePath(context.workspaceRoot, rawName);
    if (relPath === null) throw new Error(`skill 不存在: ${rawName}`);
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
