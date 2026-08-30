// macOS OS-level sandbox launcher.
//
// This uses Apple's seatbelt sandbox via /usr/bin/sandbox-exec. The policy is
// default-deny; descendants inherit the sandbox from the launched /bin/sh.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createSandboxPolicy,
  canonicalizeSandboxPath,
  isSandboxPathInside,
  type SandboxPolicy,
} from "./sandbox-policy.js";
import type { PermissionMode } from "../permission-mode.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SHELL = "/bin/sh";
const SHELL_TIMEOUT_MS = 10_000;
const MAX_SHELL_OUTPUT = 64 * 1024;

// ---- Capability probe (fail-closed gate) ----
// sandbox-exec is deprecated by Apple and on some newer macOS releases it can
// no longer apply ANY profile (e.g. macOS 26: "sandbox_apply: Operation not
// permitted", exit 71), even for an empty policy. We must never run an
// uncontained shell, so the shell tool refuses to execute when the OS
// sandbox primitive is unavailable. Probe once per process and cache it.
let sandboxAvailability: boolean | null = null;

export async function probeSandboxAvailability(): Promise<boolean> {
  if (sandboxAvailability !== null) return sandboxAvailability;
  if (process.platform !== "darwin" || !fs.existsSync(SANDBOX_EXEC)) {
    sandboxAvailability = false;
    return sandboxAvailability;
  }
  // Mirror the real shell profile's bootstrap dependencies (system.sb import),
  // so a working sandbox_exec completes with exit 0.
  const probeProfile = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow process-exec)",
    '(allow file-read* (subpath "/usr/bin"))',
  ].join("\n");
  const ok = await new Promise<boolean>((resolve) => {
    execFile(
      SANDBOX_EXEC,
      ["-p", probeProfile, "/usr/bin/true"],
      { timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
      (err) => resolve(!err)
    );
  });
  sandboxAvailability = ok;
  return ok;
}

// Keep the existing shell command environment small and deterministic.
const NODE_INSTALL_ROOT = fs.realpathSync.native(path.resolve(path.dirname(process.execPath), ".."));
const NODE_BIN_ROOT = fs.realpathSync.native(path.dirname(process.execPath));
const npmEntry = path.join(NODE_BIN_ROOT, "npm");
const NPM_INSTALL_ROOT = fs.existsSync(npmEntry)
  ? path.dirname(path.dirname(fs.realpathSync.native(npmEntry)))
  : null;
const SAFE_PATH = `${NODE_BIN_ROOT}:/usr/bin:/bin:/usr/sbin:/sbin`;

// Homebrew's Node binary links against formula-owned dylibs outside the Node
// Cellar. Discover the exact Mach-O dependency closure and grant read access to
// those files only; do not widen the policy to all of /opt/homebrew.
function discoverNodeRuntimeLibraries(): {
  canonical: string[];
  requested: string[];
  canonicalRoots: string[];
  requestedRoots: string[];
} {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/otool")) {
    return { canonical: [], requested: [], canonicalRoots: [], requestedRoots: [] };
  }
  const pending = [process.execPath];
  const inspected = new Set<string>();
  const canonical = new Set<string>();
  const requested = new Set<string>();
  const canonicalRoots = new Set<string>();
  const requestedRoots = new Set<string>();
  while (pending.length > 0 && inspected.size < 256) {
    const binary = pending.pop()!;
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(binary);
    } catch {
      continue;
    }
    if (inspected.has(resolved)) continue;
    inspected.add(resolved);
    const result = spawnSync("/usr/bin/otool", ["-L", resolved], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") continue;
    for (const line of result.stdout.split("\n").slice(1)) {
      const dependency = line.trim().split(/\s+\(/, 1)[0];
      if (!dependency?.startsWith("/") || !fs.existsSync(dependency)) continue;
      const target = fs.realpathSync.native(dependency);
      // System libraries already have narrowly declared roots below. The Node
      // installation itself is also covered as a root.
      if (
        target.startsWith("/usr/lib/") ||
        target.startsWith("/System/Library/") ||
        target === NODE_INSTALL_ROOT ||
        target.startsWith(NODE_INSTALL_ROOT + path.sep)
      ) continue;
      requested.add(dependency);
      canonical.add(target);
      const requestedRoot = path.dirname(path.dirname(dependency));
      requestedRoots.add(requestedRoot);
      canonicalRoots.add(fs.realpathSync.native(requestedRoot));
      pending.push(target);
    }
  }
  return {
    canonical: [...canonical],
    requested: [...requested],
    canonicalRoots: [...canonicalRoots],
    requestedRoots: [...requestedRoots],
  };
}

const NODE_RUNTIME_LIBRARIES = discoverNodeRuntimeLibraries();
const NODE_RUNTIME_CONFIG_PATHS = ["/opt/homebrew/etc/openssl@3/openssl.cnf"]
  .filter((candidate) => fs.existsSync(candidate))
  .map((candidate) => fs.realpathSync.native(candidate));

