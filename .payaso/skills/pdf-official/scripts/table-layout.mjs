// 表格结构还原 · 算法层（纯函数）。
// 只依赖 pdfjs getTextContent() 的 item 字段（str/transform/width），不 import
// pdfjs 或 node 模块 —— 因此可用合成 item 数组完整单测（table-layout.test.mjs）。
//
// 算法依据（2026-09-22 真实中文 PDF spike，两份简历实测）：
//   · 行内 y 抖动 ≤1.11pt、行距 ≥16.5pt（差 15 倍）→ 行聚类用固定小容差即可；
//   · 列边界表现为 x 间隔 ~24pt，行内词距仅 0.1–3pt（差一个数量级）→ 用「行均字宽
//     相对阈值」切列，天然适配不同字号；
//   · hasEOL 仅覆盖 20/44、14/79 → 不作为结构信号，只用 y/x 坐标；
//   · CJK item 的 width 度量可靠（12pt 字号 ≈9.4pt/字）→ 字宽阈值对中文有效。
//
// 消费者是 LLM 而非数据库：完成度目标是「结构保真到 LLM 能还原行列关系」，
// 不追求单元格级精确（合并单元格/跨页表头明确不做，见 renderMarkdown 注释）。

/** @typedef {{ str: string; transform: number[]; width?: number }} TextItem */
/** @typedef {{ x: number; end: number; str: string; column: number | null }} Cell */
/** @typedef {{ y: number; cells: Cell[]; tabular: boolean }} Row */

const Y_TOLERANCE = 2; // 行聚类容差（pt）：实测行内抖动 ≤1.11pt
const COLUMN_SNAP = 3; // 列边界对齐容差（pt）
const MIN_GAP_RATIO = 1.2; // 行内切列：x 间隔 > 行均字宽 × 此值才算列边界
const MIN_GAP_PT = 6; // 行内切列的绝对下限（pt），防小字号文档阈值过苛
const MIN_COLUMN_ROWS = 2; // 跨行复现下限：≥2 行出现的 cell 起点才算列

function visibleItems(items) {
  return (items ?? []).filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '');
}

/**
 * 行均字宽（每字符 pt）：长度加权平均。比中位数稳——混合长度 cell（1 字宽 cell
 * 会抬高中位数）下不漂移；spike 实测数据验算：冯子微信息行 ≈13.2、陆韦良 4 列行
 * ≈8.5、标签+内容行 ≈24.9，均能正确区分「列间大间隔」与「排版小间隔」。
 */
function averageCharWidth(cells) {
  const totalWidth = cells.reduce((sum, c) => sum + (c.end - c.x), 0);
  const totalChars = cells.reduce((sum, c) => sum + [...c.str].length, 0);
  return totalChars > 0 ? totalWidth / totalChars : 8;
}

/**
 * 行聚类：按 y 降序（PDF 原点在左下）分组，容差内的 item 归入同一视觉行，
 * 行内按 x 升序。返回的行尚未切列（cells = 原始 item）。
 */
