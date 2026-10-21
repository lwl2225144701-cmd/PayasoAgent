// 通用 React 组件执行环境：使用项目真实依赖，支持 TSX/CSS 导入和异步生命周期。
// DOM 隔离用于测试状态；不承担安全沙箱、布局或真实浏览器兼容性验证。
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { build } from 'esbuild';
import { type DOMWindow, JSDOM } from 'jsdom';

export async function createComponentDom(
  source: string,
  options: { beforeEvaluate?: (window: DOMWindow) => void } = {},
): Promise<JSDOM> {
  const result = await build({
    stdin: {
      contents: source,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../../web/src/', import.meta.url)),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.css': 'empty', '.module.css': 'empty' },
    logLevel: 'silent',
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  // React act 的浏览器调度需要 MessageChannel；jsdom 未提供，使用 Node 的真实实现。
  const channels: MessageChannel[] = [];
  Reflect.set(
    dom.window,
    'MessageChannel',
    class extends MessageChannel {
      constructor() {
        super();
        channels.push(this);
      }
    },
  );
  const close = dom.window.close.bind(dom.window);
  dom.window.close = () => {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    close();
  };
  try {
    Reflect.set(dom.window, 'IS_REACT_ACT_ENVIRONMENT', true);
    options.beforeEvaluate?.(dom.window);
    dom.window.eval(result.outputFiles[0].text);
    return dom;
  } catch (error) {
    dom.window.close();
    throw error;
  }
}
