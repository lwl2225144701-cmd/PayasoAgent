// Toolchain discovery tests: startup-time resolution must be deterministic and
// must never widen the shell PATH with relative or unresolved entries.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverMacOSToolchain,
  summarizeToolchain,
  resolveExecutableFromPath,
} from "../src/sandbox/toolchain-manager.js";
import { createSandboxPolicy } from "../src/sandbox/sandbox-policy.js";
import { toolchainSystemPrompt } from "../src/harness/instructions.js";
import { DefaultContextHarness } from "../src/harness/context-harness.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-toolchain-test-"));
const BIN = path.join(ROOT, "bin");
const GIT_CORE = path.join(ROOT, "libexec", "git-core");
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(GIT_CORE, { recursive: true });

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

try {
  const git = path.join(BIN, "git");
  const npm = path.join(BIN, "npm");
  writeExecutable(git, `#!/bin/sh
if [ "$1" = "--exec-path" ]; then
  printf '%s\\n' ${JSON.stringify(GIT_CORE)}
fi
`);
  writeExecutable(npm, "#!/bin/sh\nexit 0\n");
  const canonicalGit = fs.realpathSync.native(git);
  const canonicalGitCore = fs.realpathSync.native(GIT_CORE);

  assert.equal(resolveExecutableFromPath("git", `${BIN}:/relative/bin`), canonicalGit);
  assert.equal(resolveExecutableFromPath("git", "."), undefined);
  assert.equal(resolveExecutableFromPath("../git", BIN), undefined);

  const manifest = discoverMacOSToolchain({
    platform: "darwin",
    pathValue: `${BIN}:/relative/bin`,
    // Keep the real Node executable as the app-managed runtime in this test.
    nodeExecutable: process.execPath,
    commands: ["git", "node", "npm"],
  });

  assert.equal(manifest.tools.git.source, "host");
  assert.equal(manifest.tools.git.executable, canonicalGit);
  assert.ok(manifest.tools.git.readableRoots.includes(canonicalGitCore));
  assert.ok(manifest.tools.git.executableRoots.includes(canonicalGitCore));
  assert.equal(manifest.tools.node.source, "managed");
  assert.equal(manifest.tools.npm.source, "host");
  assert.ok(manifest.safePath.split(path.delimiter).every((entry) => path.isAbsolute(entry)));
  assert.ok(!manifest.safePath.split(path.delimiter).includes("/relative/bin"));
  assert.ok(manifest.readableRoots.every((entry) => path.isAbsolute(entry)));
  assert.ok(manifest.executableRoots.every((entry) => path.isAbsolute(entry)));

  const capabilities = summarizeToolchain(manifest);
  assert.equal(capabilities.platform, "macos");
  assert.equal(capabilities.discovery, "startup");
  assert.deepEqual(capabilities.tools.git, { status: "available", source: "host" });
  assert.deepEqual(capabilities.tools.node, { status: "available", source: "managed" });
  assert.deepEqual(capabilities.tools.npm, { status: "available", source: "host" });
  assert.ok(!JSON.stringify(capabilities).includes(ROOT));
  const prompt = toolchainSystemPrompt(capabilities);
  assert.match(prompt, /git/);
  assert.match(prompt, /一次性发现/);
  assert.ok(!prompt.includes(ROOT));
  const transcript = new DefaultContextHarness({
    permissionMode: "workspace-write",
    model: "gpt-4o-mini",
    toolchain: capabilities,
  }).createTranscript("toolchain probe");
  assert.match(String(transcript[0]?.content), /当前可用工具：git, node, npm/);
  assert.ok(!String(transcript[0]?.content).includes(ROOT));

  const missing = discoverMacOSToolchain({
    platform: "darwin",
    pathValue: BIN,
    nodeExecutable: process.execPath,
    commands: ["definitely-not-installed"],
  });
  assert.equal(missing.tools["definitely-not-installed"]?.source, "missing");
  assert.match(missing.tools["definitely-not-installed"]?.reason ?? "", /not found/);
  assert.deepEqual(summarizeToolchain(missing).tools["definitely-not-installed"], {
    status: "missing",
    reason: "not_found",
  });

  const target = path.join(ROOT, "canonical-target");
  const alias = path.join(ROOT, "verified-alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, "dir");
  const canonicalTarget = fs.realpathSync.native(target);
  const policy = createSandboxPolicy(ROOT, {
    readablePathAliases: [alias],
    executableRoots: [BIN],
  });
  assert.deepEqual(policy.readablePathAliases, [{
    path: alias,
    canonicalPath: canonicalTarget,
  }]);
  assert.ok(policy.readableRoots.includes(fs.realpathSync.native(BIN)));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log("Toolchain discovery tests: PASS");
