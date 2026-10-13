// 模块: Preview 前端单测 — registry 路由、相对图片重写、API 错误按码分叉。
// 用法: npx tsx tests/frontend-preview-registry.test.ts（无浏览器/无网络；fetch 打桩）

import assert from 'node:assert/strict';
import { MESSAGES } from '../web/src/i18n/messages/index';
import {
  fetchFileText,
  fetchTree,
  PreviewApiError,
  PreviewNetworkError,
  previewFileUrl,
} from '../web/src/preview/api';
import { PREVIEW_HOME_ACTIONS, shortcutLabel } from '../web/src/preview/dock-home';
import {
  addStartTab,
  browserTabLabel,
  closeDockTab,
  initialDockTabs,
  openFilesTab,
} from '../web/src/preview/dock-tabs';
import { previewQueryUrl } from '../web/src/preview/file-url';
import { fileIconName, resolveViewer } from '../web/src/preview/registry';
import {
  joinRelPath,
  rewriteRelativeImages,
  toPreviewFileUrl,
} from '../web/src/preview/rewrite-relative-images';
import { PREVIEW_ERROR_CODES } from '../web/src/preview/types';
import { computePageLayout } from '../web/src/preview/viewers/pdf-layout';
import { columnLabel, visibleRowRange } from '../web/src/preview/viewers/sheet-utils';

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- 面板首页（"开始"视图）----

test('面板首页只有"工作区文件"一张卡（终端 / 浏览器明确不做）', () => {
  assert.deepEqual(
    PREVIEW_HOME_ACTIONS.map((action) => action.id),
    ['workspace-files'],
  );
  const card = PREVIEW_HOME_ACTIONS[0];
  assert.equal(card.titleKey, 'preview.tree.root', '卡片标题与文件树根标签用同一个 key');
  assert.equal(card.descriptionKey, 'preview.dock.home.workspaceFiles.description');
});

test('面板首页卡片文案在消息表里双语齐备（防加了卡忘翻译）', () => {
  for (const action of PREVIEW_HOME_ACTIONS) {
    for (const key of [action.titleKey, action.descriptionKey]) {
      const entry = (MESSAGES as Record<string, Record<string, string>>)[key];
      assert.ok(entry, `消息表缺 ${key}`);
      assert.ok(entry['zh-CN']?.trim(), `${key} 缺 zh-CN`);
      assert.ok(entry['en-US']?.trim(), `${key} 缺 en-US`);
    }
  }
});

test('面板首页快捷键提示：mac 显示 ⌘P，其它平台显示 Ctrl P', () => {
  assert.equal(shortcutLabel(true), '⌘ P');
  assert.equal(shortcutLabel(false), 'Ctrl P');
});

// ---- 面板停靠标签（"开始"/"文件"；三步交互序列见 dock-tabs.ts 头注）----

test('初始为空标签集（面板打开 = 首页占位，strip 只有"开始"入口）', () => {
  assert.deepEqual(initialDockTabs(), { tabs: [], activeId: null });
});

test('点"工作区文件"卡片：空态 → 新建"文件"标签并激活', () => {
  const next = openFilesTab(initialDockTabs());
  assert.deepEqual(next, { tabs: [{ id: 1, kind: 'browser' }], activeId: 1 });
});

test('点"工作区文件"卡片：激活的"开始"标签转成"文件"标签（strip 上"开始"消失）', () => {
  // ＋ → [开始 1]；点卡片 → 同一个 id 转成 browser（不是追加）
  const withStart = addStartTab(initialDockTabs());
  assert.deepEqual(withStart, { tabs: [{ id: 1, kind: 'home' }], activeId: 1 });
  assert.deepEqual(openFilesTab(withStart), { tabs: [{ id: 1, kind: 'browser' }], activeId: 1 });
});

test('点"工作区文件"卡片：激活的已是"文件"标签 → 追加一棵新目录树', () => {
  const files = openFilesTab(initialDockTabs());
  assert.deepEqual(openFilesTab(files), {
    tabs: [
      { id: 1, kind: 'browser' },
      { id: 2, kind: 'browser' },
    ],
    activeId: 2,
  });
});

test('＋：新建"开始"标签并激活（新标签默认落在开始页）', () => {
  const files = openFilesTab(initialDockTabs()); // [文件 1]
  const withStart = addStartTab(files);
  assert.deepEqual(withStart, {
    tabs: [
      { id: 1, kind: 'browser' },
      { id: 2, kind: 'home' },
    ],
    activeId: 2,
  });
  // id 单调递增，不复用已关闭的
  assert.deepEqual(
    addStartTab(withStart).tabs.map((tab) => tab.id),
    [1, 2, 3],
  );
});

