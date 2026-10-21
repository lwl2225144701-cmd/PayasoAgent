// 模块: LLM 适配编排 — PayasoAgent 的旧 ChatMessage 契约由 pi-ai 驱动。
// Runtime 仍然消费本文件的 OpenAI 风格消息；Provider、认证、SSE/tool-call
// 拼装和请求重试的基础设施已按职责拆出：
//   llm-types.ts     公开契约（类型层，零逻辑）
//   llm-messages.ts  ChatMessage ⇄ pi-ai Context/AssistantMessage 双向转换
//   llm-sse.ts       出站 SSE 行整形（tool_call 分片协议修正）
//   llm-transport.ts fetch 封装 / 连接超时 / Retry-After / 重试与退避 / 超时策略
// 本文件只保留：env 兜底、模型装配（createConfiguredModel）与 chat() 编排
// （attempt 循环 + 派生 AbortController + 空闲看门狗 + 事件流消费）。
// 历史导入面不变：ChatMessage / ToolSchema / ModelConfig 等类型与 chat /
// llmTimeoutPolicy 均从本文件再导出，src/ 各处无需改动。

import {
  type Api,
  createModels,
  createProvider,
  type Model,
  type ModelThinkingLevel,
  type ProviderStreams,
  type ThinkingLevel,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { resolveModelContextConfig } from '../harness/model-context.js';
import { asProviderStreams, resolvePiAiRuntimeModel } from '../host/pi-ai-providers.js';
import { createIdleWatchdog, TimeoutAbortError } from '../util/timeout.js';
import { InlineThinkEmitter, toLegacyMessage, toPiContext } from './llm-messages.js';
import type { FetchDiagnostics } from './llm-sse.js';
import {
  formatTransportError,
  isTransientStreamError,
  llmTimeoutPolicy,
  piFetch,
  requestHeadersFor,
  retryDelay,
  retryDelayMs,
  shouldRetry,
} from './llm-transport.js';
import type {
  ChatMessage,
  ChatResponse,
  ChatStreamDelta,
  LlmTransportEvent,
  ModelConfig,
  ResolvedEndpointConfig,
  ToolSchema,
} from './llm-types.js';
import { captureProviderContinuation, continuationIdentity } from './provider-continuation.js';
import { normalizeTokenUsage } from './token-usage.js';
import {
  mergeRawArguments,
  rawArgumentsByToolCallId,
  ToolArgumentAccumulator,
} from './tool-call-arguments.js';

export { llmTimeoutPolicy } from './llm-transport.js';
export type {
  ChatMessage,
  ChatResponse,
  ChatStreamDelta,
  LlmStopReason,
  LlmTimeoutPolicy,
  LlmTransportEvent,
  MessageImage,
  ModelConfig,
  ToolCall,
  ToolSchema,
} from './llm-types.js';

const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_RETRIES = 2;

// 思考档次归一化：'off' 与未配置等价——两者都不介入请求，保持端点默认行为。
// 返回 undefined 表示"这次请求不配置思考档次"（走与引入该功能前一致的旧路径）。
function activeThinkingLevel(level: ModelThinkingLevel | undefined): ThinkingLevel | undefined {
  if (level === undefined || level === 'off') return undefined;
  return level;
}

function resolveEndpointConfig(modelConfig?: ModelConfig): ResolvedEndpointConfig {
  if (modelConfig) {
    if (!modelConfig.baseUrl || !modelConfig.apiKey || !modelConfig.model) {
      throw new Error(
        'modelConfig is incomplete: baseUrl, apiKey and model are all required ' +
          '(no per-field fallback to environment config)',
      );
    }
    return {
      // Host 已经解析并固定本轮 Provider。baseUrl 是用户配置的权威值，传输层
      // 不得再根据模型名静默切换计费或订阅通道。
      baseUrl: modelConfig.baseUrl,
      apiKey: modelConfig.apiKey,
      model: modelConfig.model,
      providerId: modelConfig.providerId || 'payaso-configured',
      ...(modelConfig.piProviderId ? { piProviderId: modelConfig.piProviderId } : {}),
      ...(modelConfig.sessionId ? { sessionId: modelConfig.sessionId } : {}),
      contextWindow: modelConfig.contextWindow,
      maxOutputTokens: modelConfig.maxOutputTokens,
      vision: modelConfig.vision === true,
      ...(modelConfig.thinkingLevel ? { thinkingLevel: modelConfig.thinkingLevel } : {}),
    };
  }
  return {
    // CLI/env fallback 同样尊重显式地址；路由纠正应由配置入口提示用户，而不是
    // 在发请求时悄悄改成另一个端点。
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
    providerId: 'payaso-env',
    vision: false,
  };
}

function createConfiguredModel(config: ResolvedEndpointConfig): {
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
} {
  const auth = {
    apiKey: {
      name: `${config.providerId} API key`,
      resolve: async () => ({
        // Explicit ModelConfig values are validated before this point. The
        // env fallback path keeps its historical behavior for an empty key.
        auth: { apiKey: config.apiKey || 'unused' },
        source: 'PayasoAgent Run snapshot',
      }),
    },
  };

  if (config.piProviderId) {
    // 目录内模型（pi-ai 静态目录 + 本地补丁）直接命中；远端 /models 发现的模型
    // （供应商上新早于依赖升级）由 parse 侧合成等价 Model，见 pi-ai-providers。
    const resolved = resolvePiAiRuntimeModel(config.piProviderId, config.model);
    if (!resolved) {
      throw new Error(
        `pi-ai provider/model is not available: ${config.piProviderId}/${config.model}`,
      );
    }
    const sourceModel = resolved.model;
    const modelContext = resolveModelContextConfig({
      model: config.model,
      contextWindowTokens: config.contextWindow ?? sourceModel.contextWindow,
      maxOutputTokens: config.maxOutputTokens ?? sourceModel.maxTokens,
    });
    // 内置 Provider 的 input 能力来自注册表；设置位显式开启视觉时补登记 image，
    // 让 openai-completions 适配层把图片块转成 image_url（它按 model.input 判定）。
    const input: Model<Api>['input'] =
      config.vision && !sourceModel.input.includes('image')
        ? ([...sourceModel.input, 'image'] as Model<Api>['input'])
        : sourceModel.input;
    const model: Model<Api> = {
      ...sourceModel,
      id: config.model,
      provider: config.providerId,
      baseUrl: config.baseUrl,
      input,
      contextWindow: modelContext.contextWindowTokens,
      maxTokens: modelContext.maxOutputTokens,
    };
    const provider = createProvider({
      id: config.providerId,
      name: config.providerId,
      baseUrl: config.baseUrl,
      auth,
      models: [model],
      api: asProviderStreams(resolved.provider) as ProviderStreams,
    });
    const models = createModels();
    models.setProvider(provider);
    return { models, model };
  }

  const modelContext = resolveModelContextConfig({
    model: config.model,
    contextWindowTokens: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
  });
  const model: Model<Api> = {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl,
    // 思考能力按"是否配置了档次"打开：配了档次 → true，未配置/off → false。
    // reasoning 是 pi-ai 的两道闸门之一（false 时任何档次都会被 clamp 成 off），
    // 同时它也决定 pi-ai 是否主动发"关闭思考"参数：对 deepseek/zai/together/
    // openrouter 这类按 URL 自动探测的端点，reasoning: true + 未配档次会发出
    // thinking:{type:"disabled"} / reasoning:{enabled:false} 等显式关闭指令，
    // 反而把本来默认开思考的模型关掉。故只在用户显式配置档次时才打开——
    // 未配置的请求与引入该功能前逐字节一致。
    reasoning: activeThinkingLevel(config.thinkingLevel) !== undefined,
    // 自定义 OpenAI 兼容端点：视觉能力由设置页按模型显式声明（无法从协议探测）。
    input: config.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelContext.contextWindowTokens,
    maxTokens: modelContext.maxOutputTokens,
    compat: {
      // PayasoAgent 的现有 Provider 契约是 Chat Completions + max_tokens。
      maxTokensField: 'max_tokens',
      supportsStore: false,
      supportsDeveloperRole: false,
      // 不再硬编码 supportsReasoningEffort: false：pi-ai 的 getCompat 会按
      // baseUrl 自动探测该能力（model.compat 里缺的字段用 detected 兜底）。
      // deepseek.com → thinkingFormat 'deepseek' + reasoning_effort 支持；
      // 通用 OpenAI 兼容 → reasoning_effort；zai/moonshot/grok 等排除名单
      // 自动探测为 false，但各自原生 thinkingFormat 分支只依赖 model.reasoning。
      // Some of the existing compatible endpoints terminate with [DONE]
      // without a final finish_reason; pi-ai can infer stop/toolUse safely.
      supportsFinishReason: false,
    },
  };

  const provider = createProvider({
    id: config.providerId,
    name: config.providerId,
    baseUrl: config.baseUrl,
    auth,
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

export async function chat(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  onDelta?: (delta: ChatStreamDelta) => void,
  modelConfig?: ModelConfig,
  signal?: AbortSignal,
  onRequestSent?: (attempt: number) => void,
  onTransport?: (event: LlmTransportEvent) => void,
): Promise<ChatResponse> {
  const config = resolveEndpointConfig(modelConfig);
  const { models, model } = createConfiguredModel(config);
  const identity = continuationIdentity(config.baseUrl, config.providerId, config.model);
  const context = toPiContext(
    messages,
    tools,
    config.providerId,
    config.model,
    model.api,
    identity,
  );
  const messageId = crypto.randomUUID();
  const policy = llmTimeoutPolicy();
  let totalAttempts = 0;

  // pi-ai 内部不重试。此处统一处理有界恢复：响应头之前的连接超时可重试，
  // 用户取消、流空闲超时或已输出内容后的错误终止，避免重放半截响应。
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // v2.3 分层超时：每次尝试一个派生 AbortController——
    // - 用户取消 → 以标准 AbortError 传播（与引入前语义逐字节一致）
    // - 连接/空闲超时 → 以 TimeoutAbortError 标记来源，绝不当作用户取消
    const timeoutController = new AbortController();
    const onUserAbort = (): void => {
      timeoutController.abort(new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) onUserAbort();
      else signal.addEventListener('abort', onUserAbort, { once: true });
    }
    const attemptStarted = performance.now();
    const reportTransport = (event: Omit<LlmTransportEvent, 'attempt' | 'elapsedMs'>): void => {
      onTransport?.({
        ...event,
        attempt: attempt + 1,
        elapsedMs: Math.round(performance.now() - attemptStarted),
      });
    };
    const diagnostics: FetchDiagnostics = {
      attempts: 0,
      timeoutController,
      connectTimeoutMs: policy.connectMs,
      onTransport: reportTransport,
    };
    let responseStarted = false;
    // v2.7 重试安全边界：是否已产出正文/工具调用（有副作用），而非"是否收到过任何事件"。
    // 思考 token（thinking_delta）不算——provider 在思考阶段掐流/断网时，重放同请求无副作用。
    let emittedContent = false;
    // 流空闲看门狗：每个事件续期；prefill 首 token 漫长等待与中途停滞都会触发。
    const idleWatchdog = createIdleWatchdog(policy.idleMs, () => {
      timeoutController.abort(
        new TimeoutAbortError(
          'llm-idle',
          `LLM request timed out: no stream data for ${policy.idleMs}ms ` +
            '(continuous output renews the idle budget; only a stall trips it)',
        ),
      );
    });
    // 统一把"本次尝试被中止"翻译成可区分语义的错误。
    const abortError = (): Error => {
      const reason = timeoutController.signal.reason;
      if (reason instanceof TimeoutAbortError) {
        return new Error(
          `${reason.message}${attempt > 0 ? ` (after ${attempt + 1} attempts)` : ''}`,
        );
      }
      return new DOMException('Aborted', 'AbortError');
    };

    const inline = new InlineThinkEmitter((type, delta) => {
      if (delta) onDelta?.({ messageId, type, delta });
    });
    // 思考档次只在用户显式配置（且非 off）时才介入请求，两条路径：
    //  - 未配置/off → models.stream：与引入思考档次前逐字节一致。不主动发任何
    //    思考参数，也不会引入 streamSimple 的两个副作用（anthropic 系 provider
    //    的 thinking:{type:"disabled"} 字段、maxTokens 按剩余窗口钳制）。
    //  - 配置了档次 → models.streamSimple：pi-ai 的 provider 无关思考入口，
    //    reasoning 被 clampThinkingLevel 按模型能力收敛，并按 thinkingFormat/
    //    thinkingLevelMap 映射成厂商参数（deepseek thinking:{type} +
    //    reasoning_effort、通用 reasoning_effort、anthropic thinking+budget 等），
    //    同时封顶思考预算。两者事件流（thinking_delta/toolcall_delta）完全一致。
    const thinkingLevel = activeThinkingLevel(config.thinkingLevel);
    const streamOptions = {
      // 传派生信号而非用户信号：连接/空闲超时能真实中止在途 fetch；
      // 用户取消经由派生控制器仍以 AbortError 抵达（语义不变）。
      signal: timeoutController.signal,
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        piFetch(
          input,
          init,
          diagnostics,
          model.api === 'openai-completions',
          // 每次 HTTP 请求发出都通知（重试时 attempt 递增）。
          () => onRequestSent?.(attempt + 1),
        ),
      sessionId: config.sessionId,
      headers: requestHeadersFor(config),
      // v2.3 分层超时：不再传统一 timeoutMs。单请求总时限会掐断持续输出中的
      // 长生成；连接与空闲两个边界已由本层接管。
      maxRetries: 0,
      maxTokens: model.maxTokens,
    };
    const stream = thinkingLevel
      ? models.streamSimple(model, context, { ...streamOptions, reasoning: thinkingLevel })
      : models.stream(model, context, streamOptions);

    try {
      // v1.10：原生适配器（Anthropic/Google…）只暴露已解析的参数对象，畸形 JSON
      // 会被解成 {}；这里累积 toolcall_delta 的原始片段，交给 Runtime 统一解析器。
      const rawArguments = new ToolArgumentAccumulator();
      for await (const event of stream) {
        idleWatchdog.poke();
        // start 可由适配器本地发出，不能作为首个已解析模型事件的证据。
        if (!responseStarted && event.type !== 'start' && event.type !== 'error') {
          responseStarted = true;
          reportTransport({ phase: 'first_event' });
        }
        if (event.type === 'text_delta') {
          emittedContent = true;
          inline.push(event.delta);
        }
        if (event.type === 'thinking_delta') {
          onDelta?.({ messageId, type: 'reasoning_delta', delta: event.delta });
        }
        if (event.type === 'toolcall_delta') {
          emittedContent = true;
          rawArguments.push(event.contentIndex, event.delta);
        }
        if (event.type === 'error' && event.reason === 'aborted') {
          throw abortError();
        }
      }
      inline.push('', true);

      const result = await stream.result();
      if (result.stopReason === 'aborted' || timeoutController.signal.aborted) {
        throw abortError();
      }
      if (result.stopReason !== 'error') {
        // 恢复被适配器丢弃的原始参数：只在解码结果为空且原文非 "{}" 时接管。
        diagnostics.toolArgumentsById = mergeRawArguments(
          diagnostics.toolArgumentsById,
          rawArgumentsByToolCallId(result.content, rawArguments.snapshot()),
        );
        const message = toLegacyMessage(
          result,
          diagnostics.toolNamesById,
          diagnostics.toolArgumentsById,
        );
        // 运行时 usage 可能缺失/损坏（第三方兼容端点）。normalizeTokenUsage
        // 宁缺勿错：任一桶异常即整体拒绝，绝不因统计字段让整次调用失败。
        const usage = normalizeTokenUsage(result.usage);
        const providerContinuation = captureProviderContinuation(result, identity);
        return {
          ...message,
          stopReason: result.stopReason,
          ...(providerContinuation ? { providerContinuation } : {}),
          ...(usage === undefined ? {} : { usage }),
        };
      }
      if (attempt >= MAX_RETRIES || emittedContent || !shouldRetry(result, diagnostics)) {
        throw formatTransportError(result, diagnostics, totalAttempts + diagnostics.attempts);
      }
      reportTransport({
        phase: 'failed',
        reason: diagnostics.status === undefined ? 'network_error' : 'http_error',
        status: diagnostics.status,
      });
    } catch (error) {
      // 只依据派生信号中的结构化来源恢复连接超时，不按错误字符串猜测。
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const reason = timeoutController.signal.reason;
      reportTransport({
        phase: 'failed',
        reason:
          reason instanceof TimeoutAbortError
            ? reason.source === 'llm-connect'
              ? 'connect_timeout'
              : 'idle_timeout'
            : diagnostics.status !== undefined
              ? 'http_error'
              : diagnostics.responseReceived
                ? 'response_error'
                : 'network_error',
        status: diagnostics.status,
      });
      const connectTimeout = reason instanceof TimeoutAbortError && reason.source === 'llm-connect';
      // 只吐了思考（无正文/工具调用）时的瞬时传输/服务端错误可安全重放；一旦产出过内容，
      // 重放会重复副作用，维持"不重放半截响应"的旧语义不变。
      const replayableTransient = !emittedContent && isTransientStreamError(
        error instanceof Error ? error.message : String(error),
      );
      if (!(connectTimeout || replayableTransient) || attempt >= MAX_RETRIES) throw error;
    } finally {
      // 无论成功、失败还是被中止：清理本尝试的空闲看门狗与用户取消监听。
      idleWatchdog.dispose();
      signal?.removeEventListener('abort', onUserAbort);
      totalAttempts += diagnostics.attempts;
    }
    // 先释放上次尝试的看门狗/监听，再退避；用户取消可立即中断等待。
    reportTransport({ phase: 'retry', delayMs: retryDelayMs(attempt, diagnostics) });
    await retryDelay(attempt, diagnostics, signal);
  }

  throw new Error('LLM request failed');
}
