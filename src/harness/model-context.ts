// Harness-owned model context capabilities and conservative token estimation.
// These values shape the model view; they are never exposed as tool arguments.

export type ModelContextSource = 'run_model' | 'env' | 'model_registry' | 'fallback';

export interface ModelContextInput {
  /** 当前 Run 显式选中的模型（Run model snapshot）。缺省时走环境变量路径。 */
  model?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  safetyTokens?: number;
}

export interface ModelContextConfig {
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyTokens: number;
  maxInputTokens: number;
  source: ModelContextSource;
}

interface ModelCapability {
  pattern: RegExp;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

// 未知模型（不在注册表）的 fallback = 引入模型的已知窗口下限 256K。
// 当前引入的模型上下文窗口基本都在 256K 及以上；若将来接入更低窗口的模型，
// 应在 MODEL_CAPABILITIES 显式登记（而不是调低这个值）。
const FALLBACK_CONTEXT_WINDOW_TOKENS = 262_144;
// 输出预留保持保守：未知模型的 max_tokens 上限未知，4K 是各家普遍安全的取值
const FALLBACK_MAX_OUTPUT_TOKENS = 4_096;

const MODEL_CAPABILITIES: ModelCapability[] = [
  {
    pattern: /^MiniMax-M3$/i,
    contextWindowTokens: 512_000,
    maxOutputTokens: 16_384,
  },
];

function positiveIntegerEnv(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveIntegerInput(value: number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function buildConfig(args: {
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyTokens: number | null;
  source: ModelContextSource;
}): ModelContextConfig {
  const safetyTokens =
    args.safetyTokens ?? Math.max(2_048, Math.ceil(args.contextWindowTokens * 0.02));
  const maxInputTokens = args.contextWindowTokens - args.maxOutputTokens - safetyTokens;
  if (maxInputTokens <= 0) {
    throw new Error(
      'Model context configuration is invalid: output reserve + safety reserve must be smaller than the context window',
    );
  }
  return {
    model: args.model,
    contextWindowTokens: args.contextWindowTokens,
    maxOutputTokens: args.maxOutputTokens,
    safetyTokens,
    maxInputTokens,
    source: args.source,
  };
}

export function resolveModelContextConfig(
  input: ModelContextInput = {},
  env: Record<string, string | undefined> = process.env,
): ModelContextConfig {
  const explicitModel = input.model?.trim();
  if (explicitModel) {
    const capability = MODEL_CAPABILITIES.find((item) => item.pattern.test(explicitModel));
    return buildConfig({
      model: explicitModel,
      contextWindowTokens:
        positiveIntegerInput(input.contextWindowTokens, 'contextWindowTokens') ??
        capability?.contextWindowTokens ??
        FALLBACK_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens:
        positiveIntegerInput(input.maxOutputTokens, 'maxOutputTokens') ??
        capability?.maxOutputTokens ??
        FALLBACK_MAX_OUTPUT_TOKENS,
      safetyTokens: positiveIntegerInput(input.safetyTokens, 'safetyTokens'),
      source: 'run_model',
    });
  }

  const model = env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const capability = MODEL_CAPABILITIES.find((item) => item.pattern.test(model));
  const configuredWindow = positiveIntegerEnv(
    env.MODEL_CONTEXT_WINDOW_TOKENS,
    'MODEL_CONTEXT_WINDOW_TOKENS',
  );
  return buildConfig({
    model,
    contextWindowTokens:
      configuredWindow ?? capability?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens:
      positiveIntegerEnv(env.MODEL_MAX_OUTPUT_TOKENS, 'MODEL_MAX_OUTPUT_TOKENS') ??
      capability?.maxOutputTokens ??
      FALLBACK_MAX_OUTPUT_TOKENS,
    safetyTokens: positiveIntegerEnv(
      env.MODEL_CONTEXT_SAFETY_TOKENS,
      'MODEL_CONTEXT_SAFETY_TOKENS',
    ),
    source: configuredWindow ? 'env' : capability ? 'model_registry' : 'fallback',
  });
}

export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 3) + nonAscii;
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value) ?? '');
}
