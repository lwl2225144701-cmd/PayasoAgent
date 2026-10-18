// 套件: 重复调用观察策略（Harness 纯函数，无 LLM）
// 用法: node --import tsx tests/repeat-call-policy.test.ts
// 验收：
//   1. 调用身份 = 工具名 + 深度排序参数 → 字段顺序无关，值不同即不同身份
//   2. 3/5/8 阈值分级：只跨新阈值才提醒，同一级别不重复投递
//   3. 全部处置都计数（执行成功/失败/拒绝/回放/不确定/参数无效）——拒绝也能被"换个写法"绕过
//   4. 不同调用重置连续性（轮询/等待类任务本身合法，不该被累计打扰）
//   5. 参数预览脱敏：敏感键名（任意深度）一律 ***，自由文本/超长值只留长度与摘要
//   6. 归一化全量防御：checkpoint 旧记录/手改数据不抛错
//   7. env 可调可关；阈值顺序非法（warn>escalate>block）直接报错
//   8. attempts 与 count 分工：一次调用内部重试不放大重复计数，尝试次数单独记录
import assert from 'node:assert/strict';
import {
  advanceRepeatCall,
  DEFAULT_REPEAT_CALL_POLICY,
  normalizeRepeatCallReminder,
  normalizeRepeatCallState,
  type RepeatCallPolicy,
  type RepeatCallReminder,
  type RepeatCallState,
  renderRepeatCallReminder,
  repeatCallKey,
  resolveRepeatCallPolicy,
  sanitizeArgsPreview,
  type ToolInvocationObservation,
} from '../src/harness/repeat-call-policy.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

const P = DEFAULT_REPEAT_CALL_POLICY;
const read = (path = 'src/a.ts'): ToolInvocationObservation => ({
  tool: 'read',
  args: { path },
  disposition: 'executed',
});
/** 连续观察 n 次同身份调用，返回最后一次的 reminder（或 undefined）。 */
function repeat(
  n: number,
  observation: ToolInvocationObservation = read(),
  policy: RepeatCallPolicy = P,
): RepeatCallState {
  let state: RepeatCallState | undefined;
  for (let i = 0; i < n; i++) state = advanceRepeatCall(state, observation, policy).state;
  assert.ok(state, '至少观察一次');
  return state;
}

// ---- 核心：调用身份 ----

check('字段顺序不同不构成不同身份（LLM 序列化顺序不稳定）', () => {
  const a = repeatCallKey('read', { path: 'a.ts', limit: 10 });
  const b = repeatCallKey('read', { limit: 10, path: 'a.ts' });
  assert.equal(a, b, '深度排序后应一致');
});

check('值不同即不同身份', () => {
  assert.notEqual(repeatCallKey('read', { path: 'a.ts' }), repeatCallKey('read', { path: 'b.ts' }));
  assert.notEqual(
    repeatCallKey('read', { path: 'a.ts' }),
    repeatCallKey('grep', { path: 'a.ts' }),
    '工具名也参与身份',
  );
});

check('嵌套对象同样深度排序', () => {
  const a = repeatCallKey('edit', { edits: [{ oldText: 'x', newText: 'y' }] });
  const b = repeatCallKey('edit', { edits: [{ newText: 'y', oldText: 'x' }] });
  assert.equal(a, b);
});

// ---- 核心：分级阈值 ----

check('3/5/8 阈值分级，只在跨新阈值时提醒', () => {
  const reminders: number[] = [];
  let state: RepeatCallState | undefined;
  for (let i = 1; i <= 9; i++) {
    const step = advanceRepeatCall(state, read(), P);
    state = step.state;
    if (step.reminder) reminders.push(step.reminder.level);
  }
  assert.deepEqual(reminders, [1, 2, 3], '每级只投递一次');
  assert.equal(state?.count, 9);
  assert.equal(state?.level, 3);
});

check('第 1、2 次调用不提醒（合法的一次读取 + 一次复查）', () => {
  assert.equal(advanceRepeatCall(undefined, read(), P).reminder, undefined);
  const second = advanceRepeatCall(repeat(1), read(), P);
  assert.equal(second.reminder, undefined);
});

