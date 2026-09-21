// 环境变量端点必须原样生效，传输层不能按模型名静默切换订阅/计费通道。
import assert from 'node:assert/strict';

process.env.OPENAI_BASE_URL = 'https://api.stepfun.com/step_plan/v1';
process.env.OPENAI_API_KEY = 'test-only-key';
process.env.OPENAI_MODEL = 'step-5-preview';

let requested = '';
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input) => {
  requested = String(input);
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;
try {
  const { chat } = await import('../src/llm/llm.js');
  await chat([{ role: 'user', content: 'hello' }]);
  assert.equal(requested, 'https://api.stepfun.com/step_plan/v1/chat/completions');
  console.log('StepFun endpoint authority: PASS');
} finally {
  globalThis.fetch = originalFetch;
}
