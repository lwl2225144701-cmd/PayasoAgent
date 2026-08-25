// 统一 Sandbox Policy：把“允许访问哪些真实路径”从具体执行器中抽出来。
// Policy 只接受 Runtime 生成的路径；LLM 提供的路径必须先经过 SandboxManager。

import fs from "node:fs";
import path from "node:path";

export type SandboxPolicy = {
  workspaceRoot: string;
  readableRoots: string[];
  writableRoots: string[];
};

function canonicalizeExisting(input: string): string {
  const abs = path.resolve(input);
  try {
    return fs.realpathSync.native(abs);
  } catch (err) {
    throw new Error(`sandbox policy path does not exist: ${abs}`, { cause: err });
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Create a fail-closed policy. Writable roots must be inside workspaceRoot;
 * readable roots may include explicitly approved system paths.
 */
export function createSandboxPolicy(
  workspaceRoot: string,
  options: { readableRoots?: string[]; writableRoots?: string[] } = {}
): SandboxPolicy {
  const root = canonicalizeExisting(workspaceRoot);
  const readableRoots = unique([
    root,
    ...(options.readableRoots ?? []).map(canonicalizeExisting),
  ]);
  const writableRoots = unique([
    ...(options.writableRoots ?? [root]).map(canonicalizeExisting),
  ]);

  for (const writable of writableRoots) {
    if (!isInside(root, writable)) {
      throw new Error("sandbox policy writable roots must be inside workspace root");
    }
  }

  return { workspaceRoot: root, readableRoots, writableRoots };
}

export function canonicalizeSandboxPath(input: string): string {
  return canonicalizeExisting(input);
}

export function isSandboxPathInside(root: string, target: string): boolean {
  return isInside(canonicalizeSandboxPath(root), canonicalizeSandboxPath(target));
}
