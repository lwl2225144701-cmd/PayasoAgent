// 套件: Run 停止原因与交付结果映射（Host 纯函数）
// 用法: node --import tsx tests/run-stop-reason.test.ts
// 验收：
//   1. Runtime 停止码 → Host 持久化码一一对应（穷尽，新增码编译期即失败）
//   2. 交付结果与 run.status 正交：预算耗尽 → partial，绝不显示为任务成功
//   3. 用户主动停止与预算耗尽分开（unknown vs partial），不混为一谈
import assert from 'node:assert/strict';
import { deriveDeliveryOutcome, toStoredStopReason } from '../src/host/run-stop-reason.js';
import { type AgentStopReasonCode, AgentStopRequestedError } from '../src/runtime/agent.js';

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

const CODES: AgentStopReasonCode[] = [
  'budget_exhausted',
  'policy_denied',
  'tool_unavailable',
  'outcome_uncertain',
  'user_cancelled',
];

check('Runtime 停止码 → Host 持久化码一一对应', () => {
  for (const code of CODES) {
    assert.equal(toStoredStopReason(code), code);
  }
});

check('AgentStopRequestedError 携带稳定停止原因（默认无原因 = Harness 策略停止）', () => {
  const plain = new AgentStopRequestedError();
  assert.equal(plain.stop, undefined);
  const budget = new AgentStopRequestedError({ code: 'budget_exhausted', notice: '预算耗尽' });
  assert.equal(budget.stop?.code, 'budget_exhausted');
  assert.equal(budget.stop?.notice, '预算耗尽');
  assert.equal(budget.name, 'AgentStopRequestedError');
});

check('交付结果与 status 正交：completed 正常 → delivered', () => {
  assert.equal(deriveDeliveryOutcome('completed', undefined), 'delivered');
});

check('预算耗尽后完成（模型仍给出回答）→ partial，不是成功', () => {
  assert.equal(deriveDeliveryOutcome('completed', 'budget_exhausted'), 'partial');
});

check('预算耗尽停止 → partial；策略/工具/uncertain 停止 → blocked', () => {
  assert.equal(deriveDeliveryOutcome('stopped', 'budget_exhausted'), 'partial');
  assert.equal(deriveDeliveryOutcome('stopped', 'policy_denied'), 'blocked');
  assert.equal(deriveDeliveryOutcome('stopped', 'tool_unavailable'), 'blocked');
  assert.equal(deriveDeliveryOutcome('stopped', 'outcome_uncertain'), 'blocked');
});

check('用户主动停止 → unknown（与预算耗尽分开，不混为一谈）', () => {
  assert.equal(deriveDeliveryOutcome('stopped', undefined), 'unknown');
  assert.equal(deriveDeliveryOutcome('stopped', 'user_cancelled'), 'unknown');
});

check('failed → unknown（失败不构成任何交付声明）', () => {
  assert.equal(deriveDeliveryOutcome('failed', undefined), 'unknown');
  assert.equal(deriveDeliveryOutcome('failed', 'budget_exhausted'), 'unknown');
});

console.log(`\nrun-stop-reason 测试完成：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
