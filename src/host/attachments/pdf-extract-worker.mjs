// PDF 提取隔离 Worker（Host 侧）。
// 为什么需要它：pdfjs 的解析是占满事件循环的长同步块——实测一个 1 页 PDF 的
// getDocument 就能让主线程 390ms 内完全不轮转定时器，Promise.race + setTimeout
// 在那种 starvation 下根本抢不到发射机会，竞速超时是心理安慰。放进 worker 后：
//   1. Host 事件循环不再被解析冻结（其余会话/请求照常响应）；
//   2. 超时后可 terminate() 硬取消（主线程侧见 pdf.ts 的 extractPdfjsText）。
// 由 scripts/copy-runtime.mjs 复制进 dist，与编译产物同目录。
import { parentPort, workerData } from 'node:worker_threads';

const post = (message) => parentPort?.postMessage(message);

const main = async () => {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    return {
      ok: false,
      error: '未安装 pdfjs-dist（可选依赖），无法提取中文/复杂 PDF；请运行 npm install pdfjs-dist 后重试',
    };
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(workerData),
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out += `${content.items.map((item) => ('str' in item ? item.str : '')).join(' ')}\n`;
  }
  return { ok: true, text: out };
};

main().then(post, (err) =>
  post({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);