check('提醒携带工具名、计数与脱敏预览', () => {
  const reminder = advanceRepeatCall(repeat(2), read(), P).reminder;
  assert.ok(reminder);
  assert.equal(reminder.tool, 'read');
  assert.equal(reminder.count, 3);
  assert.equal(reminder.level, 1);
  assert.match(reminder.preview, /read\(path=src\/a\.ts\)/);
});

check('自定义阈值生效（SDK 可覆盖）', () => {
  const policy: RepeatCallPolicy = { warnAt: 2, escalateAt: 3, blockAt: 4 };
  const reminders: number[] = [];
  let state: RepeatCallState | undefined;
  for (let i = 1; i <= 4; i++) {
    const step = advanceRepeatCall(state, read(), policy);
    state = step.state;
    if (step.reminder) reminders.push(step.reminder.level);
  }
  assert.deepEqual(reminders, [1, 2, 3]);
});

// ---- 核心：全部处置都计数（覆盖 9 个出口） ----

check('执行成功也计数（成功路径上的无限轮询同样不收敛）', () => {
  assert.equal(repeat(3).count, 3);
});

check('拒绝/回放/不确定/参数无效同样计数——"换个写法"绕不过', () => {
  // 场景：同一坏调用连续 3 次，第 1 次失败、第 2 次被 isBlocked 拒、第 3 次参数无效。
  // 历史上三种处置互不感知，Harness 永远看不到"第 3 次"。
  const dispositions: Array<ToolInvocationObservation['disposition']> = [
    'failed',
    'denied',
    'invalid',
  ];
  let state: RepeatCallState | undefined;
  let reminderLevel = 0;
  for (const disposition of dispositions) {
    const step = advanceRepeatCall(state, { ...read(), disposition }, P);
    state = step.state;
    if (step.reminder) reminderLevel = step.reminder.level;
  }
  assert.equal(state?.count, 3);
  assert.equal(reminderLevel, 1, '三种处置累计到 warn 阈值');
  assert.equal(state?.lastDisposition, 'invalid');
});

check('side-effect 回放（未执行）也计入重复', () => {
  const state = repeat(3, { ...read(), disposition: 'replayed' });
  assert.equal(state.count, 3);
  assert.equal(state.lastDisposition, 'replayed');
});

check('invalid_result（已执行但结果无效）与 invalid（未执行）是两种处置', () => {
  const state = repeat(3, { ...read(), disposition: 'invalid_result' });
  assert.equal(state.count, 3);
  assert.equal(state.lastDisposition, 'invalid_result');
  assert.equal(
    normalizeRepeatCallState({ ...state, lastDisposition: 'invalid_result' })?.lastDisposition,
    'invalid_result',
    '归一化接受新取值',
  );
  assert.equal(
    normalizeRepeatCallState({ ...state, lastDisposition: 'nope' })?.lastDisposition,
    'executed',
    '未知取值仍收敛到安全默认',
  );
});

// ---- 核心：连续性 ----

check('不同调用重置连续性（轮询/等待类任务合法，不该被累计打扰）', () => {
  const first = advanceRepeatCall(repeat(2), read('src/a.ts'), P);
  const second = advanceRepeatCall(first.state, read('src/b.ts'), P);
  assert.equal(second.state.count, 1, '换了参数就是新身份，从 1 开始');
  assert.equal(second.state.level, 0);
  assert.equal(second.reminder, undefined);
});

check('轮询同一路径 8 次仍只提醒不阻断（合法等待场景保留）', () => {
  const state = repeat(8);
  assert.equal(state.level, 3);
  assert.match(
    renderRepeatCallReminder({ tool: 'read', count: 8, level: 3, attempts: 0, preview: 'x' }),
    /Legitimate polling is allowed/,
  );
});

// ---- 核心：脱敏与有界 ----

