// Harness-owned model context capabilities and conservative token estimation.
// These values shape the model view; they are never exposed as tool arguments.

export type ModelSelectionSource = 'run' | 'env';
export type ModelContextSource = 'settings' | 'env' | 'model_registry' | 'fallback';

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
  modelSource: ModelSelectionSource;
  source: ModelContextSource;
}

interface ModelCapability {
  pattern: RegExp;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Model-specific behavior notes injected into system prompt (model.adaptation segment). */
  promptNotes?: string;
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
    promptNotes:
      'The final answer MUST be written to the content field. ' +
      'Reasoning is for thinking only. ' +
      'Empty content = task failure.',
  },
];

export function getKnownModelCapability(
  model: string,
): { contextWindowTokens: number; maxOutputTokens: number; promptNotes?: string } | undefined {
  const capability = MODEL_CAPABILITIES.find((item) => item.pattern.test(model.trim()));
  return capability
    ? {
        contextWindowTokens: capability.contextWindowTokens,
        maxOutputTokens: capability.maxOutputTokens,
        promptNotes: capability.promptNotes,
      }
    : undefined;
}

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
  modelSource: ModelSelectionSource;
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
    modelSource: args.modelSource,
    source: args.source,
  };
}

export function resolveModelContextConfig(
  input: ModelContextInput = {},
  env: Record<string, string | undefined> = process.env,
): ModelContextConfig {
  const explicitModel = input.model?.trim();
  if (explicitModel) {
    const capability = getKnownModelCapability(explicitModel);
    const hasSettingsOverride =
      input.contextWindowTokens !== undefined || input.maxOutputTokens !== undefined;
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
      modelSource: 'run',
      source: hasSettingsOverride ? 'settings' : capability ? 'model_registry' : 'fallback',
    });
  }

  const model = env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  const capability = getKnownModelCapability(model);
  const configuredWindow = positiveIntegerEnv(
    env.MODEL_CONTEXT_WINDOW_TOKENS,
    'MODEL_CONTEXT_WINDOW_TOKENS',
  );
  const configuredOutput = positiveIntegerEnv(
    env.MODEL_MAX_OUTPUT_TOKENS,
    'MODEL_MAX_OUTPUT_TOKENS',
  );
  return buildConfig({
    model,
    contextWindowTokens:
      configuredWindow ?? capability?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: configuredOutput ?? capability?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS,
    safetyTokens: positiveIntegerEnv(
      env.MODEL_CONTEXT_SAFETY_TOKENS,
      'MODEL_CONTEXT_SAFETY_TOKENS',
    ),
    modelSource: 'env',
    source:
      configuredWindow || configuredOutput ? 'env' : capability ? 'model_registry' : 'fallback',
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

// ---- 消息结构开销与图片视觉定价 ----
// 与 pi-ai/DSH 对齐：每条消息额外计 ROLE_OVERHEAD（角色/JSON 框架）。
export const ROLE_OVERHEAD = 4;

// 视觉 token 定价（Strategy：按像素 tile 计价的默认策略，缺尺寸退回固定启发式）。
// OpenAI 高细节口径：85 基准 + 170/tile，tile = ⌈w/512⌉×⌈h/512⌉，上限 10 tile（≈1105）。
const IMAGE_BASE_TOKENS = 85;
const IMAGE_TILE_TOKENS = 170;
const IMAGE_MAX_TILES = 10;
// 无尺寸信息（旧记录/路径引用未带 width/height）时的保守固定预算。
const IMAGE_FALLBACK_TOKENS = 1000;

/**
 * 估算一张图片的 token 成本。有归一化后像素尺寸时按 tile 计价；
 * 缺尺寸时退回固定启发式（保守，保证图片轮不超支）。
 * @param image - 仅消费 width/height 两个叶子字段，与 MessageImage 解耦。
 */
export function estimateImageTokens(image: { width?: number; height?: number }): number {
  const width = image.width;
  const height = image.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width! <= 0 || height! <= 0) {
    return IMAGE_FALLBACK_TOKENS;
  }
  const tiles = Math.min(IMAGE_MAX_TILES, Math.ceil(width! / 512) * Math.ceil(height! / 512));
  return IMAGE_BASE_TOKENS + IMAGE_TILE_TOKENS * tiles;
}
