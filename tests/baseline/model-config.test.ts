// 评测配置快照单测：地址可审计、密钥不落盘、配置变化必须形成新轨道。
import assert from 'node:assert/strict';
import { benchmarkModelConfig, publicModelConfig } from './model-config.js';

const env = {
  OPENAI_BASE_URL: 'https://api.stepfun.com/step_plan/v1/?ignored=1#ignored',
  OPENAI_API_KEY: 'test-secret-a',
  OPENAI_MODEL: 'step-5-preview',
};
const first = benchmarkModelConfig(env);
const publicFirst = publicModelConfig(first);

assert.equal(first.baseUrl, 'https://api.stepfun.com/step_plan/v1');
assert.equal(publicFirst.chatCompletionsUrl, 'https://api.stepfun.com/step_plan/v1/chat/completions');
assert.equal(JSON.stringify(publicFirst).includes(env.OPENAI_API_KEY), false);
assert.equal(publicFirst.credentialFingerprint.length, 64);
assert.equal(publicFirst.configFingerprint.length, 64);

const changedKey = benchmarkModelConfig({ ...env, OPENAI_API_KEY: 'test-secret-b' });
const changedModel = benchmarkModelConfig({ ...env, OPENAI_MODEL: 'step-3.7-flash' });
const changedUrl = benchmarkModelConfig({ ...env, OPENAI_BASE_URL: 'https://api.stepfun.com/v1' });
assert.notEqual(changedKey.configFingerprint, first.configFingerprint);
assert.notEqual(changedModel.configFingerprint, first.configFingerprint);
assert.notEqual(changedUrl.configFingerprint, first.configFingerprint);

assert.throws(
  () => benchmarkModelConfig({ OPENAI_BASE_URL: env.OPENAI_BASE_URL, OPENAI_MODEL: env.OPENAI_MODEL }),
  /必须显式配置/,
);

console.log('Benchmark model config: PASS');
