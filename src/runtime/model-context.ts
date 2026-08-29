// Model context capabilities and conservative token estimation.
// Host/Runtime owns these values; they are never exposed as LLM tool arguments.
//
// v1.6 模型身份规则：当前 Run 选择什么模型，Context Budget 就必须按什么模型计算。
// - 显式路径（传入 model，即 Run 的 model snapshot）：能力只由该模型决定
//   （输入参数 > 注册表 > 保守兜底），环境变量完全不参与 —— 禁止
//   "Run 用模型 A、能力按环境模型 B 计算"。
// - 环境路径（未传 model，CLI / legacy）：环境变量按原语义生效
//   （OPENAI_MODEL 选择模型，数值变量覆盖注册表）。

export type ModelContextSource = "run_model" | "env" | "model_registry" | "fallback";

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

const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_768;
const FALLBACK_MAX_OUTPUT_TOKENS = 4_096;

const MODEL_CAPABILITIES: ModelCapability[] = [
  {
    pattern: /^MiniMax-M3$/i,
    // Official M3 API page advertises up to 1M and guarantees at least 512K.
    // Use the guaranteed lower bound unless the Host explicitly overrides it.
    contextWindowTokens: 512_000,
    maxOutputTokens: 16_384,
  },
];

function positiveIntegerEnv(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
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
  const safetyTokens = args.safetyTokens ?? Math.max(2_048, Math.ceil(args.contextWindowTokens * 0.02));
  const maxInputTokens = args.contextWindowTokens - args.maxOutputTokens - safetyTokens;
  if (maxInputTokens <= 0) {
    throw new Error(
      "Model context configuration is invalid: output reserve + safety reserve must be smaller than the context window"
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
  env: Record<string, string | undefined> = process.env
): ModelContextConfig {
  // 显式模型路径（Run snapshot）：数值环境变量不参与，防止环境模型变相决定能力
  const explicitModel = input.model?.trim();
  if (explicitModel) {
    const capability = MODEL_CAPABILITIES.find((item) => item.pattern.test(explicitModel));
    return buildConfig({
      model: explicitModel,
      contextWindowTokens:
        positiveIntegerInput(input.contextWindowTokens, "contextWindowTokens")
        ?? capability?.contextWindowTokens
        ?? FALLBACK_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens:
        positiveIntegerInput(input.maxOutputTokens, "maxOutputTokens")
        ?? capability?.maxOutputTokens
        ?? FALLBACK_MAX_OUTPUT_TOKENS,
      safetyTokens: positiveIntegerInput(input.safetyTokens, "safetyTokens"),
      source: "run_model",
    });
  }

  // 环境变量路径（CLI / legacy）：与 v1.5 语义保持一致
  const model = env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const capability = MODEL_CAPABILITIES.find((item) => item.pattern.test(model));
  const configuredWindow = positiveIntegerEnv(env.MODEL_CONTEXT_WINDOW_TOKENS, "MODEL_CONTEXT_WINDOW_TOKENS");
  return buildConfig({
    model,
    contextWindowTokens:
      configuredWindow
      ?? capability?.contextWindowTokens
      ?? FALLBACK_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens:
      positiveIntegerEnv(env.MODEL_MAX_OUTPUT_TOKENS, "MODEL_MAX_OUTPUT_TOKENS")
      ?? capability?.maxOutputTokens
      ?? FALLBACK_MAX_OUTPUT_TOKENS,
    safetyTokens: positiveIntegerEnv(env.MODEL_CONTEXT_SAFETY_TOKENS, "MODEL_CONTEXT_SAFETY_TOKENS"),
    source: configuredWindow ? "env" : capability ? "model_registry" : "fallback",
  });
}

// Conservative mixed-text estimate for providers without a local tokenizer:
// ASCII-heavy JSON is estimated at 3 chars/token; each non-ASCII code point is
// counted as one token. The separate safety reserve absorbs provider variance.
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
  return estimateTextTokens(JSON.stringify(value) ?? "");
}
