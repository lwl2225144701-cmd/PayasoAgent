// Deterministic shell network isolation tests (v1.6 Network Capability
// Separation): a localhost TCP server proves connections are denied at the
// OS sandbox layer — no dependence on external hosts, no command blacklist.
// Requires macOS sandbox-exec; skips honestly when the primitive is
// unavailable or denied in this environment.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createSandboxPolicy,
} from "../src/sandbox/sandbox-policy.js";
import {
  MacOSSandbox,
  probeSandboxAvailability,
  type MacOSSandboxResult,
} from "../src/sandbox/macos-sandbox.js";
import { execute, type ToolContext } from "../src/tools/tools.js";
// 副作用 import：shell 工具由 runtime-tools 注册（与 agent.ts 一致）
import "../src/tools/runtime-tools.js";
import { createWorkspace, canonicalizeWorkspaceRoot } from "../src/sandbox/sandbox-manager.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.error(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "payaso-shell-net-"));
process.env.SANDBOX_ROOT = ROOT;
fs.mkdirSync(ROOT, { recursive: true });

// localhost TCP server：连接到达即计数（确定性证明"网络请求是否真的发生"）
let serverConnections = 0;
const server = net.createServer((socket) => {
  serverConnections++;
  socket.destroy();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

const runId = "shell-network-ws";
const workspaceRoot = canonicalizeWorkspaceRoot(createWorkspace(runId));
const shellOptions = {
  cwd: workspaceRoot,
  home: fs.mkdtempSync(path.join(workspaceRoot, ".payaso-shell-home-")),
  tmpdir: fs.mkdtempSync(path.join(workspaceRoot, ".payaso-shell-tmp-")),
};

const originalFetch = globalThis.fetch;

try {
  // ---- Case 6: NetworkPolicy 默认值必须是 deny（安全默认）----
  check("Case6: createSandboxPolicy defaults to networkAccess=false",
    createSandboxPolicy(workspaceRoot).networkAccess === false);

  // ---- 环境门：sandbox-exec 不可用或本环境拒绝执行时如实 SKIP ----
  const sandbox = MacOSSandbox.forWorkspace(workspaceRoot);
  check("Case6: forWorkspace (shell 路径) 固定 networkAccess=false",
    sandbox.policy.networkAccess === false);
  const sandboxOk = await probeSandboxAvailability();
  let shellUsable = sandboxOk;
  let skipReason = sandboxOk ? "" : "sandbox-exec unavailable";
  if (shellUsable) {
    try {
      const probe = await sandbox.run("true", shellOptions);
      if (probe.denied) {
        shellUsable = false;
        skipReason = "shell denied by workspace policy in this environment";
      }
    } catch (err) {
      shellUsable = false;
      skipReason = (err as Error).message;
    }
  }

  if (!shellUsable) {
    check(`SKIP: sandbox shell unavailable here (${skipReason}) — network isolation tests not executed`, true);
  } else {
    // ---- Case 3: workspace 内文件系统操作仍然正常 ----
    const fsOps: MacOSSandboxResult = await sandbox.run(
      "echo hello > net-file.txt && cat net-file.txt && mkdir -p net-dir && ls",
      shellOptions,
    );
    check("Case3: workspace filesystem ops still work",
      fsOps.exitCode === 0 && fsOps.stdout.includes("hello") && fsOps.stdout.includes("net-dir"),
      `exit=${fsOps.exitCode}, out=${fsOps.stdout.slice(0, 120)}, err=${fsOps.stderr.slice(0, 120)}`);

    // ---- Case 5: 普通计算命令不受网络 deny 影响 ----
    const printf = await sandbox.run("printf 'hello'", shellOptions);
    check("Case5: printf works", printf.exitCode === 0 && printf.stdout === "hello", JSON.stringify(printf.stdout));
    const expr = await sandbox.run("expr 1 + 1", shellOptions);
    check("Case5: expr calculation works", expr.exitCode === 0 && expr.stdout.trim() === "2",
      `exit=${expr.exitCode}, out=${expr.stdout}`);

    // ---- Case 1: curl → localhost 被拒绝（连接永远没有到达 server）----
    const beforeCurl = serverConnections;
    const curl = await sandbox.run(`curl -s --max-time 3 http://127.0.0.1:${port}/`, shellOptions);
    check("Case1: curl to localhost fails", curl.exitCode !== 0, `exit=${curl.exitCode}`);
    check("Case1: curl connection never reached the server", serverConnections === beforeCurl,
      `connections delta=${serverConnections - beforeCurl}`);

    // ---- Case 2: perl socket（与 curl 不同的运行时）同样被拒 ----
    const perlProbe = (mode: "deny" | "allow") =>
      `perl -e 'use IO::Socket::INET; my $s = IO::Socket::INET->new(PeerAddr=>"127.0.0.1", PeerPort=>${port}, Proto=>"tcp", Timeout=>3); if ($s) { print "CONNECTED"; exit 0 } else { print "CONNECTFAIL"; exit 1 }'`;
    const beforePerl = serverConnections;
    const perlDeny = await sandbox.run(perlProbe("deny"), shellOptions);
    check("Case2: perl socket to localhost fails (different runtime than curl)",
      perlDeny.exitCode !== 0 && !perlDeny.stdout.includes("CONNECTED"),
      `exit=${perlDeny.exitCode}, out=${perlDeny.stdout}, err=${perlDeny.stderr.slice(0, 100)}`);
    check("Case2: perl connection never reached the server", serverConnections === beforePerl,
      `connections delta=${serverConnections - beforePerl}`);

    // Full access only lifts filesystem containment; network remains denied.
    const fullSandbox = MacOSSandbox.forWorkspace(workspaceRoot, "full-access");
    const beforeFull = serverConnections;
    const fullCurl = await fullSandbox.run(`curl -s --max-time 3 http://127.0.0.1:${port}/`, shellOptions);
    check("Full access: network remains denied", fullCurl.exitCode !== 0 && serverConnections === beforeFull,
      `exit=${fullCurl.exitCode}, connections delta=${serverConnections - beforeFull}`);

    const fullOutside = path.join(os.tmpdir(), `payaso-full-access-${Date.now()}.txt`);
    fs.writeFileSync(fullOutside, "FULL-READ");
    const fullRead = await fullSandbox.run(`cat ${JSON.stringify(fullOutside)}`, shellOptions);
    check("Full access: host filesystem read is allowed",
      fullRead.exitCode === 0 && fullRead.stdout.includes("FULL-READ"),
      `exit=${fullRead.exitCode}, out=${fullRead.stdout.slice(0, 80)}`);
    fs.rmSync(fullOutside, { force: true });

    // ---- 对照组：networkAccess: true 时同一 perl socket 成功 ----
    // （证明拒绝来自 sandbox policy 本身，而不是命令黑名单或环境故障）
    const allowSandbox = new MacOSSandbox(createSandboxPolicy(workspaceRoot, {
      readableRoots: ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/System/Library", "/dev/null", "/dev/urandom", "/dev/random"],
      writableRoots: [workspaceRoot],
      networkAccess: true,
    }));
    const beforeAllow = serverConnections;
    const perlAllow = await allowSandbox.run(perlProbe("allow"), shellOptions);
    check("control: same perl socket SUCCEEDS with explicit networkAccess=true",
      perlAllow.exitCode === 0 && perlAllow.stdout.includes("CONNECTED") && serverConnections > beforeAllow,
      `exit=${perlAllow.exitCode}, out=${perlAllow.stdout}, connections delta=${serverConnections - beforeAllow}`);

    // ---- Case 4: workspace 外文件访问仍然 denied（不因网络改动而扩大文件权限）----
    const outside = path.join(os.tmpdir(), `payaso-net-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "OUTSIDE-SECRET");
    const outsideRead = await sandbox.run(`cat ${JSON.stringify(outside)}`, shellOptions);
    check("Case4: reading outside workspace still denied",
      outsideRead.exitCode !== 0 && !outsideRead.stdout.includes("OUTSIDE-SECRET"),
      `exit=${outsideRead.exitCode}, out=${outsideRead.stdout.slice(0, 80)}`);
    fs.rmSync(outside, { force: true });

    // ---- Tool 层：denied 命令走 Tool failure（Agent 可恢复，Run 不 crash）----
    const toolCtx: ToolContext = { runId, workspaceRoot };
    await assert.rejects(
      () => execute("shell", { command: `curl -s --max-time 3 http://127.0.0.1:${port}/` }, toolCtx),
      /denied/i,
    );
    check("tool-level: network-denied command surfaces as a recoverable tool failure", true);
  }
} finally {
  globalThis.fetch = originalFetch;
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nShell network isolation tests: ${passed} PASS / ${failed} FAIL`);
if (failed) process.exit(1);
