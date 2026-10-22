// 模块: 消息输入框草稿功能的真实组件交互回归（无 LLM）。
// 用法: node --import tsx tests/frontend-composer-draft-dom.test.ts （或随 npm run test:all 运行）
//
// 与 tests/frontend-composer-draft.test.ts（纯函数 + 源码契约）互补：本套件用
// tests/helpers/component-dom.ts 渲染真实 InputBar（真实 React 事件、Effect、异步 Promise），
// 用可控的异步发送结果驱动「发送等待期」的交错场景。行为断言基于 DOM 与 localStorage，
// 不用源码字符串/正则证明行为。
//
// 场景对应（需求契约见 web/src/components/InputBar/composer-draft.ts）：
//   1. 发送等待期输入新内容 → 旧发送成功后较新草稿不被删除，刷新后仍恢复。
//   2. 发送等待期切到任务 B → A 失败后草稿留在 A，不进 B 的输入框或存储。
//   3. 发送未确认时刷新 → 持久化草稿未被清空，刷新后恢复可用。
//   另覆盖：正常成功清草稿 / 正常失败合并还原 / 任务间与新建任务页隔离 / 存储不可用降级。

import assert from 'node:assert/strict';
import { createComponentDom } from './helpers/component-dom.js';

// 草稿存储键前缀与 composer-draft.ts 保持一致（只用于断言，不参与被测逻辑）。
const DRAFT_KEY_PREFIX = 'payaso.composerDraft.';

// 与 component-dom.test.ts 相同的接线方式：window.fixture 暴露可等待的操作原语。
const HARNESS_SOURCE = `
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {InputBar} from './components/InputBar/index';

const root = createRoot(document.getElementById('root'));
let setSessionExternal = null;
function Harness() {
  const [sessionId, setSessionId] = useState('task-a');
  setSessionExternal = setSessionId;
  return (
    <InputBar
      sessionId={sessionId}
      onSend={(text) => {
        (window.__sent ??= []).push(text);
        const control = window.__sendControl;
        return control ? control.promise : Promise.resolve(true);
      }}
      permissionMode="workspace-write"
    />
  );
}

function textarea() {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('textarea not found');
  return ta;
}
const valueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  'value',
).set;

window.fixture = {
  async render() { await act(async () => root.render(<Harness />)); },
  async setSession(id) { await act(async () => setSessionExternal(id)); },
  async type(text) {
    await act(async () => {
      const ta = textarea();
      valueSetter.call(ta, text);
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  },
  // Enter 触发发送（与真实键入一致，走 resolveEnterAction → handleSend）
  async pressEnter() {
    await act(async () => {
      textarea().dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
  },
  value() { return textarea().value; },
  // 新建一个可控发送：onSend 返回该 Promise，直到 resolveSend / rejectSend 才落定
  newSendControl() {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    window.__sendControl = { promise, resolve, reject };
  },
  async resolveSend(ok) {
    const control = window.__sendControl;
    window.__sendControl = null;
    await act(async () => {
      if (ok) control.resolve(true); else control.resolve(false);
      await control.promise;
    });
  },
  async rejectSend() {
    const control = window.__sendControl;
    window.__sendControl = null;
    await act(async () => {
      control.reject(new Error('network down'));
      await control.promise.catch(() => {});
    });
  },
  sentCount() { return (window.__sent ?? []).length; },
};`;

