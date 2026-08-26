// Model context capabilities and conservative token estimation.
// Host/Runtime owns these values; they are never exposed as LLM tool arguments.

export type ModelContextSource = "env" | "model_registry" | "fallback";

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

function positiveInteger(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function resolveModelContextConfig(
  env: Record<string, string | undefined> = process.env
): ModelContextConfig {
  const model = env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const capability = MODEL_CAPABILITIES.find((item) => item.pattern.test(model));
  const configuredWindow = positiveInteger(env.MODEL_CONTEXT_WINDOW_TOKENS, "MODEL_CONTEXT_WINDOW_TOKENS");
  const contextWindowTokens = configuredWindow
    ?? capability?.contextWindowTokens
    ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = positiveInteger(env.MODEL_MAX_OUTPUT_TOKENS, "MODEL_MAX_OUTPUT_TOKENS")
    ?? capability?.maxOutputTokens
    ?? FALLBACK_MAX_OUTPUT_TOKENS;
  const safetyTokens = positiveInteger(env.MODEL_CONTEXT_SAFETY_TOKENS, "MODEL_CONTEXT_SAFETY_TOKENS")
    ?? Math.max(2_048, Math.ceil(contextWindowTokens * 0.02));
  const maxInputTokens = contextWindowTokens - maxOutputTokens - safetyTokens;
  if (maxInputTokens <= 0) {
    throw new Error(
      "Model context configuration is invalid: output reserve + safety reserve must be smaller than the context window"
    );
  }
  return {
    model,
    contextWindowTokens,
    maxOutputTokens,
    safetyTokens,
    maxInputTokens,
    source: configuredWindow ? "env" : capability ? "model_registry" : "fallback",
  };
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
