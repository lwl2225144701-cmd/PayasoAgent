// PdfViewer：pdfjs-dist canvas 渲染 —— 分页虚拟化（IntersectionObserver 只渲染
// 可视页 ±1）、缩放、页码跳转。worker 走 vite ?url 资产（与库同版本 6.3.289，
// 与 root optionalDeps 对齐）。渲染失败（含后端 413/404）转 FallbackViewer。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { PreviewApiError, previewFileUrl } from '../api';
import type { ViewerProps } from '../registry';
import type { PreviewErrorCode } from '../types';
import FallbackViewer from './FallbackViewer';
import styles from './PdfViewer.module.css';

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
    transform?: number[];
  }): { promise: Promise<void> };
}

interface PdfDocLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export default function PdfViewer({ path, name, runId }: ViewerProps) {
  const mountId = useMemo(() => Date.now().toString(36), []);
  const { t } = useI18n();
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [failure, setFailure] = useState<{
    reason?: PreviewErrorCode;
    detail?: { limit?: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);

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
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        setLoading(false);
        if (err instanceof PreviewApiError) {
          setFailure({ reason: err.code, detail: err.detail });
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

  // 可视页渲染：占位 div 进入视口才画 canvas（±1 页 overscan），缩放变化全量重画
  useEffect(() => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container || numPages === 0) return;

    observerRef.current?.disconnect();
    const rendered = new Map<number, HTMLCanvasElement>();
    const pending = new Set<number>();

    const renderPage = async (pageNumber: number, placeholder: HTMLElement) => {
      if (pending.has(pageNumber) || rendered.has(pageNumber)) return;
      pending.add(pageNumber);
      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: zoom });
        const canvas = document.createElement('canvas');
        // devicePixelRatio 让文字在高分屏不糊
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.className = styles.pageCanvas;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        placeholder.replaceChildren(canvas);
        rendered.set(pageNumber, canvas);
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
      rendered.clear();
    };
  }, [numPages, zoom]);

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
    return (
      <FallbackViewer path={path} name={name} reason={failure.reason} detail={failure.detail} />
    );
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
        {!loading &&
          Array.from({ length: numPages }, (_, i) => (
            // data-page 是虚拟渲染与页码跳转的锚点；scale 由 CSS 变量驱动占位高度
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 页码是位置性身份（无重排），index 即页号
              key={i}
              className={styles.pagePlaceholder}
              data-page={i + 1}
              style={{ aspectRatio: `${A4_RATIO}` }}
            />
          ))}
      </div>
    </div>
  );
}

/** A4 竖版近似宽高比：占位撑高度，避免渲染前滚动条跳动。 */
const A4_RATIO = '210 / 297';

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
