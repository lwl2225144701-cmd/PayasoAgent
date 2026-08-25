// macOS OS-level sandbox launcher.
//
// This uses Apple's seatbelt sandbox via /usr/bin/sandbox-exec. The policy is
// default-deny; descendants inherit the sandbox from the launched /bin/sh.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  createSandboxPolicy,
  canonicalizeSandboxPath,
  isSandboxPathInside,
  type SandboxPolicy,
} from "./sandbox-policy.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SHELL = "/bin/sh";
const SHELL_TIMEOUT_MS = 10_000;
const MAX_SHELL_OUTPUT = 64 * 1024;

// Keep the existing shell command environment small and deterministic.
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

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
  onEvent?: (event: MacOSSandboxEvent) => void;
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
    root === "/usr/sbin"
  );
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
    // Networking is deliberately not redesigned in this phase. Keeping it
    // allowed preserves the pre-existing shell capability; filesystem access
    // is still default-deny.
    "(allow network*)",
  ];

  for (const root of policy.readableRoots) {
    const operation = isExecutableRoot(root, policy.workspaceRoot)
      ? "file-read* process-exec"
      : "file-read*";
    lines.push(`(allow ${operation} ${profilePathRule(root)})`);
  }
  for (const root of policy.writableRoots) {
    lines.push(`(allow file-write* ${profilePathRule(root)})`);
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

  static forWorkspace(workspaceRoot: string): MacOSSandbox {
    const policy = createSandboxPolicy(workspaceRoot, {
      readableRoots: MACOS_SYSTEM_READ_ROOTS,
      writableRoots: [workspaceRoot],
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
      execFile(
        SANDBOX_EXEC,
        ["-p", profile, SHELL, "-c", command],
        {
          cwd,
          env,
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: MAX_SHELL_OUTPUT * 2,
        },
        (err, stdout, stderr) => {
          const error = err as (Error & { code?: number | string; signal?: NodeJS.Signals; killed?: boolean }) | null;
          if (error?.code === "ENOENT") {
            reject(new Error("macOS OS sandbox launcher unavailable: sandbox-exec"));
            return;
          }

          const out = String(stdout ?? "");
          const errOut = String(stderr ?? "");
          const exitCode = typeof error?.code === "number" ? error.code : error ? null : 0;
          const timedOut = !!error?.killed;
          const denied = exitCode !== 0 && isPermissionDenied(errOut);
          if (denied) options.onEvent?.("denied");
          resolve({
            exitCode,
            signal: error?.signal ?? null,
            stdout: outputLimit(out),
            stderr: outputLimit(errOut),
            timedOut,
            denied,
          });
        }
      );
    });
  }
}

export { MAX_SHELL_OUTPUT, SHELL_TIMEOUT_MS };