test('关闭标签：关激活的迁移到右邻/左邻，关到最后一个回空集（首页占位）', () => {
  const three = {
    tabs: [
      { id: 1, kind: 'browser' as const },
      { id: 2, kind: 'home' as const },
      { id: 3, kind: 'browser' as const },
    ],
    activeId: 2,
  };
  // 关激活的 2 → 右邻 3
  assert.deepEqual(closeDockTab(three, 2), {
    tabs: [
      { id: 1, kind: 'browser' },
      { id: 3, kind: 'browser' },
    ],
    activeId: 3,
  });
  // 关最后一个（3）→ 左邻 1
  assert.deepEqual(closeDockTab({ tabs: [three.tabs[0], three.tabs[2]], activeId: 3 }, 3), {
    tabs: [{ id: 1, kind: 'browser' }],
    activeId: 1,
  });
  // 关非激活标签 → 激活不变
  assert.deepEqual(closeDockTab(three, 1), { tabs: [three.tabs[1], three.tabs[2]], activeId: 2 });
  // 关掉最后一个 → 空集（组件回落到首页占位）
  assert.deepEqual(closeDockTab({ tabs: [{ id: 1, kind: 'home' }], activeId: 1 }, 1), {
    tabs: [],
    activeId: null,
  });
  // 关不存在的 id → 原样返回
  assert.deepEqual(closeDockTab(three, 99), three);
});

test('文件标签命名：按"文件"标签的序位（首个「文件」，之后「文件 2」「文件 3」）', () => {
  assert.deepEqual(browserTabLabel(0), { key: 'preview.dock.filesTab' });
  assert.deepEqual(browserTabLabel(1), { key: 'preview.dock.filesTabN', n: 2 });
  assert.deepEqual(browserTabLabel(2), { key: 'preview.dock.filesTabN', n: 3 });
});

// ---- 会话作用域（runId）----

test('runId 作用域：直链与查询串都带上 runId（缺省不带）', () => {
  assert.equal(previewFileUrl('a/b.md'), '/preview/file?path=a/b.md');
  assert.equal(previewFileUrl('a/b.md', { runId: 'r1' }), '/preview/file?path=a/b.md&runId=r1');
  assert.equal(
    previewFileUrl('a/b.md', { runId: null }),
    '/preview/file?path=a/b.md',
    'runId 为 null 时不得写出空参数',
  );
  assert.equal(
    previewQueryUrl('tree', '', { includeIgnored: 'false' }, { runId: 'r1' }),
    '/preview/tree?path=&includeIgnored=false&runId=r1',
  );
});

test('runId 作用域：Markdown 相对图片直链继承同一 runId', () => {
  const md = '![图](./img/a.png)';
  assert.equal(
    rewriteRelativeImages(md, 'docs', { runId: 'r1' }),
    '![图](/preview/file?path=docs/img/a.png&runId=r1)',
  );
  // 非相对 URL 依旧原样（作用域不影响这层判断）
  assert.equal(
    rewriteRelativeImages('![x](https://e.com/a.png)', 'docs', { runId: 'r1' }),
    '![x](https://e.com/a.png)',
  );
});

// ---- registry ----

test('registry 按扩展名路由（M3：五类文档均有正式 viewer，文本兜底）', () => {
  assert.equal(resolveViewer('a.md')?.kind, 'text');
  assert.equal(resolveViewer('a.markdown')?.kind, 'text');
  assert.equal(resolveViewer('a.mdx')?.kind, 'text');
  assert.equal(resolveViewer('img.png')?.kind, 'image');
  assert.equal(resolveViewer('img.JPG')?.kind, 'image'); // 大小写不敏感
  assert.equal(resolveViewer('a.pdf')?.kind, 'pdf');
  assert.equal(resolveViewer('a.docx')?.kind, 'office');
  assert.equal(resolveViewer('a.xlsx')?.kind, 'office');
  assert.equal(resolveViewer('a.csv')?.kind, 'office');
  // 文本兜底：未知扩展名与无扩展名都落 text
  assert.equal(resolveViewer('a.txt')?.kind, 'text');
  assert.equal(resolveViewer('Makefile')?.kind, 'text');
  assert.equal(resolveViewer('a.zip')?.kind, 'text'); // 后端 415 → TextViewer 错误态转兜底
});

test('fileIconName 覆盖六类', () => {
  assert.equal(fileIconName('a.md'), 'markdown');
  assert.equal(fileIconName('a.png'), 'image');
  assert.equal(fileIconName('a.pdf'), 'pdf');
  assert.equal(fileIconName('a.docx'), 'docx');
  assert.equal(fileIconName('a.xlsx'), 'sheet');
  assert.equal(fileIconName('a.txt'), 'file');
});

