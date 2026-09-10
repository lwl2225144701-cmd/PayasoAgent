// 工具链准备 → 显式重试的纯函数（可在 node 测试环境直接运行）。
//
// 设计边界（v1.6 工具链闭环②）：安装成功后由用户显式点击"重新执行刚才的
// 命令"，以新会话轮次发起 —— 新轮次拥有全新的 side-effect 身份空间（无
// uncertain 阻塞），Runtime 绝不自动重放原命令。

import { translate } from '../../i18n/translate';
import type { LanguageMode } from '../../preferences';
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

/** 组装显式重试的用户消息（作为新会话轮次发送）；语言为末位可选入参，默认中文。 */
export function composeToolchainRetryMessage(
  command: string,
  language: LanguageMode = 'zh-CN',
): string {
  return [
    translate(language, 'timeline.retry.intro'),
    `\`${command}\``,
    '',
    translate(language, 'timeline.retry.note'),
  ].join('\n');
}
