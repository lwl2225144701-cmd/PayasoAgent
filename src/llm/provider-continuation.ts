// 保留兼容 Provider 已返回的工具续传字段；不猜测协议、不转成普通提示或用户正文。
import { createHash } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ProviderContinuation } from './llm-types.js';

export function continuationIdentity(baseUrl: string, providerId: string, model: string): string {
  // 不持久化 URL（可能带查询凭证）；密钥和生成参数都不进入身份。
  return createHash('sha256')
    .update(JSON.stringify([baseUrl, providerId, model]))
    .digest('hex');
}

function isReasoningField(field: unknown): field is ProviderContinuation['field'] {
  return field === 'reasoning_content' || field === 'reasoning' || field === 'reasoning_text';
}

export function captureProviderContinuation(
  message: AssistantMessage,
  identity: string,
): ProviderContinuation | undefined {
  if (message.api !== 'openai-completions' || message.stopReason !== 'toolUse') return undefined;
  const blocks = message.content.filter((block) => block.type === 'thinking');
  const field = blocks.find((block) =>
    isReasoningField(block.thinkingSignature),
  )?.thinkingSignature;
  if (!isReasoningField(field)) return undefined;
  const text = blocks
    .filter((block) => block.thinkingSignature === field)
    .map((block) => block.thinking)
    .join('\n');
  return text ? { version: 1, identity, field, text } : undefined;
}

export function matchesProviderContinuation(
  state: ProviderContinuation | undefined,
  identity: string | undefined,
): state is ProviderContinuation {
  return (
    !!state &&
    typeof identity === 'string' &&
    state.version === 1 &&
    state.identity === identity &&
    isReasoningField(state.field) &&
    typeof state.text === 'string' &&
    state.text.length > 0
  );
}