// ---- 相对图片重写 ----

test('相对图片重写为 /preview/file 直链', () => {
  const out = rewriteRelativeImages('![图](./img/a.png)', 'docs');
  assert.equal(out, '![图](/preview/file?path=docs/img/a.png)');
});

test('相对图片：根级文档 + 无 ./ 前缀', () => {
  assert.equal(rewriteRelativeImages('![x](a.png)', ''), '![x](/preview/file?path=a.png)');
});

test('相对图片：../ 上跳后仍在工作区内', () => {
  assert.equal(rewriteRelativeImages('![x](../b.png)', 'docs'), '![x](/preview/file?path=b.png)');
});

test('非相对 URL 原样保留（http/https/data/锚点/协议相对/绝对路径）', () => {
  const cases = [
    '![a](https://example.com/a.png)',
    '![a](http://example.com/a.png)',
    '![a](data:image/png;base64,AAAA)',
    '![a](#anchor)',
    '![a](//cdn.example.com/a.png)',
    '![a](/abs/a.png)',
    '![a](<https://example.com/a b.png>)',
  ];
  for (const input of cases) {
    assert.equal(rewriteRelativeImages(input, 'docs'), input, input);
  }
});

test('带 title 的图片语法保留 title', () => {
  const out = rewriteRelativeImages('![a](a.png "标题")', 'docs');
  assert.equal(out, '![a](/preview/file?path=docs/a.png "标题")');
});

test('多个图片与普通链接混排：只重写图片，链接不动', () => {
  const input = '[链接](https://e.com) 和 ![1](a.png) 文本 ![2](b.png)';
  const out = rewriteRelativeImages(input, 'd');
  assert.equal(
    out,
    '[链接](https://e.com) 和 ![1](/preview/file?path=d/a.png) 文本 ![2](/preview/file?path=d/b.png)',
  );
});

test('joinRelPath / toPreviewFileUrl 纯函数', () => {
  assert.equal(joinRelPath('a/b', './c.png'), 'a/b/c.png');
  assert.equal(joinRelPath('a/b', '../c.png'), 'a/c.png');
  assert.equal(joinRelPath('', 'c.png'), 'c.png');
  // 统一编码规则：逐段 %20、段间裸 /
  assert.equal(toPreviewFileUrl('a b', 'c d.png'), '/preview/file?path=a%20b/c%20d.png');
});

// ---- API 错误按码分叉 ----

interface StubResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  headers: { get: (name: string) => string | null };
}

function stubFetch(response: StubResponse | ((url: string) => StubResponse)): void {
  globalThis.fetch = ((input: string) => {
    const url = typeof input === 'string' ? input : String(input);
    const resp = typeof response === 'function' ? response(url) : response;
    return Promise.resolve(resp) as unknown as Promise<Response>;
  }) as unknown as typeof fetch;
}

test('fetchFileText：未知错误码 → PreviewNetworkError（不伪装成已知 code）', async () => {
  stubFetch({
    ok: false,
    status: 413,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'too_large', limit: 2097152 }),
  });
  await assert.rejects(
    () => fetchFileText('big.docx'),
    (err: unknown) => {
      assert.ok(err instanceof PreviewNetworkError);
      assert.equal(err.status, 413);
      return true;
    },
  );
});

test('fetchFileText：415 unsupported → PreviewApiError', async () => {
  stubFetch({
    ok: false,
    status: 415,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'unsupported' }),
  });
  await assert.rejects(
    () => fetchFileText('a.zip'),
    (err: unknown) => err instanceof PreviewApiError && err.code === 'unsupported',
  );
});

test('fetchFileText：403 outside_workspace（symlink 逃逸）', async () => {
  stubFetch({
    ok: false,
    status: 403,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'outside_workspace' }),
  });
  await assert.rejects(
    () => fetchFileText('link-out/secret.txt'),
    (err: unknown) => err instanceof PreviewApiError && err.code === 'outside_workspace',
  );
});

test('非契约错误体 → PreviewNetworkError（不伪装成 code）', async () => {
  stubFetch({
    ok: false,
    status: 500,
    headers: { get: () => 'text/plain' },
    text: async () => 'internal error',
  });
  await assert.rejects(
    () => fetchFileText('a.txt'),
    (err: unknown) => err instanceof PreviewNetworkError && err.status === 500,
  );
});

