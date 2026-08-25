// macOS OS-level shell sandbox tests.
// These tests intentionally use absolute paths and shell indirection. They do
// not rely on the removed command-string blacklist; the filesystem outcome is
// the assertion.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute, type ToolContext, type ToolSandboxEvent } from "../src/tools/tools.js";
import "../src/tools/runtime-tools.js";
import { createWorkspace, cleanupWorkspace } from "../src/sandbox/sandbox-manager.js";

if (process.platform !== "darwin") {
  console.log("OS sandbox tests skipped: macOS only");
  process.exit(0);
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-os-sandbox-"));
process.env.SANDBOX_ROOT = TEST_ROOT;
const RUN = "os-sandbox-test";
const root = createWorkspace(RUN);
const work = path.join(root, "work");
const outside = path.join(TEST_ROOT, "outside.txt");
const tmpOutside = path.join(os.tmpdir(), "payaso-os-sandbox-" + process.pid + ".txt");

function shQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function shell(command: string, events?: ToolSandboxEvent[]): Promise<string> {
  return execute("shell", { command }, {
    runId: RUN,
    onSandboxEvent: events ? (event) => events.push(event) : undefined,
  });
}

async function expectDenied(command: string, events?: ToolSandboxEvent[]): Promise<void> {
  await assert.rejects(
    () => shell(command, events),
    (err: unknown) =>
      err instanceof Error &&
      err.message === "Shell operation denied by workspace sandbox." &&
      !err.message.includes(TEST_ROOT) &&
      !err.message.includes(os.homedir())
  );
}

try {
  // Workspace operations: cwd, read, create, write, modify, and delete.
  const startEvents: ToolSandboxEvent[] = [];
  const pwd = await shell("pwd", startEvents);
  assert.match(pwd, /shell-exit-0/);
  assert.ok(pwd.includes(path.sep + "work"), "unexpected cwd output: " + pwd);
  assert.deepEqual(startEvents, [{ type: "shell_sandbox_started", platform: "macos" }]);

  await shell("printf initial > inside.txt && mkdir nested && printf child > nested/file.txt");
  assert.equal(fs.readFileSync(path.join(work, "inside.txt"), "utf8"), "initial");
  assert.equal(fs.readFileSync(path.join(work, "nested", "file.txt"), "utf8"), "child");

  await shell("printf modified > inside.txt && cat inside.txt");
  assert.equal(fs.readFileSync(path.join(work, "inside.txt"), "utf8"), "modified");

  // A program created inside the workspace is executable; its child shell is
  // still confined to the same workspace policy.
  await shell("printf '#!/bin/sh\\nprintf script > script-result.txt\\n' > script.sh && chmod +x script.sh && ./script.sh");
  assert.equal(fs.readFileSync(path.join(work, "script-result.txt"), "utf8"), "script");

  await shell("rm nested/file.txt inside.txt && rmdir nested");
  await shell("rm script.sh script-result.txt");
  assert.ok(!fs.existsSync(path.join(work, "inside.txt")));
  assert.ok(!fs.existsSync(path.join(work, "nested")));

  // Workspace sibling: absolute path write/delete must be denied by the OS.
  fs.writeFileSync(outside, "keep", "utf8");
  const deniedEvents: ToolSandboxEvent[] = [];
  await expectDenied("printf hacked > " + shQuote(outside), deniedEvents);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  await expectDenied("cat " + shQuote(outside));
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  await expectDenied("rm -f " + shQuote(outside));
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.ok(deniedEvents.some((event) => event.type === "shell_sandbox_denied"));

  // /tmp is intentionally not a writable root in this policy.
  fs.rmSync(tmpOutside, { force: true });
  await expectDenied("printf tmp > " + shQuote(tmpOutside));
  assert.ok(!fs.existsSync(tmpOutside));

  // A child shell inherits the same OS sandbox; string indirection cannot escape.
  await expectDenied("sh -c " + shQuote("printf child > " + shQuote(outside)));
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");

  console.log("macOS OS sandbox tests: PASS");
  console.log("  workspace read/write/create/delete: PASS");
  console.log("  workspace-external absolute read/write/delete: DENIED");
  console.log("  /tmp write: DENIED");
  console.log("  child shell inheritance: DENIED");
} finally {
  fs.rmSync(tmpOutside, { force: true });
  cleanupWorkspace(RUN);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
}
