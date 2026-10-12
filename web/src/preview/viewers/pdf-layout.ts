// PDF 单页布局的纯计算（PdfViewer 消费）。
//
// 为什么单独一个模块：显示尺寸算不准会直接把页面压扁（历史 bug —— canvas 行内高
// 与 CSS max-width 冲突，A4 页被显示成 385×870，横向挤压 37%，中文字符糊成一团）。
// 布局规则必须能脱离 React/CSS 单测（tests/frontend-preview-registry.test.ts）。

/** 单页布局：显示尺寸（CSS px）+ 渲染缩放（相对页面原始尺寸，供 getViewport 用）。 */
export interface PageLayout {
  width: number;
  height: number;
  scale: number;
}

/** 页面原始尺寸（pt，scale=1 的 viewport）。 */
export interface PageSize {
  width: number;
  height: number;
}

/**
 * 计算每页的显示布局：以「适配容器宽度」为基准，再乘 zoom。
 *
 * - zoom = 1 → 铺满容器宽度（窄面板里 100% 就能看全，与常见 PDF 查看器一致）；
 * - zoom > 1 → 超出容器宽度，由滚动容器出横向滚动条；
 * - **宽高永远同源**（都从同一个 scale 推出），显示比例恒等于页面原始比例——
 *   这是不变形的根本保证，任何情况下都不得引入第二个缩放来源（如 CSS max-width）。
 */
export function computePageLayout(
  pageSizes: readonly PageSize[],
  availWidth: number,
  zoom: number,
): PageLayout[] {
  if (pageSizes.length === 0 || availWidth <= 0 || zoom <= 0) return [];
  return pageSizes.map((size) => {
    const scale = (availWidth / size.width) * zoom;
    return { width: size.width * scale, height: size.height * scale, scale };
  });
}
