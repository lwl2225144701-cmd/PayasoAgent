/**
 * 全局 portal 容器。
 *
 * ⚠️ **不要 portal 到 `document.body`**。`index.css` 有一条全局规则把 `<body>` 的直接
 * 子元素默认全部隐藏，只白名单了 `#root` 与该容器：
 *
 *   body > :not(#root):not(#payaso-portal-root):not(script):not(...) { display: none !important }
 *
 * 挂到 body 上的节点会被静默 `display: none` —— 渲染成功、DOM 里也在，但用户看不见，
 * 表现为「点了没反应」。这类问题在代码里看不出、控制台也不报错，所以统一走这里。
 *
 * 容器由 `index.html` 提供；`document.body` 只是容器缺失时的兜底（例如单测环境）。
 */
const PORTAL_ROOT_ID = 'payaso-portal-root';

export function portalRoot(): HTMLElement {
  return document.getElementById(PORTAL_ROOT_ID) ?? document.body;
}

export { PORTAL_ROOT_ID };
