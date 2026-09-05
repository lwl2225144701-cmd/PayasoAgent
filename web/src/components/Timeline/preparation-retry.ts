// 工具链准备 → 显式重试的纯函数（可在 node 测试环境直接运行）。
//
// 设计边界（v1.6 工具链闭环②）：安装成功后由用户显式点击"重新执行刚才的
// 命令"，以新会话轮次发起 —— 新轮次拥有全新的 side-effect 身份空间（无
// uncertain 阻塞），Runtime 绝不自动重放原命令。

import type { HostEvent } from '../../types';

/**
 * 从事件流中提取最后一条"失败的 shell 命令"：
 * 以最近的 shell tool_error 为锚，回溯其前方最近的 shell tool_call 的 command。
 * 无失败记录时返回 null。
 */
export function findLastFailedShellCommand(events: HostEvent[]): string | null {
  let lastShellCommand: string | null = null;
  let lastFailed: string | null = null;
  for (const event of events) {
    if (event.type === 'tool_call' && event.tool === 'shell') {
      const command = (event.args as { command?: unknown } | null)?.command;
      if (typeof command === 'string') lastShellCommand = command;
    } else if (event.type === 'tool_error' && event.tool === 'shell') {
      lastFailed = lastShellCommand;
    }
  }
  return lastFailed;
}

/** 组装显式重试的用户消息（作为新会话轮次发送）。 */
export function composeToolchainRetryMessage(command: string): string {
  return [
    '依赖已安装完成，请重新执行之前失败的命令：',
    `\`${command}\``,
    '',
    '（这是我在依赖准备完成后明确发起的重试；如果该命令仍不可用，请告诉我原因。）',
  ].join('\n');
}
