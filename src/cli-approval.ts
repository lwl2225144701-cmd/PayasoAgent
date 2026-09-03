// CLI 的 JIT Approval 实现：TTY 交互询问（y/n）。
// 非 TTY 环境（管道/CI）下自动拒绝 —— fail-closed，绝不静默放行网络访问。

import readline from "node:readline/promises";
import type { ApprovalPort, NetworkApprovalRequest } from "./runtime/approval-port.js";

// stdin 是否为 TTY（readline 交互可用）；NodeJS.ReadableStream 无 isTTY 类型，
// 运行时真实对象（process.stdin）才有，用最少侵入的鸭子类型判断。
type StdinWithTTY = NodeJS.ReadableStream & { isTTY?: boolean };

export function createCliApprovalPort(stdin: NodeJS.ReadableStream = process.stdin): ApprovalPort {
  const interactive = (stdin as StdinWithTTY).isTTY === true;
  const rl = readline.createInterface({ input: stdin, output: process.stdout });

  return {
    async request(req: NetworkApprovalRequest): Promise<boolean> {
      if (!interactive) {
        console.log(
          `[Approval] ${req.toolName} 需要网络访问，但当前为非交互环境（TTY 不可用），已拒绝。` +
          `请使用 --network-mode on 允许联网。`
        );
        return false;
      }
      const summary = JSON.stringify(req.args ?? {}).slice(0, 120);
      const answer = await rl.question(
        `[Approval] 工具 ${req.toolName} 请求网络访问（${summary}）。允许？(y/N) `
      );
      const ok = answer.trim().toLowerCase() === "y";
      if (!ok) console.log("[Approval] 已拒绝。");
      return ok;
    },
  };
}