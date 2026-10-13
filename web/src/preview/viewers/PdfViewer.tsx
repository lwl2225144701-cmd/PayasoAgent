// PdfViewer：pdfjs-dist canvas 渲染 —— 分页虚拟化（IntersectionObserver 只渲染
// 可视页 ±1）、缩放、页码跳转。worker 走 vite ?url 资产（与库同版本 6.3.289，
// 与 root optionalDeps 对齐）。渲染失败（含后端 413/404）转 FallbackViewer。
//
// 显示尺寸一律由 JS 算准后写成行内样式（容器宽度 → 适配缩放 → zoom），
// **不给 canvas 加 CSS max-width/height:auto**：行内高与 CSS 限宽冲突会把页面
// 横向挤压变形（历史 bug：385×870 显示 615×870 的 A4 页，中文字符糊成一团）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { PreviewApiError, previewFileUrl } from '../api';
import type { ViewerProps } from '../registry';
import type { PreviewErrorCode } from '../types';
import FallbackViewer from './FallbackViewer';
import styles from './PdfViewer.module.css';
import { computePageLayout, type PageSize } from './pdf-layout';

/** 懒加载 + worker 装配只做一次（模块级 Promise，多标签共享）。 */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [pdfjs, workerUrl] = await Promise.all([
        import('pdfjs-dist'),
        // vite ?url：worker 作为资产输出，只在 viewer chunk 加载后才被引用
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * PDFDocumentProxy 的结构化最小类型（本 viewer 只用这几个成员）。
 * 用手写结构类型而不是 import pdfjs 的具名类型导出——v6 的类型导出面
 * 在不同构建（legacy/esm）下不一致，结构契约更稳。
 */
interface PdfPageLike {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
}

interface PdfDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export default function PdfViewer({ path, name, runId }: ViewerProps) {
  const mountId = useMemo(() => Date.now().toString(36), []);
  const { t } = useI18n();
  // 每页的原始尺寸（pt）：布局与占位高度都按真实页面算，不假设 A4
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [failure, setFailure] = useState<{
    reason?: PreviewErrorCode;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // 滚动容器的可用宽度（扣除 padding）：zoom 的基准 = 适配这个宽度
  const [availWidth, setAvailWidth] = useState(0);

  // 文档实例与加载任务按 path 缓存（切标签再切回不重载）；
  // pdfjs v6 的 destroy() 在 loading task 上（PDFDocumentProxy 无此方法）
  const docRef = useRef<PdfDocLike | null>(null);
  const taskRef = useRef<{ destroy(): Promise<void> } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    setPageSizes([]);
    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const task = pdfjs.getDocument({ url: `${previewFileUrl(path, { runId })}&v=${mountId}` });
        taskRef.current = task;
        const doc = (await task.promise) as PdfDocLike;
        if (cancelled) {
          void task.destroy();
          return;
        }
        docRef.current = doc;
        // 取每页原始尺寸（只读 viewport，不渲染）：布局按真实页面算，
        // 混合方向/非 A4 的文档也不会错位
        const sizes: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const viewport = (await doc.getPage(i)).getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled) return;
        setPageSizes(sizes);
        setLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        setLoading(false);
        if (err instanceof PreviewApiError) {
          setFailure({ reason: err.code });
        } else {
          // pdfjs 的网络错误不经过我们的 fetch 封装：按 URL 再探一次拿到结构化错误码
          void probeError(path, runId, mountId).then((code) => setFailure({ reason: code }));
        }
      }
    })();
    return () => {
      cancelled = true;
      // 切标签/卸载：销毁加载任务与文档（worker 复用，只放本篇资源）
      const task = taskRef.current;
      taskRef.current = null;
      docRef.current = null;
      if (task) void task.destroy().catch(() => undefined);
    };
  }, [mountId, path, runId]);

  // 容器可用宽度：ResizeObserver 跟随（拖面板宽度 / 窗口变化 → 重新布局）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const cs = getComputedStyle(container);
      const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
      setAvailWidth(Math.max(0, container.clientWidth - padX));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // 布局：适配宽度 × zoom（纯计算在 pdf-layout.ts，可单测——历史上尺寸算不准
  // 会把页面压扁，回归测试守的就是"宽高同源、比例不变"）
  const layout = useMemo(
    () => computePageLayout(pageSizes, availWidth, zoom),
    [pageSizes, availWidth, zoom],
  );

  const numPages = pageSizes.length;

  // 可视页渲染：占位 div 进入视口才画 canvas（±1 页 overscan），布局变化全量重画
  useEffect(() => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container || layout.length === 0) return;

    observerRef.current?.disconnect();
    // 缩放/容器宽度变化后所有 canvas 的尺寸都作废：先清空，滚到再按新布局画
    for (const placeholder of container.querySelectorAll<HTMLElement>('[data-page]')) {
      placeholder.replaceChildren();
    }

    const rendered = new Set<number>();
    const pending = new Set<number>();

    const renderPage = async (pageNumber: number, placeholder: HTMLElement) => {
      if (pending.has(pageNumber) || rendered.has(pageNumber)) return;
      pending.add(pageNumber);
      try {
        const dims = layout[pageNumber - 1];
        const page = await doc.getPage(pageNumber);
        // 缓冲区 = 显示尺寸 × dpr（高分屏不糊）；显示尺寸由布局算准，不再变形
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: dims.scale * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${dims.width}px`;
        canvas.style.height = `${dims.height}px`;
        canvas.className = styles.pageCanvas;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        placeholder.replaceChildren(canvas);
        rendered.add(pageNumber);
      } catch {
        // 单页渲染失败不拖垮整篇：占位留空即可
      } finally {
        pending.delete(pageNumber);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          void renderPage(pageNumber, entry.target as HTMLElement);
        }
      },
      { root: container, rootMargin: '300px 0px' },
    );

    const placeholders = container.querySelectorAll<HTMLElement>('[data-page]');
    for (const placeholder of placeholders) observer.observe(placeholder);
    observerRef.current = observer;

    return () => {
      observer.disconnect();
    };
  }, [layout]);

  // 滚动同步当前页码（页码跳转框的展示值）
  useEffect(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;
    const onScroll = () => {
      const placeholders = container.querySelectorAll<HTMLElement>('[data-page]');
      for (const placeholder of placeholders) {
        const rect = placeholder.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) {
          setCurrentPage(Number(placeholder.dataset.page));
          break;
        }
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [numPages]);

  if (failure) {
    return <FallbackViewer path={path} name={name} reason={failure.reason} />;
  }

  const jumpTo = (pageNumber: number) => {
    const clamped = Math.min(Math.max(1, pageNumber), numPages);
    const target = containerRef.current?.querySelector<HTMLElement>(`[data-page="${clamped}"]`);
    target?.scrollIntoView({ block: 'start' });
    setCurrentPage(clamped);
  };

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() =>
            setZoom((z) => ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(z) - 1)] ?? ZOOM_STEPS[0])
          }
          title={t('preview.viewer.image.zoomOut')}
          aria-label={t('preview.viewer.image.zoomOut')}
        >
          −
        </button>
        <span className={styles.scaleLabel}>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className={styles.toolBtn}
          onClick={() =>
            setZoom(
              (z) =>
                ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(z) + 1)] ??
                ZOOM_STEPS[ZOOM_STEPS.length - 1],
            )
          }
          title={t('preview.viewer.image.zoomIn')}
          aria-label={t('preview.viewer.image.zoomIn')}
        >
          +
        </button>
        <span className={styles.pageNav}>
          <input
            className={styles.pageInput}
            type="number"
            min={1}
            max={numPages}
            value={currentPage}
            onChange={(event) => jumpTo(Number(event.target.value))}
            aria-label={t('preview.viewer.pdf.page')}
          />
          / {numPages || '–'}
        </span>
      </div>
      <div className={styles.pages} ref={containerRef}>
        {loading && <div className={styles.loading}>{t('preview.viewer.loading')}</div>}
        {layout.map((dims, i) => (
          // data-page 是虚拟渲染与页码跳转的锚点；尺寸由布局算准（行内），不用固定宽高比
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 页码是位置性身份（无重排），index 即页号
            key={i}
            className={styles.pagePlaceholder}
            data-page={i + 1}
            style={{ width: `${dims.width}px`, height: `${dims.height}px` }}
          />
        ))}
      </div>
    </div>
  );
}

/** pdfjs 的网络失败不经过我们的 fetch：用 HEAD 式 GET 探一次拿结构化错误码。 */
async function probeError(
  path: string,
  runId: string | null | undefined,
  mountId: string,
): Promise<PreviewErrorCode | undefined> {
  try {
    const resp = await fetch(`${previewFileUrl(path, { runId })}&v=${mountId}`, {
      cache: 'no-store',
    });
    if (resp.ok) return undefined;
    const payload = (await resp.json().catch(() => null)) as { error?: unknown } | null;
    const code = payload?.error;
    return typeof code === 'string' ? (code as PreviewErrorCode) : undefined;
  } catch {
    return undefined;
  }
}
