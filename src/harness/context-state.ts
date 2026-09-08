export interface ContextHarnessState {
  conversationSummary: string;
  summarizedMessageCount: number;
  // /compact 命令的一次性标记：下一轮 prepareTurn 无视阈值直接执行轮边界压缩，
  // 消费后由 Harness 清除（不随 checkpoint 长期存留）。
  forceCompact?: boolean;
}

export function createContextHarnessState(): ContextHarnessState {
  return { conversationSummary: '', summarizedMessageCount: 0 };
}

export function normalizeContextHarnessState(
  value: ContextHarnessState | undefined,
): ContextHarnessState {
  if (!value) return createContextHarnessState();
  return {
    conversationSummary:
      typeof value.conversationSummary === 'string' ? value.conversationSummary : '',
    summarizedMessageCount:
      Number.isSafeInteger(value.summarizedMessageCount) && value.summarizedMessageCount >= 0
        ? value.summarizedMessageCount
        : 0,
    ...(value.forceCompact === true ? { forceCompact: true } : {}),
  };
}