interface Fixture {
  render(): Promise<void>;
  setSession(id: string | null): Promise<void>;
  type(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  value(): string;
  newSendControl(): void;
  resolveSend(ok: boolean): Promise<void>;
  rejectSend(): Promise<void>;
  sentCount(): number;
}

function draftKey(sessionId: string | null): string {
  return `${DRAFT_KEY_PREFIX}${sessionId ?? 'new-task'}`;
}

function draftOf(dom: { window: { localStorage: Storage } }, sessionId: string | null): string {
  return dom.window.localStorage.getItem(draftKey(sessionId)) ?? '';
}

/** 模拟刷新：旧窗口的 localStorage 内容原样搬进新窗口（键稳定，内容不变）。 */
function snapshotStorage(dom: { window: { localStorage: Storage } }): [string, string][] {
  const entries: [string, string][] = [];
  for (let i = 0; i < dom.window.localStorage.length; i++) {
    const key = dom.window.localStorage.key(i) as string;
    entries.push([key, dom.window.localStorage.getItem(key) as string]);
  }
  return entries;
}

async function openRestoredDom(
  entries: [string, string][],
): Promise<Awaited<ReturnType<typeof createComponentDom>>> {
  return createComponentDom(HARNESS_SOURCE, {
    beforeEvaluate(window) {
      for (const [key, value] of entries) window.localStorage.setItem(key, value);
    },
  });
}

let dom: Awaited<ReturnType<typeof createComponentDom>> | null = null;

async function withDom(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  dom = await createComponentDom(HARNESS_SOURCE);
  try {
    await (Reflect.get(dom.window, 'fixture') as Fixture).render();
    await fn(Reflect.get(dom.window, 'fixture') as Fixture);
  } finally {
    dom.window.close();
    dom = null;
  }
}

console.log('── 场景 1：发送成功不误删等待期的新草稿 ──');
await withDom(async (f) => {
  await f.type('A 的消息');
  f.newSendControl();
  await f.pressEnter();
  assert.equal(f.sentCount(), 1);
  assert.equal(f.value(), '', '发送后输入框清空');
  // 等待结果期间输入新内容
  await f.type('等待期新草稿');
  await f.resolveSend(true);
  assert.equal(f.value(), '等待期新草稿', '成功后输入框保留新输入');
  assert.equal(draftOf(dom!, 'task-a'), '等待期新草稿', '成功只清已交付草稿，键里留下较新草稿');
  // 刷新后较新草稿仍应恢复
  const entries = snapshotStorage(dom!);
  const restored = await openRestoredDom(entries);
  try {
    await (Reflect.get(restored.window, 'fixture') as Fixture).render();
    assert.equal(
      (Reflect.get(restored.window, 'fixture') as Fixture).value(),
      '等待期新草稿',
      '刷新后恢复较新草稿',
    );
  } finally {
    restored.window.close();
  }
});

console.log('── 场景 2：发送失败不污染其他任务 ──');
await withDom(async (f) => {
  await f.type('A 的失败草稿');
  f.newSendControl();
  await f.pressEnter();
  // 等待期间切到任务 B，并在 B 里输入
  await f.setSession('task-b');
  assert.equal(f.value(), '', '切到 B 后不显示 A 的已发送文本');
  await f.type('B 的草稿');
  // A 的发送失败了
  await f.resolveSend(false);
  assert.equal(f.value(), 'B 的草稿', 'A 失败不进入 B 的输入框');
  assert.equal(draftOf(dom!, 'task-b'), 'B 的草稿', 'A 失败不写进 B 的存储');
  assert.equal(draftOf(dom!, 'task-a'), 'A 的失败草稿', 'A 的失败草稿留在 A 的键里');
  // 切回 A：失败草稿还原到输入框
  await f.setSession('task-a');
  assert.equal(f.value(), 'A 的失败草稿', '切回 A 恢复失败草稿');
  // B 再刷新：B 的草稿不受影响
  const entries = snapshotStorage(dom!);
  const restored = await openRestoredDom(entries);
  try {
    const f2 = Reflect.get(restored.window, 'fixture') as Fixture;
    await f2.render();
    await f2.setSession('task-b');
    assert.equal(f2.value(), 'B 的草稿', '刷新后 B 的草稿完好');
  } finally {
    restored.window.close();
  }
});

console.log('── 场景 3：发送等待期间刷新不丢草稿 ──');
{
  const pendingDom = await createComponentDom(HARNESS_SOURCE);
  let entries: [string, string][] = [];
  try {
    const f = Reflect.get(pendingDom.window, 'fixture') as Fixture;
    await f.render();
    await f.type('未确认的草稿');
    f.newSendControl();
    await f.pressEnter();
    assert.equal(f.value(), '', '发送后输入框清空');
    assert.equal(draftOf(pendingDom, 'task-a'), '未确认的草稿', '清空输入框不得提前删除持久化草稿');
    entries = snapshotStorage(pendingDom);
  } finally {
    pendingDom.window.close();
  }
  // 刷新（发送仍未确认）：草稿恢复可用
  const restored = await openRestoredDom(entries);
  try {
    const f2 = Reflect.get(restored.window, 'fixture') as Fixture;
    await f2.render();
    assert.equal(f2.value(), '未确认的草稿', '刷新后恢复可用草稿');
    // 恢复后可正常继续编辑并发送
    f2.newSendControl();
    await f2.type('未确认的草稿（续）');
    await f2.pressEnter();
    assert.equal(f2.sentCount(), 1);
    await f2.resolveSend(true);
    assert.equal(draftOf(restored, 'task-a'), '', '恢复后的草稿发送成功后正常清理');
  } finally {
    restored.window.close();
  }
}

console.log('── 正常成功：发送成功后清理对应草稿 ──');
await withDom(async (f) => {
  await f.type('正常成功草稿');
  f.newSendControl();
  await f.pressEnter();
  assert.equal(draftOf(dom!, 'task-a'), '正常成功草稿', '等待期间草稿仍在（可刷新恢复）');
  await f.resolveSend(true);
  assert.equal(f.value(), '');
  assert.equal(draftOf(dom!, 'task-a'), '', '成功后草稿键被清除');
});

console.log('── 正常失败：草稿保留并合并等待期新输入 ──');
await withDom(async (f) => {
  await f.type('原始草稿');
  f.newSendControl();
  await f.pressEnter();
  await f.type('期间新输入');
  await f.resolveSend(false);
  assert.equal(f.value(), '原始草稿\n期间新输入', '失败还原：旧草稿在前、新输入接后');
  assert.equal(draftOf(dom!, 'task-a'), '原始草稿\n期间新输入', '合并结果落盘，刷新可恢复');
});

console.log('── 正常失败（reject）：与 resolve(false) 同路径保留草稿 ──');
await withDom(async (f) => {
  await f.type('拒绝场景草稿');
  f.newSendControl();
  await f.pressEnter();
  await f.rejectSend();
  assert.equal(f.value(), '拒绝场景草稿', 'reject 还原原草稿');
  assert.equal(draftOf(dom!, 'task-a'), '拒绝场景草稿', 'reject 后草稿保留');
});

console.log('── 隔离：各任务与新建任务页草稿互不串用 ──');
await withDom(async (f) => {
  await f.type('任务 A 草稿');
  await f.setSession('task-b');
  assert.equal(f.value(), '', 'B 不显示 A 的草稿');
  await f.type('任务 B 草稿');
  await f.setSession(null);
  assert.equal(f.value(), '', '新建任务页不显示任务草稿');
  await f.type('新建任务草稿');
  assert.equal(draftOf(dom!, null), '新建任务草稿', '新建任务页独立作用域');
  assert.equal(draftOf(dom!, 'task-a'), '任务 A 草稿');
  assert.equal(draftOf(dom!, 'task-b'), '任务 B 草稿');
  await f.setSession('task-a');
  assert.equal(f.value(), '任务 A 草稿', '切回 A 恢复 A 的草稿');
  // A 发送成功只清 A，不动 B 与新建任务页
  f.newSendControl();
  await f.pressEnter();
  await f.resolveSend(true);
  assert.equal(draftOf(dom!, 'task-a'), '');
  assert.equal(draftOf(dom!, 'task-b'), '任务 B 草稿', 'A 成功不影响 B');
  assert.equal(draftOf(dom!, null), '新建任务草稿', 'A 成功不影响新建任务页');
});

console.log('── 降级：存储不可用时输入与发送照常 ──');
{
  const blocked = await createComponentDom(HARNESS_SOURCE, {
    beforeEvaluate(window) {
      // 访问 localStorage 本身即抛错（隐私模式等价物）
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked');
        },
        configurable: true,
      });
    },
  });
  try {
    const f = Reflect.get(blocked.window, 'fixture') as Fixture;
    await f.render();
    await f.type('无存储草稿');
    f.newSendControl();
    await f.pressEnter();
    assert.equal(f.sentCount(), 1, '存储不可用仍可发送');
    await f.resolveSend(true);
    assert.equal(f.value(), '', '发送照常清空输入框');
    await f.type('无存储继续输入');
    assert.equal(f.value(), '无存储继续输入', '发送后输入照常');
  } finally {
    blocked.window.close();
  }
}

console.log('\nFrontend composer-draft DOM tests: all scenarios PASS');