export function clusterRows(items, yTolerance = Y_TOLERANCE) {
  const sorted = [...visibleItems(items)].sort((a, b) => b.transform[5] - a.transform[5]);
  const rows = [];
  for (const item of sorted) {
    const y = item.transform[5];
    const x = item.transform[4];
    const last = rows.at(-1);
    if (last && Math.abs(last.y - y) <= yTolerance) {
      last.cells.push({ x, end: x + (item.width ?? 0), str: item.str, column: null });
      continue;
    }
    rows.push({ y, cells: [{ x, end: x + (item.width ?? 0), str: item.str, column: null }] });
  }
  for (const row of rows) row.cells.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * 行内切列：相邻 cell 的 x 间隔超过 max(MIN_GAP_PT, 行均字宽 × MIN_GAP_RATIO)
 * 时断开为不同 cell；间隔不足则并入同一 cell（排版相邻的片段本就是一段文本）。
 * 返回新的 cells 数组（原 cells 不变）。
 */
export function splitRowIntoCells(row, options = {}) {
  const minGapRatio = options.minGapRatio ?? MIN_GAP_RATIO;
  const minGapPt = options.minGapPt ?? MIN_GAP_PT;
  const threshold = Math.max(minGapPt, averageCharWidth(row.cells) * minGapRatio);
  const groups = [];
  for (const cell of row.cells) {
    const current = groups.at(-1);
    if (current && cell.x - current.end > threshold) {
      groups.push({ x: cell.x, end: cell.end, parts: [cell] });
      continue;
    }
    if (current) {
      current.end = Math.max(current.end, cell.end);
      current.parts.push(cell);
    } else {
      groups.push({ x: cell.x, end: cell.end, parts: [cell] });
    }
  }
  return groups.map((g) => ({ x: g.x, end: g.end, str: g.parts.map((p) => p.str).join(''), column: null }));
}

/**
 * 跨行列边界检测：cell 起点做 1D 聚类（容差 COLUMN_SNAP），出现在 ≥ MIN_COLUMN_ROWS
 * 个不同行的簇才是列边界。单行多 cell（可能是排版而非表格）不会被误判成列。
 * 返回列起点 x 的升序数组。
 */
export function detectColumnStarts(rows, options = {}) {
  const snap = options.snap ?? COLUMN_SNAP;
  const minRows = options.minRows ?? MIN_COLUMN_ROWS;
  const starts = rows.flatMap((row) => row.cells.map((c) => c.x)).sort((a, b) => a - b);
  if (!starts.length) return [];
  // 1D 聚类：排序后相邻距离 ≤ snap 的并入同簇，取均值为列位置。
  const clusters = [];
  for (const x of starts) {
    const last = clusters.at(-1);
    if (last && x - last.x <= snap) {
      last.x = (last.x * last.count + x) / (last.count + 1);
      last.count += 1;
      continue;
    }
    clusters.push({ x, count: 1 });
  }
  // 按「覆盖的行数」过滤（同一行在列附近有多个 cell 只计一次）。
  return clusters
    .map((cluster) => ({
      x: cluster.x,
      rows: new Set(
        rows
          .filter((row) => row.cells.some((c) => Math.abs(c.x - cluster.x) <= snap))
          .map((row) => row.y),
      ).size,
    }))
    .filter((cluster) => cluster.rows >= minRows)
    .map((cluster) => cluster.x)
    .sort((a, b) => a - b);
}

/**
 * 完整分析：行聚类 → 行内切列 → 列检测 → 给每个 cell 标注所属列 + 标记表格行。
 * 表格行 = 命中 ≥2 个检测列的行。
 */
export function analyzeItems(items, options = {}) {
  const clustered = clusterRows(items, options.yTolerance);
  const rows = clustered.map((row) => ({ ...row, cells: splitRowIntoCells(row, options) }));
  const columns = detectColumnStarts(rows, options);
  for (const row of rows) {
    let hits = 0;
    for (const cell of row.cells) {
      const index = columns.findIndex((x) => Math.abs(cell.x - x) <= (options.snap ?? COLUMN_SNAP));
      cell.column = index >= 0 ? index : null;
      if (index >= 0) hits += 1;
    }
    row.tabular = hits >= 2;
  }
  return { rows, columns };
}

/** 按列取行内文本：命中列的 cell 文本，缺列为空串。 */
function cellsByColumn(row, columnCount) {
  const out = Array.from({ length: columnCount }, () => '');
  for (const cell of row.cells) {
    if (cell.column !== null && cell.column < columnCount) {
      out[cell.column] += (out[cell.column] ? ' ' : '') + normalizeSpace(cell.str);
    } else if (cell.column === null && out.every((s) => s === '')) {
      // 未命中任何列的多 cell 行：降级拼到第一列前，保证内容不丢。
      out[0] += (out[0] ? ' ' : '') + normalizeSpace(cell.str);
    }
  }
  return out;
}

function normalizeSpace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|');
}

/**
 * 渲染为 markdown：连续的表格行聚成表格块（首行作表头）；其余行输出为文本
 * （多 cell 行以 ' | ' 连接，保住可见的列分隔；单 cell 行原样）。
 * 明确降级：合并单元格/跨页表头不做，跨行断裂的表格块各自成表。
 */
export function renderMarkdown(analysis) {
  const { rows, columns } = analysis;
  if (!columns.length) return rows.map((row) => row.cells.map((c) => normalizeSpace(c.str)).join(' | ')).join('\n');
  const lines = [];
  let index = 0;
  while (index < rows.length) {
    if (!rows[index].tabular) {
      lines.push(rows[index].cells.map((c) => normalizeSpace(c.str)).join(' | '));
      index += 1;
      continue;
    }
    // 收集连续表格行块
    let end = index;
    while (end < rows.length && rows[end].tabular) end += 1;
    const block = rows.slice(index, end);
    const width = Math.max(columns.length, ...block.map((row) => row.cells.filter((c) => c.column !== null).length));
    lines.push(`| ${Array.from({ length: width }, (_, c) => `列${c + 1}`).join(' | ')} |`);
    lines.push(`|${Array.from({ length: width }, () => '---').join('|')}|`);
    for (const row of block) {
      const cells = cellsByColumn(row, width);
      lines.push(`| ${cells.map(escapeCell).join(' | ')} |`);
    }
    index = end;
  }
  return lines.join('\n');
}

/** 渲染为结构化 JSON（供程序化消费）：列起点 + 每行 cells。 */
export function renderJson(analysis) {
  return {
    columns: analysis.columns,
    rows: analysis.rows.map((row) => ({
      y: row.y,
      tabular: row.tabular,
      cells: row.cells.map((c) => ({ x: c.x, column: c.column, str: c.str })),
    })),
  };
}

/** 便捷入口：items → 指定格式输出。 */
export function renderPage(items, format = 'markdown', options = {}) {
  const analysis = analyzeItems(items, options);
  return format === 'json' ? renderJson(analysis) : renderMarkdown(analysis);
}