// These are the system paths needed to load and run standard macOS command
// line tools. No /private/etc, user home, /tmp, or other host data roots are
// opened by default. Network is explicitly out of scope for this phase.
const MACOS_SYSTEM_READ_ROOTS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/System/Library",
  "/dev/null",
  "/dev/urandom",
  "/dev/random",
  // The Host's own Node distribution is read/exec-only. This allows project
  // commands such as npm test while keeping user data outside Workspace denied.
  NODE_INSTALL_ROOT,
  ...(NPM_INSTALL_ROOT ? [NPM_INSTALL_ROOT] : []),
  ...NODE_RUNTIME_LIBRARIES.canonical,
  ...NODE_RUNTIME_LIBRARIES.canonicalRoots,
  ...NODE_RUNTIME_CONFIG_PATHS,
];

export type MacOSSandboxEvent = "started" | "denied";

export interface MacOSSandboxResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  denied: boolean;
}

export interface MacOSSandboxRunOptions {
  cwd: string;
  home: string;
  tmpdir: string;
  timeoutMs?: number;
  // True cancellation (v1.6)：Run 的 AbortSignal；abort 时终止整个进程组并 reject AbortError
  signal?: AbortSignal;
  onEvent?: (event: MacOSSandboxEvent) => void;
}

// 终止整个进程组：detached spawn 使 child 成为进程组长（pgid = pid），
// kill(-pid) 覆盖 sandbox-exec 及其全部子孙（/bin/sh -c 的子命令不会残留）。
// SIGTERM 给短暂 cleanup 窗口，超时后 SIGKILL 兜底；不引入全局 process manager。
export function terminateProcessTree(child: ChildProcess, graceMs = 1_000): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
  signalGroup("SIGTERM");
  const killer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
  killer.unref?.();
  child.once("close", () => clearTimeout(killer));
}

function schemeString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function profilePathRule(root: string): string {
  const stat = fs.statSync(root);
  return stat.isDirectory()
    ? `(subpath ${schemeString(root)})`
    : `(literal ${schemeString(root)})`;
}

function isExecutableRoot(root: string, workspaceRoot: string): boolean {
  return (
    root === workspaceRoot ||
    root === "/bin" ||
    root === "/sbin" ||
    root === "/usr/bin" ||
    root === "/usr/sbin" ||
    root === NODE_INSTALL_ROOT ||
    root === NODE_BIN_ROOT ||
    root === NPM_INSTALL_ROOT
  );
}

function pathAncestors(target: string): string[] {
  const out: string[] = [];
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    out.push(current);
    current = path.dirname(current);
  }
  out.push(current);
  return out;
}

function profileFor(policy: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    // Apple’s system profile supplies the dyld/cry​​ptex bootstrap rules and
    // standard special files required before /bin/sh can start. Without it,
    // a narrowly scoped custom profile aborts during process bootstrap.
    '(import "system.sb")',
    // Permit the shell and its descendants to fork/exec, while file access
    // remains controlled by the explicit file-read/file-write rules below.
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal)",
    "(allow sysctl-read)",
    // Network Capability Separation (v1.6)：文件系统权限 ≠ 网络权限。
    // deny default 之外再显式 deny/allow network*：deny 在 seatbelt 中优先于
    // 任何 allow 规则，socket/connect 直接 EPERM。shell 固定 deny —— 未来联网
    // 能力必须走独立的 Browser/Network provider policy，绝不重新放开 shell。
    policy.networkAccess ? "(allow network*)" : "(deny network*)",
    // macOS shell selector symlink; target binaries remain covered by /bin.
    '(allow file-read* (literal "/private/var/select/sh"))',
  ];

  // Resolving an allowed executable symlink (notably npm -> npm-cli.js) needs
  // lstat access to its ancestor directories. Metadata-only literals permit
  // canonicalization without granting directory listing or file-content reads.
  const metadataAncestors = new Set(
    [...policy.readableRoots, ...NODE_RUNTIME_LIBRARIES.requestedRoots]
      .flatMap((root) => pathAncestors(root))
  );
  for (const ancestor of metadataAncestors) {
    lines.push(`(allow file-read-metadata (literal ${schemeString(ancestor)}))`);
  }

  if (policy.permissionMode === "full-access") {
    // Full access lifts only the filesystem boundary. It still runs inside
    // Seatbelt so the explicit network deny above remains inherited by every
    // child process. macOS user permissions, ACL, TCC and SIP still apply.
    lines.push("(allow file-read*)");
    lines.push("(allow file-write*)");
  } else {
    // dyld requests Homebrew libraries through /opt/homebrew/opt/... symlink
    // paths, while the canonical targets live in Cellar. Permit both exact
    // file identities. dyld needs to traverse symlinks within each dependency
    // formula, so permit only the discovered formula roots—not all Homebrew.
    for (const formulaRoot of NODE_RUNTIME_LIBRARIES.requestedRoots) {
      lines.push(`(allow file-read* (subpath ${schemeString(formulaRoot)}))`);
    }
    for (const library of NODE_RUNTIME_LIBRARIES.requested) {
      lines.push(`(allow file-read* (literal ${schemeString(library)}))`);
    }
    for (const root of policy.readableRoots) {
      const operation = isExecutableRoot(root, policy.workspaceRoot)
        ? "file-read* process-exec"
        : "file-read*";
      lines.push(`(allow ${operation} ${profilePathRule(root)})`);
    }
    for (const root of policy.writableRoots) {
      lines.push(`(allow file-write* ${profilePathRule(root)})`);
    }
  }

  return lines.join("\n");
}

