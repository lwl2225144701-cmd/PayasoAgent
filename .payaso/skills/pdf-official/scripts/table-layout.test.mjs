// 算法层单测（node:test）：合成 item 数组复刻 spike 实测的坐标系，
// 不依赖 pdfjs / 真实 PDF —— 算法与 IO 彻底解耦，改算法先跑这里。
// 运行: node --test .payaso/skills/pdf-official/scripts/table-layout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeItems,
  clusterRows,
  detectColumnStarts,
  renderJson,
  renderMarkdown,
  splitRowIntoCells,
} from './table-layout.mjs';

// pdfjs item 工厂：transform = [a,b,c,d,x,y]，width 为文本宽度（pt）。
const item = (x, y, str, width) => ({ str, transform: [1, 0, 0, 1, x, y], width: width ?? str.length * 15 });

// ---- 行聚类 ----

test('行聚类：同 y（含 ≤2pt 抖动）归一行，行距 16pt+ 分离', () => {
  const rows = clusterRows([
    item(50, 700.0, '第一行'),
    item(120, 700.9, '同行抖动'),
    item(50, 683.5, '第二行'),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells.length, 2); // y=700 与 700.9 合并
  assert.equal(rows[0].cells[0].str + rows[0].cells[1].str, '第一行同行抖动');
  assert.equal(rows[1].cells.length, 1);
});

test('行聚类：过滤空白 item，行内按 x 升序', () => {
  const rows = clusterRows([item(200, 700, '右'), item(50, 700, '左'), item(50, 690, '   ')]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].cells.map((c) => c.str), ['左', '右']);
});

// ---- 行内切列 ----

test('行内切列：x 间隔超阈值断开，间隔不足并入同 cell', () => {
  // 行均字宽 15（4 字 × 15pt）→ 阈值 max(6, 18) = 18
  const row = { y: 700, cells: [
    { x: 50, end: 110, str: '姓名甲', column: null },  // 4 字 × 15pt = 60
    { x: 134, end: 179, str: '部门乙', column: null }, // 3 字 × 15pt = 45；间隔 24 > 18 → 切
    { x: 181, end: 226, str: '接着写', column: null }, // 间隔 2 → 并
  ] };
  const cells = splitRowIntoCells(row);
  assert.equal(cells.length, 2);
  assert.equal(cells[0].str, '姓名甲');
  assert.equal(cells[1].str, '部门乙接着写');
});

// ---- 列检测 ----

test('列检测：跨行复现 ≥2 次才算列；单行多 cell 不构成列', () => {
  const rows = [
    { y: 700, cells: [{ x: 50 }, { x: 200 }] }, // 单行两 cell
    { y: 680, cells: [{ x: 50 }, { x: 150 }] },
    { y: 660, cells: [{ x: 50 }, { x: 150 }] }, // x=50、150 各复现 3 行
  ];
  assert.deepEqual(detectColumnStarts(rows), [50, 150]); // x=200 只 1 行 → 不是列
});

// ---- 端到端渲染（合成 3×3 表格 + 散文行 + 信息行）----

const tablePageItems = [
  item(50, 730, '以下是本季度绩效明细表，数据截至上月末。', 400), // 散文行（单 cell）
  item(50, 715, '女', 30), item(81, 715, '32岁', 40), item(145, 715, '13800138000', 66), // 信息行（仅 x=50 命中列）
  ...['姓名甲', '姓名乙', '姓名丙'].flatMap((name, r) => [
    item(50, 700 - r * 20, name, 60),                                   // 4 字 × 15
    item(134, 700 - r * 20, '研发部', 45),                              // 3 字 × 15
    item(218, 700 - r * 20, r === 0 ? '优秀' : '良好', 30),             // 2 字 × 15
  ]),
];

test('analyzeItems：检测出 3 列并标注表格行', () => {
  const analysis = analyzeItems(tablePageItems);
  assert.deepEqual(analysis.columns, [50, 134, 218]);
  const tabularRows = analysis.rows.filter((r) => r.tabular);
  assert.equal(tabularRows.length, 3);
  // 表格行 cells 均命中列
  for (const row of tabularRows) {
    assert.ok(row.cells.every((c) => c.column !== null));
  }
});

test('renderMarkdown：表格块 → markdown 表；散文行透传；信息行保留 | 分隔', () => {
  const md = renderMarkdown(analyzeItems(tablePageItems));
  const lines = md.split('\n');
  // 散文行原样
  assert.ok(lines.some((l) => l === '以下是本季度绩效明细表，数据截至上月末。'));
  // 信息行以 | 连接（非表格行但多 cell）
  assert.ok(lines.some((l) => l === '女32岁 | 13800138000')); // 1pt 间隔合并不插空格（<空格宽度）
  // 表格块：表头 + 分隔行 + 3 数据行
  const headerIndex = lines.findIndex((l) => l.startsWith('| 列1 |'));
  assert.ok(headerIndex >= 0);
  assert.match(lines[headerIndex + 1], /^\|---\|---\|---\|$/);
  assert.equal(lines[headerIndex + 2], '| 姓名甲 | 研发部 | 优秀 |');
  assert.equal(lines[headerIndex + 3], '| 姓名乙 | 研发部 | 良好 |');
  assert.equal(lines[headerIndex + 4], '| 姓名丙 | 研发部 | 良好 |');
});

test('renderJson：列起点 + 行 cells 结构化输出', () => {
  const json = renderJson(analyzeItems(tablePageItems));
  assert.deepEqual(json.columns, [50, 134, 218]);
  assert.equal(json.rows.length, 5);
  const dataRow = json.rows.find((r) => r.tabular && r.cells[0].str === '姓名甲');
  assert.deepEqual(dataRow.cells.map((c) => c.column), [0, 1, 2]);
});

// ---- 边界 ----

test('空输入 / 全空白：不炸，输出空', () => {
  assert.equal(renderMarkdown(analyzeItems([])), '');
  assert.equal(renderMarkdown(analyzeItems([item(0, 0, '  ')])), '');
});

test('无任何复现列：多 cell 行以 | 透传，不硬拼表格', () => {
  const md = renderMarkdown(analyzeItems([item(50, 700, '甲', 15), item(90, 700, '乙', 15)]));
  assert.equal(md, '甲 | 乙'); // 单行两 cell：无跨行复现 → 不是表格
});

test('cell 内含竖线会被转义，不破坏 markdown 结构', () => {
  const md = renderMarkdown(analyzeItems([
    item(50, 700, '甲|乙', 45), item(134, 700, '丙', 45), item(218, 700, '丁', 45),
    item(50, 680, 'x', 15), item(134, 680, 'y', 15), item(218, 680, 'z', 15),
  ]));
  assert.ok(md.includes('| 甲\\|乙 | 丙 | 丁 |'));
});
