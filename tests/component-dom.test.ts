// 通用组件测试入口回归：真实 React 事件、Effect、异步状态及环境隔离。
import assert from 'node:assert/strict';
import { createComponentDom } from './helpers/component-dom.js';

const source = `
import React, {act, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
const root = createRoot(document.getElementById('root'));
function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {localStorage.setItem('count', String(count));}, [count]);
  return <button onClick={() => Promise.resolve().then(() => setCount(c => c + 1))}>{count}</button>;
}
window.fixture = {
  async render() {await act(async () => root.render(<Counter/>));},
  async click() {await act(async () => document.querySelector('button').click());},
  async unmount() {await act(async () => root.unmount());}
};`;

const dom = await createComponentDom(source);
try {
  const fixture = Reflect.get(dom.window, 'fixture') as {
    render(): Promise<void>;
    click(): Promise<void>;
    unmount(): Promise<void>;
  };
  await fixture.render();
  assert.equal(dom.window.document.querySelector('button')?.textContent, '0');
  await fixture.click();
  assert.equal(dom.window.document.querySelector('button')?.textContent, '1');
  assert.equal(dom.window.localStorage.getItem('count'), '1');
  await fixture.unmount();
  assert.equal(dom.window.document.getElementById('root')?.childElementCount, 0);
  const second = await createComponentDom('window.started = true;');
  try {
    assert.equal(second.window.localStorage.getItem('count'), null);
    assert.equal(Reflect.get(second.window, 'started'), true);
  } finally {
    second.window.close();
  }
  await assert.rejects(createComponentDom('throw new Error("fixture failed");'), /fixture failed/);
} finally {
  dom.window.close();
}
console.log('Component DOM: real React event/effect/async state and isolation PASS');
