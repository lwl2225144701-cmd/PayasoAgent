// macOS toolchain discovery for the OS sandbox.
//
// The shell is intentionally still a real shell: this module does not inspect
// or rewrite model-provided command strings. It discovers the host tools that
// are available when Payaso starts, resolves their canonical paths, and gives
// the Seatbelt profile the runtime roots needed to launch them and their
// descendants.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type ToolSource = "managed" | "host" | "missing";

export interface ToolchainTool {
  name: string;
  source: ToolSource;
  executable?: string;
  readableRoots: string[];
  readablePathAliases: string[];
  executableRoots: string[];
  reason?: string;
}

export interface ToolchainManifest {
  platform: NodeJS.Platform | string;
  /** The only PATH passed to the confined shell. */
  safePath: string;
  /** Runtime roots that may be read by a confined shell. */
  readableRoots: string[];
  /** Runtime roots from which a confined shell may execute files. */
  executableRoots: string[];
  /** Verified non-canonical request paths required by dyld (for example /opt/homebrew/opt/*). */
  readablePathAliases: string[];
  tools: Record<string, ToolchainTool>;
}

export interface ToolchainDiscoveryOptions {
  platform?: NodeJS.Platform | string;
  pathValue?: string;
  nodeExecutable?: string;
  commands?: readonly string[];
}

// Model/Host-facing capability projection. It deliberately contains no
// executable, PATH, or filesystem root: those are sandbox-internal details.
// The full ToolchainManifest must never cross this boundary.
export type RuntimeToolAvailability = "available" | "missing";

export interface RuntimeToolCapability {
  status: RuntimeToolAvailability;
  source?: Exclude<ToolSource, "missing">;
  reason?: "not_found" | "unsupported_platform";
}

export interface RuntimeToolchainCapabilities {
  platform: "macos" | "unsupported";
  discovery: "startup";
  tools: Record<string, RuntimeToolCapability>;
}

export const DEFAULT_TOOLCHAIN_COMMANDS = ["git", "node", "npm"] as const;

