// SheetViewer：SheetJS 读 .xlsx/.xls/.csv/.tsv → 多 sheet 标签 + 表格。
// 大表行虚拟化：固定行高 + 滚动窗口（只渲染可视区 ± overscan），
// 纯函数 visibleRowRange / columnLabel 在 sheet-utils.ts（被单测覆盖）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { fetchFileBytes, PreviewApiError } from '../api';
import type { ViewerProps } from '../registry';
import type { PreviewErrorCode } from '../types';
import FallbackViewer from './FallbackViewer';
import styles from './SheetViewer.module.css';
import { columnLabel, ROW_HEIGHT, visibleRowRange } from './sheet-utils';

interface SheetData {
  name: string;
  rows: string[][];
}

async function readWorkbook(path: string, runId?: string | null): Promise<SheetData[]> {
  const XLSX = await import('xlsx');
  const { buffer } = await fetchFileBytes(path, { runId });
  const workbook = XLSX.read(buffer, { type: 'array' });
  return workbook.SheetNames.map((name) => ({
    name,
    // header:1 → 二维数组；raw:false → 数字/日期按显示格式取值；defval 补空洞
    rows: XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
    }),
  }));
}

export default function SheetViewer({ path, name, runId }: ViewerProps) {
  const { t } = useI18n();
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [failure, setFailure] = useState<{
    reason?: PreviewErrorCode;
  } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setFailure(null);
    readWorkbook(path, runId)
      .then((data) => {
        if (!cancelled) {
          setSheets(data);
          setActiveSheet(0);
          setScrollTop(0);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof PreviewApiError) {
          setFailure({ reason: err.code });
        } else {
          setFailure({ reason: 'unsupported' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, runId]);

  // 视口高度跟随容器尺寸（ResizeObserver）。sheets 兼作"数据到达后重新测量"的
  // 触发器——表格加载前 scroll 容器尚未渲染（提前 return 的是 loading 态）。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !sheets) return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, [sheets]);

  const current = sheets?.[activeSheet] ?? null;
  const range = useMemo(
    () =>
      current
        ? visibleRowRange(scrollTop, viewportHeight, current.rows.length)
        : { start: 0, end: -1 },
    [current, scrollTop, viewportHeight],
  );

  if (failure) {
    return <FallbackViewer path={path} name={name} reason={failure.reason} />;
  }
  if (!sheets) {
    return <div className={styles.loading}>{t('preview.viewer.loading')}</div>;
  }

  const rows = current?.rows ?? [];
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header = rows[0] ?? [];
  const visibleRows = rows.slice(range.start, range.end + 1);

  return (
    <div className={styles.viewer}>
      {sheets.length > 1 && (
        <div className={styles.sheetTabs}>
          {sheets.map((sheet, i) => (
            <button
              key={sheet.name}
              type="button"
              className={`${styles.sheetTab} ${i === activeSheet ? styles.sheetTabActive : ''}`}
              onClick={() => {
                setActiveSheet(i);
                setScrollTop(0);
                scrollRef.current?.scrollTo({ top: 0 });
              }}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <div
        className={styles.scroll}
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.rowNoCol}>#</th>
              {Array.from({ length: columnCount }, (_, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 列序是位置性身份（无重排），index 即列号
                <th key={c}>{columnLabel(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 顶部撑起虚拟滚动偏移 */}
            {range.start > 0 && (
              <tr style={{ height: range.start * ROW_HEIGHT }}>
                <td colSpan={columnCount + 1} />
              </tr>
            )}
            {visibleRows.map((row, i) => {
              const rowNumber = range.start + i + 1;
              const isHeader = rowNumber === 1;
              return (
                <tr key={rowNumber} style={{ height: ROW_HEIGHT }}>
                  <td className={styles.rowNoCol}>{rowNumber}</td>
                  {Array.from({ length: columnCount }, (_, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 列序是位置性身份（无重排），index 即列号
                    <td key={c} className={isHeader ? styles.headerCell : undefined}>
                      {row[c] ?? ''}
                    </td>
                  ))}
                </tr>
              );
            })}
            {/* 底部撑起剩余高度 */}
            {range.end < rows.length - 1 && (
              <tr style={{ height: (rows.length - 1 - range.end) * ROW_HEIGHT }}>
                <td colSpan={columnCount + 1} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className={styles.statusBar}>
        {t('preview.viewer.sheet.rows', { count: rows.length })} ·{' '}
        {t('preview.viewer.sheet.columns', { count: columnCount })}
        {header.length > 0 && ` · ${t('preview.viewer.sheet.header', { first: header[0] ?? '' })}`}
      </div>
    </div>
  );
}
