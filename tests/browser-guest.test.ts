// 原生访客页策略 + 首次导航生命周期；不启动 Electron 或请求外部网络。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  BROWSER_PARTITION,
  installBrowserGuestSecurity,
} from '../apps/desktop/src/browser-guest-security.js';
import { createComponentDom } from './helpers/component-dom.js';

const host = new EventEmitter();
type PolicySession = Parameters<typeof installBrowserGuestSecurity>[1];
let checkPermission: NonNullable<Parameters<PolicySession['setPermissionCheckHandler']>[0]>;
let requestPermission: NonNullable<Parameters<PolicySession['setPermissionRequestHandler']>[0]>;
installBrowserGuestSecurity(host as unknown as Parameters<typeof installBrowserGuestSecurity>[0], {
  setPermissionCheckHandler(handler) {
    assert.ok(handler);
    checkPermission = handler;
  },
  setPermissionRequestHandler(handler) {
    assert.ok(handler);
    requestPermission = handler;
  },
});

function cancellable() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

for (const src of ['file:///tmp/secret', 'javascript:alert(1)', 'data:text/html,hi', 'invalid']) {
  const event = cancellable();
  host.emit('will-attach-webview', event, {}, { partition: BROWSER_PARTITION, src });
  assert.equal(event.prevented, true, `拒绝初始地址 ${src}`);
}
const wrongPartition = cancellable();
host.emit('will-attach-webview', wrongPartition, {}, { partition: '', src: 'https://example.com' });
assert.equal(wrongPartition.prevented, true);
const preferences: Record<string, unknown> = {
  preload: '/tmp/preload.js',
  nodeIntegration: true,
  contextIsolation: false,
  sandbox: false,
  webSecurity: false,
  allowRunningInsecureContent: true,
};
const allowed = cancellable();
host.emit('will-attach-webview', allowed, preferences, {
  partition: BROWSER_PARTITION,
  src: 'http://localhost:5173',
});
assert.equal(allowed.prevented, false);
assert.equal(preferences.preload, undefined);
for (const key of [
  'nodeIntegration',
  'nodeIntegrationInSubFrames',
  'nodeIntegrationInWorker',
  'allowRunningInsecureContent',
  'webviewTag',
]) {
  assert.equal(preferences[key], false, key);
}
for (const key of ['contextIsolation', 'sandbox', 'webSecurity'])
  assert.equal(preferences[key], true);

const guest = new EventEmitter();
let openWindow: (() => { action: string }) | undefined;
Object.assign(guest, {
  setWindowOpenHandler(handler: () => { action: string }) {
    openWindow = handler;
  },
});
host.emit('did-attach-webview', {}, guest);
for (const name of ['will-navigate', 'will-redirect']) {
  for (const [url, blocked] of [
    ['https://example.com/next', false],
    ['http://localhost:8080', false],
    ['file:///etc/passwd', true],
    ['custom://open', true],
  ] as const) {
    const event = cancellable();
    guest.emit(name, event, url);
    assert.equal(event.prevented, blocked, `${name}: ${url}`);
  }
}
assert.equal(openWindow?.().action, 'deny');
assert.equal(
  checkPermission!(null, 'notifications', 'https://example.com', { isMainFrame: true }),
  false,
);
let permissionResult: boolean | undefined;
requestPermission!(
  guest as Parameters<typeof requestPermission>[0],
  'media',
  (value) => {
    permissionResult = value;
  },
  { isMainFrame: true, requestingUrl: 'https://example.com' },
);
assert.equal(permissionResult, false);

const source = `
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {WebBrowser} from './preview/WebBrowser';
const root = createRoot(document.getElementById('root'));
window.fixture = {
  async render() {await act(async () => root.render(<WebBrowser/>));},
  async open(url) {await act(async () => {
    const input = document.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, url);
    input.dispatchEvent(new Event('input', {bubbles:true}));
  }); await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true})));},
  async emit(name, fields = {}) {await act(async () => document.querySelector('webview').dispatchEvent(Object.assign(new Event(name), fields)));},
  async unmount() {await act(async () => root.unmount());}
};`;

const dom = await createComponentDom(source, {
  beforeEvaluate(window) {
    // Electron 的方法在 dom-ready 前不可调用；用会抛错的替身复现旧版首开路径。
    const create = window.document.createElement.bind(window.document);
    window.document.createElement = ((tag: string, options?: ElementCreationOptions) => {
      const el = create(tag, options);
      if (tag === 'webview')
        Object.assign(el, {
          loadURL() {
            throw new Error('webview 尚未 dom-ready');
          },
          getURL: () => 'https://example.com/inside',
          canGoBack: () => true,
          canGoForward: () => false,
        });
      return el;
    }) as typeof window.document.createElement;
  },
});
const fixture = Reflect.get(dom.window, 'fixture') as {
  render(): Promise<void>;
  open(url: string): Promise<void>;
  emit(name: string, fields?: object): Promise<void>;
  unmount(): Promise<void>;
};
try {
  await fixture.render();
  await fixture.open('example.com');
  const webview = dom.window.document.querySelector('webview');
  assert.ok(webview);
  assert.equal(webview.getAttribute('src'), 'https://example.com/');
  await fixture.emit('dom-ready');
  assert.equal(dom.window.document.querySelector('input')?.value, 'https://example.com/inside');
  assert.equal(webview.getAttribute('src'), 'https://example.com/', '页内导航不得被旧地址重置');
  await fixture.emit('did-fail-load', { errorCode: -105, isMainFrame: true });
  assert.match(dom.window.document.body.textContent ?? '', /网页加载失败/);
  await fixture.emit('did-start-loading');
  assert.doesNotMatch(dom.window.document.body.textContent ?? '', /网页加载失败/);
  await fixture.emit('did-fail-load', { errorCode: -3, isMainFrame: true });
  assert.doesNotMatch(dom.window.document.body.textContent ?? '', /网页加载失败/);
  await fixture.open('https://example.com/next');
  assert.equal(webview.getAttribute('src'), 'https://example.com/next');
  assert.equal(dom.window.document.querySelector('webview'), webview, '保留同一访客页及其导航历史');
  await fixture.unmount();
} finally {
  dom.window.close();
}
console.log('Browser guest: native URL/redirect/permission isolation and first navigation PASS');