function isPermissionDenied(stderr: string): boolean {
  return /operation not permitted|permission denied|sandbox|deny\(/i.test(stderr);
}

function outputLimit(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_SHELL_OUTPUT) return value;
  const buf = Buffer.from(value, "utf8");
  return buf.subarray(0, MAX_SHELL_OUTPUT).toString("utf8") + "\n...[输出已截断]";
}

export class MacOSSandbox {
  readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    if (process.platform !== "darwin") {
      throw new Error("macOS OS sandbox is only available on darwin");
    }
    if (!fs.existsSync(SANDBOX_EXEC)) {
      throw new Error("macOS OS sandbox launcher is unavailable: sandbox-exec");
    }
    this.policy = policy;
  }

  static forWorkspace(workspaceRoot: string, permissionMode: PermissionMode = "workspace-write"): MacOSSandbox {
    const policy = createSandboxPolicy(workspaceRoot, {
      readableRoots: MACOS_SYSTEM_READ_ROOTS,
      writableRoots: permissionMode === "workspace-write" ? [workspaceRoot] : [],
      permissionMode,
      // shell 的网络策略永远显式 false（fail-closed）——不依赖"默认刚好是 deny"，
      // 也不给调用方留任何隐式放开网络的入口（CLI / Host / Web 同一策略）。
      networkAccess: false,
    });
    return new MacOSSandbox(policy);
  }

  async run(command: string, options: MacOSSandboxRunOptions): Promise<MacOSSandboxResult> {
    const cwd = canonicalizeSandboxPath(options.cwd);
    const home = canonicalizeSandboxPath(options.home);
    const tmpdir = canonicalizeSandboxPath(options.tmpdir);
    if (!isSandboxPathInside(this.policy.workspaceRoot, cwd)) {
      throw new Error("shell cwd must be inside the sandbox workspace");
    }
    if (!isSandboxPathInside(this.policy.workspaceRoot, home)) {
      throw new Error("shell HOME must be inside the sandbox workspace");
    }
    if (!isSandboxPathInside(this.policy.workspaceRoot, tmpdir)) {
      throw new Error("shell TMPDIR must be inside the sandbox workspace");
    }

    options.onEvent?.("started");
    const env = {
      PATH: SAFE_PATH,
      HOME: home,
      TMPDIR: tmpdir,
      LC_ALL: "C",
    };
    const timeout = options.timeoutMs ?? SHELL_TIMEOUT_MS;
    const profile = profileFor(this.policy);

    return await new Promise<MacOSSandboxResult>((resolve, reject) => {
      // detached: child 成为进程组长（pgid = pid），超时/abort 时可整组终止，
      // 避免 sandbox-exec 被杀后 /bin/sh 的子孙命令继续运行。
      const child = spawn(
        SANDBOX_EXEC,
        ["-p", profile, SHELL, "-c", command],
        { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateProcessTreeForce(child);
      }, timeout);

      const onAbort = (): void => {
        aborted = true;
        terminateProcessTree(child);
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_SHELL_OUTPUT * 4) stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_SHELL_OUTPUT * 4) stderr += String(chunk);
      });

      child.on("error", (err) => {
        settle(() => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error("macOS OS sandbox launcher unavailable: sandbox-exec"));
          } else {
            reject(err);
          }
        });
      });

      child.on("close", (code, signalTerm) => {
        settle(() => {
          // abort 后才退出的进程：如果命令已正常跑完（exit 0），按成功处理
          // （副作用确实发生了，由 Agent 层决定后续）；否则视为被取消。
          if (aborted && (signalTerm !== null || code !== 0)) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const denied = code !== 0 && isPermissionDenied(stderr);
          if (denied) options.onEvent?.("denied");
          resolve({
            exitCode: code,
            signal: signalTerm ?? null,
            stdout: outputLimit(stdout),
            stderr: outputLimit(stderr),
            timedOut,
            denied,
          });
        });
      });
    });
  }
}

// 超时路径直接 SIGKILL 整组（与原 execFile killSignal: SIGKILL 语义一致）
function terminateProcessTreeForce(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

export { MAX_SHELL_OUTPUT, SHELL_TIMEOUT_MS };
