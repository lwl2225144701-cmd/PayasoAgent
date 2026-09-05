export interface ContextHarnessState {
  conversationSummary: string;
  summarizedMessageCount: number;
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
  };
}
