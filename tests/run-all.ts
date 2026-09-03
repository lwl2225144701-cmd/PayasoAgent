// 模块: 统一测试集合入口 — 聚合所有确定性套件（无 LLM、秒级），统一统计 PASS/FAIL
// 用法: npx tsx tests/run-all.ts   （或 npm run test:all）
// 覆盖: 31 个无 LLM 套件，含 Runtime/bootstrap 边界、三档文件系统权限、macOS seatbelt 沙箱、Workspace 生命周期与软删除回收站、
//   Host 启停/路由、SQLite 持久化、前端输出清理、默认浏览器打开边界、LLM transport mock、
//   Run 模型绑定与 Context Budget、True Cancellation、Shell 网络隔离、Malformed Tool Call 恢复、
//   原子终态落盘、Side-Effect 生命周期/回放、Provider 设置与凭证迁移、docs contract、
//   Host Auth、Provider URL 校验、Keychain 契约、幂等关闭（v1.6 Release Closure 基线）
// 说明:
//   1. 每个套件在独立子进程运行（各自设置 SANDBOX_ROOT / mkdtemp，避免环境变量互相污染）
//   2. 以子进程退出码判定套件通过与否（各套件内部已实现 失败 → 非 0 退出）
//   3. 压测 stress.test.ts 与 Agent E2E（agent.test.ts）需 LLM、耗时，不纳入本集合，
//      保持独立 script：npm run test:stress / npm test
// 注: 本文件用顶层执行 + 手动 process.exit，与各套件自定义 runner 风格保持一致（不走 node:test）

import { execFileSync } from "node:child_process";

const PROJECT_ROOT = process.cwd();

const SUITES: { name: string; file: string }[] = [
  { name: "runtime-boundary", file: "tests/runtime-boundary.test.ts" },
  { name: "tool-contract", file: "tests/tool-contract.test.ts" },
  { name: "filesystem-tools", file: "tests/filesystem-tools.test.ts" },
  { name: "sandbox-manager", file: "tests/sandbox-manager.test.ts" },
  { name: "operation-identity", file: "tests/operation-identity.test.ts" },
  { name: "operation-replay", file: "tests/operation-replay.test.ts" },
  { name: "output-guard", file: "tests/output-guard.test.ts" },
  { name: "runtime-tools", file: "tests/runtime-tools.test.ts" },
  { name: "frontend-format", file: "tests/frontend-format.test.ts" },
  { name: "default-browser", file: "tests/default-browser.test.ts" },
  { name: "permissions", file: "tests/permissions.test.ts" },
  { name: "os-sandbox", file: "tests/os-sandbox.test.ts" },
  { name: "workspace", file: "tests/workspace.test.ts" },
  { name: "context", file: "tests/context.test.ts" },
  { name: "context-budget", file: "tests/context-budget.test.ts" },
  { name: "context-compaction", file: "tests/context-compaction.test.ts" },
  { name: "persistence", file: "tests/persistence.test.ts" },
  { name: "llm", file: "tests/llm.test.ts" },
  { name: "model-binding", file: "tests/model-binding.test.ts" },
  { name: "cancellation", file: "tests/cancellation.test.ts" },
  { name: "shell-network", file: "tests/shell-network.test.ts" },
  { name: "network-control", file: "tests/network-control.test.ts" },
  { name: "approval", file: "tests/approval.test.ts" },
  { name: "tool-args", file: "tests/tool-args.test.ts" },
  { name: "finalize", file: "tests/finalize.test.ts" },
  { name: "docs-contract", file: "tests/docs-contract.test.ts" },
  { name: "side-effect", file: "tests/side-effect.test.ts" },
  { name: "workspace-trash", file: "tests/workspace-trash.test.ts" },
  { name: "settings", file: "tests/settings.test.ts" },
  { name: "host-auth", file: "tests/host-auth.test.ts" },
  { name: "provider-url", file: "tests/provider-url.test.ts" },
  { name: "encrypted-file-secret", file: "tests/encrypted-file-secret.test.ts" },
  { name: "keychain-command", file: "tests/keychain-command.test.ts" },
  { name: "shutdown", file: "tests/shutdown.test.ts" },
];

console.log("=".repeat(70));
console.log("PayasoAgent 确定性测试集合（无 LLM）");
console.log("=".repeat(70));

const results: { name: string; pass: boolean }[] = [];
for (const s of SUITES) {
  console.log(`\n▶ ${s.name}`);
  try {
    execFileSync("npx", ["tsx", s.file], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "inherit", "pipe"], // stdout 透传显示套件细节
      encoding: "utf-8",
    });
    results.push({ name: s.name, pass: true });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    if (err.stderr) process.stderr.write(err.stderr);
    results.push({ name: s.name, pass: false });
  }
}

console.log("\n" + "=".repeat(70));
console.log("测试集合汇总");
console.log("=".repeat(70));
const passed = results.filter((r) => r.pass).length;
console.log(`套件: ${results.length} | PASS: ${passed} | FAIL: ${results.length - passed}`);
results.forEach((r) => console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`));
console.log(
  `提示: 需 LLM 的压测与 E2E 未纳入本集合 — stress 用 npm run test:stress；Agent E2E 用 npm test`
);
process.exit(passed === results.length ? 0 : 1);
