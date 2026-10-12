// SheetViewer 纯函数（无 CSS/无 React）：行虚拟化窗口与列标计算。
// 独立模块是为了让 tests/frontend-preview-registry.test.ts 能在 node 下
// 直接引用——组件文件 import 了 .module.css，node/tsx 加载不了。

export const ROW_HEIGHT = 28;
export const OVERSCAN = 10;

/** 滚动窗口 → 可见行区间 [start, end]（闭区间）。 */
export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
  overscan = OVERSCAN,
): { start: number; end: number } {
  if (totalRows <= 0) return { start: 0, end: -1 };
  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
  const start = Math.max(0, first - overscan);
  const end = Math.min(totalRows - 1, first + visibleCount + overscan);
  return { start, end };
}

/** 0 → A, 25 → Z, 26 → AA（电子表格列标）。 */
export function columnLabel(index: number): string {
  let label = '';
  let n = index;
  for (;;) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return label;
}