test('fetchTree：200 解析列表；URL 带 includeIgnored', async () => {
  let requestedUrl = '';
  stubFetch((url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ path: '', parent: null, entries: [], truncated: false }),
    };
  });
  const listing = await fetchTree('', true);
  assert.equal(listing.truncated, false);
  assert.match(requestedUrl, /^\/preview\/tree\?path=&includeIgnored=true$/);
});

test('previewFileUrl：路径逐段编码', () => {
  assert.equal(previewFileUrl('a b/c.png'), '/preview/file?path=a%20b/c.png');
});

test('错误码集合与后端一致（6 个；预览无大小上限，too_large 已摘除）', () => {
  assert.deepEqual(
    [...PREVIEW_ERROR_CODES],
    [
      'invalid_path',
      'outside_workspace',
      'not_found',
      'unsupported',
      'permission_denied',
      'no_workspace',
    ],
  );
});

// ---- SheetViewer 纯函数（M3）----

test('visibleRowRange：窗口 + overscan 边界', () => {
  // 行高 28、视口 600 → 可见 22 行（ceil(600/28)）；overscan 10
  assert.deepEqual(visibleRowRange(0, 600, 1000), { start: 0, end: 32 }); // 顶部钳制
  assert.deepEqual(visibleRowRange(2800, 600, 1000), { start: 90, end: 132 }); // 中部
  assert.deepEqual(visibleRowRange(28000, 600, 1000), { start: 990, end: 999 }); // 底部钳制
  assert.deepEqual(visibleRowRange(0, 600, 0), { start: 0, end: -1 }); // 空表
});

test('columnLabel：A-Z / AA 起', () => {
  assert.equal(columnLabel(0), 'A');
  assert.equal(columnLabel(25), 'Z');
  assert.equal(columnLabel(26), 'AA');
  assert.equal(columnLabel(51), 'AZ');
  assert.equal(columnLabel(52), 'BA');
});

// ---- PdfViewer 布局（回归：canvas 曾因行内高 vs CSS max-width 被横向压扁）----

const A4 = { width: 615, height: 870 };

test('PDF 布局：空输入 / 零可用宽度 → 空布局', () => {
  assert.deepEqual(computePageLayout([], 387, 1), []);
  assert.deepEqual(computePageLayout([A4], 0, 1), []);
});

test('PDF 布局：zoom=1 铺满容器，且宽高同源（比例恒等于页面原始比例）', () => {
  const [page] = computePageLayout([A4], 387, 1);
  assert.equal(page.width, 387);
  // 核心回归断言：显示比例必须等于原始比例 615/870 ≈ 0.707。
  // 曾经的 bug 是宽度被 CSS 压到 385、行内高仍是 870 → 比例 0.443，页面被压扁。
  assert.ok(Math.abs(page.width / page.height - A4.width / A4.height) < 1e-9);
  // scale × 原始尺寸 = 显示尺寸（渲染与显示自洽，只有一个缩放来源）
  assert.ok(Math.abs(page.scale * A4.width - page.width) < 1e-9);
  assert.ok(Math.abs(page.scale * A4.height - page.height) < 1e-9);
});

test('PDF 布局：zoom 相对适配宽度等比缩放（200% → 宽高翻倍，比例不变）', () => {
  const [page] = computePageLayout([A4], 387, 2);
  assert.equal(page.width, 774);
  assert.ok(Math.abs(page.height - 774 * (A4.height / A4.width)) < 1e-9);
  assert.ok(Math.abs(page.width / page.height - A4.width / A4.height) < 1e-9);
});

test('PDF 布局：混合页面尺寸各自适配（不假设 A4）', () => {
  const layout = computePageLayout([A4, { width: 870, height: 615 }], 400, 1);
  assert.equal(layout.length, 2);
  for (const [i, page] of layout.entries()) {
    const size = i === 0 ? A4 : { width: 870, height: 615 };
    assert.equal(page.width, 400, '都铺满容器宽度');
    assert.ok(Math.abs(page.width / page.height - size.width / size.height) < 1e-9);
  }
});

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  try {
    for (const item of tests) {
      try {
        await item.fn();
        passed++;
        console.log(`  PASS  ${item.name}`);
      } catch (err) {
        failed++;
        console.error(`  FAIL  ${item.name}`);
        console.error(`        ${(err as Error).message}`);
      }
    }
  } finally {
    // 还原 fetch，避免污染同进程后续用例
    delete (globalThis as { fetch?: unknown }).fetch;
  }
  console.log(`\nfrontend-preview-registry 测试完成：${passed} 通过 / ${failed} 失败`);
  if (failed) process.exitCode = 1;
}

void main();