const SYSTEM_READ_ROOTS = [
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

const SYSTEM_EXECUTABLE_ROOTS = ["/bin", "/sbin", "/usr/bin", "/usr/sbin"];
const OTOOL = "/usr/bin/otool";
const DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_DEPENDENCY_FILES = 512;
const RUNTIME_CONFIG_PATHS = ["/opt/homebrew/etc/openssl@3/openssl.cnf"];

function existingPath(input: string): string | undefined {
  try {
    return fs.realpathSync.native(path.resolve(input));
  } catch {
    return undefined;
  }
}

function existingDirectory(input: string): string | undefined {
  const resolved = existingPath(input);
  if (resolved === undefined) return undefined;
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isExecutable(input: string): boolean {
  try {
    const stat = fs.statSync(input);
    if (!stat.isFile()) return false;
    fs.accessSync(input, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueExisting(paths: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    const canonical = existingPath(candidate);
    if (canonical === undefined || seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
}

/** Resolve a bare command using only absolute PATH entries. */
export function resolveExecutableFromPath(
  command: string,
  pathValue: string,
  delimiter = path.delimiter,
): string | undefined {
  if (!command || command.includes(path.sep) || command.includes("/")) return undefined;
  for (const rawDirectory of pathValue.split(delimiter)) {
    if (!rawDirectory || !path.isAbsolute(rawDirectory)) continue;
    const directory = existingDirectory(rawDirectory);
    if (directory === undefined) continue;
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return existingPath(candidate);
  }
  return undefined;
}

function dependencyRoot(dependency: string): string | undefined {
  const directory = path.dirname(dependency);
  // Homebrew and similar formula layouts use <prefix>/opt/<formula>/lib/…
  // or <prefix>/Cellar/<formula>/<version>/lib/…. Keeping the formula root
  // allows dyld to traverse the symlinked request path without opening the
  // entire package manager prefix.
  return existingDirectory(path.dirname(directory));
}

function requestedDependencyRoot(dependency: string): string | undefined {
  const directory = path.dirname(path.resolve(dependency));
  const root = path.dirname(directory);
  try {
    return fs.existsSync(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

function isSystemDependency(target: string): boolean {
  return (
    target === "/usr/lib" ||
    target.startsWith("/usr/lib/") ||
    target === "/System/Library" ||
    target.startsWith("/System/Library/")
  );
}

function otoolDependencies(binary: string): string[] {
  if (!fs.existsSync(OTOOL)) return [];
  const result = spawnSync(OTOOL, ["-L", binary], {
    encoding: "utf8",
    timeout: DISCOVERY_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return result.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0])
    .filter((candidate): candidate is string => candidate.startsWith("/") && fs.existsSync(candidate));
}

function machODependencyClosure(seeds: readonly string[]): {
  readableRoots: string[];
  readablePathAliases: string[];
  dependencies: string[];
} {
  const pending = [...seeds];
  const inspected = new Set<string>();
  const dependencies = new Set<string>();
  const roots = new Set<string>();
  const aliases = new Set<string>();

  while (pending.length > 0 && inspected.size < MAX_DEPENDENCY_FILES) {
    const candidate = pending.pop();
    if (candidate === undefined) continue;
    const binary = existingPath(candidate);
    if (binary === undefined || inspected.has(binary)) continue;
    inspected.add(binary);

    for (const requested of otoolDependencies(binary)) {
      const canonical = existingPath(requested);
      if (canonical === undefined) continue;
      if (!isSystemDependency(canonical)) {
        dependencies.add(requested);
        dependencies.add(canonical);
        if (requested !== canonical) aliases.add(requested);
        const requestedRoot = requestedDependencyRoot(requested);
        const canonicalRequestedRoot = dependencyRoot(requested);
        const canonicalRoot = dependencyRoot(canonical);
        if (requestedRoot !== undefined) {
          aliases.add(requestedRoot);
          if (canonicalRequestedRoot !== undefined) roots.add(canonicalRequestedRoot);
        }
        if (canonicalRoot !== undefined) roots.add(canonicalRoot);
      }
      pending.push(canonical);
    }
  }

  return {
    readableRoots: uniqueExisting([...roots, ...dependencies]),
    readablePathAliases: [...aliases],
    dependencies: [...dependencies],
  };
}

function gitExecPath(git: string, pathValue: string): string | undefined {
  const result = spawnSync(git, ["--exec-path"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: DISCOVERY_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      PATH: pathValue,
      HOME: "/",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const firstLine = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return firstLine === undefined ? undefined : existingDirectory(firstLine);
}

function npmInstallRoot(npm: string): string | undefined {
  const npmDirectory = path.dirname(npm);
  return existingDirectory(path.dirname(npmDirectory));
}

function toolRecord(
  name: string,
  source: ToolSource,
  executable: string | undefined,
  readableRoots: readonly string[],
  readablePathAliases: readonly string[],
  executableRoots: readonly string[],
  reason?: string,
): ToolchainTool {
  return {
    name,
    source,
    ...(executable === undefined ? {} : { executable }),
    readableRoots: [...readableRoots],
    readablePathAliases: [...readablePathAliases],
    executableRoots: [...executableRoots],
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Discover the macOS shell runtime once. The host PATH is input to discovery,
 * never passed through wholesale to the confined process. Missing optional
 * tools become manifest entries instead of startup failures.
 */
export function discoverMacOSToolchain(options: ToolchainDiscoveryOptions = {}): ToolchainManifest {
  const platform = options.platform ?? process.platform;
  const hostPath = options.pathValue ?? process.env.PATH ?? "";
  const commands = options.commands ?? DEFAULT_TOOLCHAIN_COMMANDS;
  const nodeExecutable = existingPath(options.nodeExecutable ?? process.execPath);
  const nodeDirectory = nodeExecutable === undefined ? undefined : path.dirname(nodeExecutable);
  const nodePath = nodeDirectory === undefined
    ? hostPath
    : [nodeDirectory, hostPath].filter(Boolean).join(path.delimiter);

  const tools: Record<string, ToolchainTool> = {};
  const readableRoots = new Set<string>(uniqueExisting(SYSTEM_READ_ROOTS));
  const executableRoots = new Set<string>(uniqueExisting(SYSTEM_EXECUTABLE_ROOTS));
  const readablePathAliases = new Set<string>();
  const safePathEntries: string[] = [];

  const addPathEntry = (candidate: string | undefined): void => {
    if (candidate === undefined || safePathEntries.includes(candidate)) return;
    safePathEntries.push(candidate);
  };

  if (nodeExecutable !== undefined) {
    const nodeRoot = existingDirectory(nodeDirectory!);
    if (nodeRoot !== undefined) {
      addPathEntry(nodeRoot);
      readableRoots.add(nodeRoot);
      executableRoots.add(nodeRoot);
      const installRoot = existingDirectory(path.dirname(nodeRoot));
      if (installRoot !== undefined) readableRoots.add(installRoot);
    }
  }

  for (const configPath of RUNTIME_CONFIG_PATHS) {
    const canonical = existingPath(configPath);
    if (canonical !== undefined) readableRoots.add(canonical);
  }

  for (const command of commands) {
    const executable = command === "node" && nodeExecutable !== undefined
      ? nodeExecutable
      : resolveExecutableFromPath(command, command === "npm" ? nodePath : hostPath);
    if (executable === undefined) {
      tools[command] = toolRecord(command, "missing", undefined, [], [], [], "not found on the host PATH");
      continue;
    }

    const source: ToolSource = command === "node" && executable === nodeExecutable ? "managed" : "host";
    const toolRoots = new Set<string>();
    const toolExecutableRoots = new Set<string>();
    const toolDirectory = existingDirectory(path.dirname(executable));
    if (toolDirectory !== undefined) {
      toolRoots.add(toolDirectory);
      toolExecutableRoots.add(toolDirectory);
      addPathEntry(toolDirectory);
    }

    const seeds = [executable];
    if (command === "git") {
      const helperRoot = gitExecPath(executable, hostPath);
      if (helperRoot !== undefined) {
        toolRoots.add(helperRoot);
        toolExecutableRoots.add(helperRoot);
        addPathEntry(toolDirectory);
        // Git invokes helper programs that are not necessarily on PATH. Scan
        // every executable in its private helper directory so their dylibs are
        // covered before the shell starts.
        try {
          for (const entry of fs.readdirSync(helperRoot, { withFileTypes: true })) {
            const helper = path.join(helperRoot, entry.name);
            if (entry.isFile() && isExecutable(helper)) seeds.push(helper);
          }
        } catch {
          // The main Git executable remains usable; missing helpers fail as a
          // normal command failure inside the confined shell.
        }
      }
    }

    const closure = machODependencyClosure(seeds);
    for (const root of [...toolRoots, ...closure.readableRoots]) readableRoots.add(root);
    for (const alias of closure.readablePathAliases) {
      if (existingPath(alias) !== undefined) readablePathAliases.add(alias);
    }
    for (const root of toolExecutableRoots) executableRoots.add(root);
    if (command === "npm") {
      const installRoot = npmInstallRoot(executable);
      if (installRoot !== undefined) readableRoots.add(installRoot);
    }

    tools[command] = toolRecord(
      command,
      source,
      executable,
      [...toolRoots, ...closure.readableRoots],
      [...closure.readablePathAliases],
      [...toolExecutableRoots],
    );
  }

  for (const directory of SYSTEM_EXECUTABLE_ROOTS) addPathEntry(existingDirectory(directory));
  return {
    platform,
    safePath: safePathEntries.join(path.delimiter),
    readableRoots: uniqueExisting(readableRoots),
    executableRoots: uniqueExisting(executableRoots),
    readablePathAliases: [...readablePathAliases],
    tools,
  };
}

let cachedMacOSToolchain: ToolchainManifest | undefined;
let cachedRuntimeToolchainCapabilities: RuntimeToolchainCapabilities | undefined;

/** Return the process-start toolchain snapshot used by the macOS shell. */
export function getMacOSToolchain(): ToolchainManifest {
  cachedMacOSToolchain ??= discoverMacOSToolchain();
  return cachedMacOSToolchain;
}

/**
 * Explicitly rescan the host toolchain after the user has prepared a
 * dependency outside Payaso. This is never called from shell execution.
 */
export function refreshMacOSToolchain(): ToolchainManifest {
  cachedMacOSToolchain = discoverMacOSToolchain();
  cachedRuntimeToolchainCapabilities = undefined;
  return cachedMacOSToolchain;
}

/**
 * Strip the private manifest down to a stable, path-free capability snapshot.
 * This is the only projection that Runtime/Host should expose to the model or
 * the frontend. A missing tool is a capability result, not a startup failure.
 */
export function summarizeToolchain(manifest: ToolchainManifest): RuntimeToolchainCapabilities {
  const tools: Record<string, RuntimeToolCapability> = {};
  for (const [name, tool] of Object.entries(manifest.tools)) {
    if (tool.source === "missing") {
      tools[name] = { status: "missing", reason: "not_found" };
    } else {
      tools[name] = { status: "available", source: tool.source };
    }
  }
  return {
    platform: manifest.platform === "darwin" ? "macos" : "unsupported",
    discovery: "startup",
    tools,
  };
}

/** Return the path-free startup snapshot for the platform-specific runtime. */
export function getRuntimeToolchainCapabilities(): RuntimeToolchainCapabilities {
  if (cachedRuntimeToolchainCapabilities !== undefined) {
    return structuredClone(cachedRuntimeToolchainCapabilities);
  }
  if (process.platform !== "darwin") {
    cachedRuntimeToolchainCapabilities = {
      platform: "unsupported",
      discovery: "startup",
      tools: {},
    };
    return structuredClone(cachedRuntimeToolchainCapabilities);
  }
  cachedRuntimeToolchainCapabilities = summarizeToolchain(getMacOSToolchain());
  return structuredClone(cachedRuntimeToolchainCapabilities);
}

/** Explicit user-triggered refresh; normal Runs always use the cached snapshot. */
export function refreshRuntimeToolchainCapabilities(): RuntimeToolchainCapabilities {
  if (process.platform !== "darwin") {
    cachedRuntimeToolchainCapabilities = {
      platform: "unsupported",
      discovery: "startup",
      tools: {},
    };
  } else {
    cachedRuntimeToolchainCapabilities = summarizeToolchain(refreshMacOSToolchain());
  }
  return structuredClone(cachedRuntimeToolchainCapabilities);
}