check('敏感键名一律脱敏为 ***', () => {
  const preview = sanitizeArgsPreview('shell', {
    command: 'ls',
    apiKey: 'sk-secret-value',
    password: 'p@ss',
    token: 't',
  });
  assert.match(preview, /apiKey=\*\*\*/);
  assert.match(preview, /password=\*\*\*/);
  assert.match(preview, /token=\*\*\*/);
  assert.doesNotMatch(preview, /sk-secret-value/);
  assert.doesNotMatch(preview, /p@ss/);
});

check('嵌套凭证同样脱敏（任意深度的对象/数组都递归掩码）', () => {
  const preview = sanitizeArgsPreview('http', {
    url: 'https://example.com',
    options: {
      headers: { Authorization: 'Bearer sk-nested-secret', 'x-trace-id': 'abc' },
      retry: { attempts: 3, backoffMs: 100 },
    },
    envs: [{ name: 'A', apiKey: 'sk-array-secret' }],
  });
  assert.match(preview, /Authorization=\*\*\*/);
  assert.match(preview, /apiKey=\*\*\*/);
  assert.doesNotMatch(preview, /sk-nested-secret/);
  assert.doesNotMatch(preview, /sk-array-secret/);
  // 非敏感的结构信息仍然保留（识别"哪一次重复"所需）。
  assert.match(preview, /url=https:\/\/example\.com/);
  assert.match(preview, /attempts=3/);
});

check('命令/正文等自由文本只保留长度与摘要（不原文进提醒）', () => {
  const preview = sanitizeArgsPreview('shell', {
    command: 'curl -H "Authorization: Bearer sk-inline" https://x.example',
    cwd: '/tmp',
  });
  assert.match(preview, /command=<text \d+chars sha256:[0-9a-f]{8}>/);
  assert.doesNotMatch(preview, /sk-inline/);
  assert.doesNotMatch(preview, /curl/);
  assert.match(preview, /cwd=\/tmp/, '短的非自由文本值保留原文');
});

check('预览长度有界（超长值走摘要，不会把参数原文塞进提醒）', () => {
  const preview = sanitizeArgsPreview('write', { path: 'a.ts', content: 'x'.repeat(500) });
  assert.ok(preview.length <= 210, `预览应有界，实际 ${preview.length}`);
  assert.match(preview, /content=<text 500chars sha256:[0-9a-f]{8}>/);
  assert.doesNotMatch(preview, /xxxx/);
});

check('模型上下文、事件与 checkpoint 共用同一份脱敏结果', () => {
  const args = { command: 'deploy --token sk-xyz', path: 'infra' };
  const observation: ToolInvocationObservation = {
    tool: 'shell',
    args,
    disposition: 'executed',
    attempts: 1,
  };
  let state: RepeatCallState | undefined;
  let reminder: RepeatCallReminder | undefined;
  for (let i = 0; i < 3; i++) {
    const step = advanceRepeatCall(state, observation, P);
    state = step.state;
    if (step.reminder) reminder = step.reminder;
  }
  assert.ok(reminder, '第 3 次同身份调用跨过 warn 阈值应有提醒');
  assert.equal(state?.preview, reminder.preview, 'checkpoint 与提醒同一份');
  assert.doesNotMatch(renderRepeatCallReminder(reminder), /sk-xyz/);
  assert.doesNotMatch(state?.preview ?? '', /sk-xyz/);
});

// ---- 核心：attempts 与 count 分工 ----

check('一次调用内部重试不放大重复计数，attempts 单独记录', () => {
  const failing: ToolInvocationObservation = {
    tool: 'shell',
    args: { command: 'build' },
    disposition: 'failed',
    attempts: 3,
  };
  const first = advanceRepeatCall(undefined, failing, P);
  assert.equal(first.state.count, 1, '内部重试 3 次仍是一次调用');
  assert.equal(first.state.lastAttempts, 3, '尝试次数单独记录');
  const second = advanceRepeatCall(first.state, failing, P);
  assert.equal(second.state.count, 2);
  assert.equal(second.reminder, undefined, '第 2 次未到 warn 阈值');
  const third = advanceRepeatCall(second.state, failing, P);
  assert.equal(third.state.count, 3, '重试不放大计数');
  assert.equal(third.reminder?.attempts, 3, '提醒携带本次调用的尝试次数');
});

