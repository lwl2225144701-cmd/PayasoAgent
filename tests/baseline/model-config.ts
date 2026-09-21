// 评测配置快照：完整配置只留在内存，产物仅记录端点、模型与不可逆凭证指纹。
import { createHash } from 'node:crypto';

export interface BenchmarkModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  credentialFingerprint: string;
  configFingerprint: string;
}

export function benchmarkModelConfig(
  env: Record<string, string | undefined> = process.env,
): BenchmarkModelConfig {
  const rawBaseUrl = env.OPENAI_BASE_URL?.trim();
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!rawBaseUrl || !apiKey || !model) {
    throw new Error('评测必须显式配置 OPENAI_BASE_URL、OPENAI_API_KEY 和 OPENAI_MODEL');
  }
  const parsed = new URL(rawBaseUrl);
  parsed.search = '';
  parsed.hash = '';
  const baseUrl = parsed.toString().replace(/\/$/, '');
  const credentialFingerprint = createHash('sha256')
    .update(`payaso-benchmark-credential\0${apiKey}`)
    .digest('hex');
  const configFingerprint = createHash('sha256')
    .update(JSON.stringify({ baseUrl, model, credentialFingerprint }))
    .digest('hex');
  return { baseUrl, apiKey, model, credentialFingerprint, configFingerprint };
}

export function publicModelConfig(config: BenchmarkModelConfig) {
  return {
    source: 'env-explicit' as const,
    baseUrl: config.baseUrl,
    chatCompletionsUrl: `${config.baseUrl}/chat/completions`,
    model: config.model,
    credentialFingerprint: config.credentialFingerprint,
    configFingerprint: config.configFingerprint,
  };
}