check('未进入执行的处置 attempts 记 0', () => {
  const state = repeat(1, { ...read(), disposition: 'denied' });
  assert.equal(state.lastAttempts, 0);
  assert.equal(
    normalizeRepeatCallState({ key: 'abc', count: 1, lastAttempts: -1 })?.lastAttempts,
    0,
    '非法 attempts → 0',
  );
});

// ---- 核心：归一化（checkpoint 旧记录/手改数据全量防御） ----

check('归一化：缺字段/坏类型不抛错', () => {
  assert.equal(normalizeRepeatCallState(undefined), undefined);
  assert.equal(normalizeRepeatCallState(null), undefined);
  assert.equal(normalizeRepeatCallState({}), undefined, '无 key 视为无效');
  assert.equal(normalizeRepeatCallState({ key: 42 }), undefined);
});

check('归一化：坏 count/level/disposition 收敛到安全值', () => {
  const state = normalizeRepeatCallState({
    key: 'abc',
    count: -5,
    level: 'bad',
    lastDisposition: 'nope',
    preview: 123,
  });
  assert.ok(state);
  assert.equal(state.count, 1, '非法 count → 1');
  assert.equal(state.level, 0, '非法 level → 0');
  assert.equal(state.lastDisposition, 'executed', '非法 disposition → executed');
  assert.equal(state.preview, '', '非字符串 preview → 空');
});

check('归一化：preview 截断到 512 字符', () => {
  const state = normalizeRepeatCallState({ key: 'abc', count: 2, preview: 'x'.repeat(600) });
  assert.equal(state?.preview.length, 512);
});

check('归一化提醒：0 级提醒无意义，判为无效', () => {
  assert.equal(normalizeRepeatCallReminder(undefined), undefined);
  assert.equal(normalizeRepeatCallReminder({ tool: 'read', count: 3, level: 0 }), undefined);
  assert.equal(normalizeRepeatCallReminder({ tool: '', count: 3, level: 1 }), undefined);
  const ok = normalizeRepeatCallReminder({ tool: 'read', count: 3, level: 2 });
  assert.equal(ok?.level, 2);
  assert.equal(ok?.count, 3);
});

// ---- 核心：env 可调可关 ----

check('env：未配置时默认开启', () => {
  assert.deepEqual(resolveRepeatCallPolicy({}), DEFAULT_REPEAT_CALL_POLICY);
});

check('env：off 显式关闭', () => {
  assert.equal(resolveRepeatCallPolicy({ PAYASO_REPEAT_CALL_REMINDER: 'off' }), false);
});

check('env：阈值可覆盖', () => {
  const policy = resolveRepeatCallPolicy({
    PAYASO_REPEAT_WARN_AT: '2',
    PAYASO_REPEAT_ESCALATE_AT: '4',
    PAYASO_REPEAT_BLOCK_AT: '6',
  });
  assert.deepEqual(policy, { warnAt: 2, escalateAt: 4, blockAt: 6 });
});

check('env：非法值回退默认（配置错误不静默改变行为方向）', () => {
  const policy = resolveRepeatCallPolicy({ PAYASO_REPEAT_WARN_AT: 'abc' });
  assert.equal(policy && policy.warnAt, DEFAULT_REPEAT_CALL_POLICY.warnAt);
});

check('env：阈值顺序非法直接报错（warn<=escalate<=block）', () => {
  assert.throws(
    () => resolveRepeatCallPolicy({ PAYASO_REPEAT_WARN_AT: '9', PAYASO_REPEAT_ESCALATE_AT: '5' }),
    /Invalid repeat call policy/,
  );
});

// ---- 回归：提醒文本注入模型视图 ----

check('提醒文本：陈述事实 + 不代模型下结论', () => {
  const text = renderRepeatCallReminder({
    tool: 'read',
    count: 3,
    level: 1,
    attempts: 1,
    preview: 'read(path=src/a.ts)',
  });
  assert.match(text, /\[Repeated call review\]/);
  assert.match(text, /has been called 3 times in a row/);
  assert.match(text, /Legitimate polling is allowed/);
});

console.log(`\nrepeat-call-policy 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
