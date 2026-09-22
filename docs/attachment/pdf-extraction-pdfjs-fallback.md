# PDF 提取改造：手写快路径 + pdfjs-dist 兜底（第一层）

状态：**设计阶段，待 review 后实施**。日期：2026-09-22。

## 1. 背景与动机

当前 PDF 文本提取是**两套割裂、且都不好用**的状态：

- **host 内建**（`src/host/attachments/pdf.ts`，119 行）：手写零依赖 JS，正则扫 `BT/ET/Tj/TJ`，
  FlateDecode 用 `node:zlib`。第 95-96 行遇 `/Type0`、`/ToUnicode` 直接 `throw`——
  而**几乎所有中文 PDF 都用 Type0 + ToUnicode 字体**，故中文 PDF 在 ingest 阶段就 fail-fast。
- **skill**（`.payaso/skills/pdf-official/`）：Python 生态（pypdf/pdfplumber/pdfjs…）。
  但沙箱工具链白名单按 Node 技术栈（`git/node/npm`）设计，`python3`(Homebrew)、`tesseract`、
  `qpdf` 均「能读不能执行」——详见 `docs/sandbox/sandbox-mental-model.md`。

**根因**：skill 的运行时与宿主（Node）技术栈不一致。本方案用 Node 生态替代，
分两层落地；本文档详述**第一层**（host 内建升级），是唯一「不碰 skill、不碰沙箱白名单」
就能让中文 PDF 当场可用的一步。

## 2. 目标与非目标

**目标（第一层）**
- `extractPdfText` 遇到 Type0/ToUnicode/加密/不支持流等 fail-fast 情况时，
  回退到 `pdfjs-dist` 提取，中文 PDF 在附件入库阶段直接得到正确文本。
- 内建提取的 `partial`/`failed` 占比大幅下降，减少「把活推给 skill」的路径。

**非目标**
- 不改 `.payaso/skills/pdf-official/`（skill 换血为第二层，见 §7）。
- 不改沙箱工具链白名单（`toolchain-manager.ts`）。
- 不做表格结构化提取、OCR、渲染成图（pdfjs-dist 只补齐「纯文本层提取」）。

## 3. 方案设计

### 3.1 依赖：`pdfjs-dist` @ `optionalDependencies`

```json
"optionalDependencies": {
  "pdfjs-dist": "<落地时锁定版本>"
}
```

理由：`optional` 装不上不阻断 `npm ci` 主流程；`execute` 时若缺失则显式报错
（浏览器「未安装 pdfjs-dist，回退到简易提取」语义，见 §4）。这与 sharp 的
`dependencies` 策略区分开——sharp 是图片主路径必需，pdfjs-dist 只是兜底增强。

### 3.2 `pdf.ts` 改造：同步 → 异步 + 两步回退

现状签名：

```ts
export function extractPdfText(bytes: Buffer): string
```

目标签名：

```ts
export async function extractPdfText(bytes: Buffer): Promise<string>
```

改造结构（伪码）：

```ts
export async function extractPdfText(bytes: Buffer): Promise<string> {
  // 1. 手写快路径（现状 92-118 行逻辑，抽成 extractPdfTextSimple）
  try {
    return extractPdfTextSimple(bytes);
  } catch (err) {
    // 2. 判定是否值得回退 pdfjs-dist（Type0/ToUnicode/不支持流/解压失败）
    if (isFallbackablePdfError(err)) {
      return extractPdfTextWithPdfjs(bytes);
    }
    throw err;  // 缺 %PDF 头、真·损坏文件 → 保持原报错，不进回退
  }
}
```

关键点：

1. **抽函数**：把手写正则逻辑原样抽成 `extractPdfTextSimple`，行为零变化。
2. **回退判定** `isFallbackablePdfError`：只有「字体字符映射不支持的编码」这类
   **工具能力不足**才回退；「不是有效 PDF」（缺 `%PDF-` 头）不回退，直接 fail。
3. **懒加载**：`pdfjs-dist` 只在回退分支 `await import()`，简单 ASCII PDF 不受
   冷启动/内存影响。

### 3.3 `pdfjs-dist` Node 侧用法要点

- 用 **legacy build**：`pdfjs-dist/legacy/build/pdf.mjs`（无 DOM/canvas 依赖）。
- **worker**：Node 无 worker 且有已知坑——需 `GlobalWorkerOptions.workerSrc` 指向
  legacy worker（`pdf.worker.mjs`）或配 fake worker；否则 `getDocument` 会报
  「Cannot find module …pdf.worker.mjs」。
- 文本提取主链路：

```ts
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({
  data: new Uint8Array(bytes),
  useWorkerFetch: false,
  isEvalSupported: false,
}).promise;
let out = '';
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  out += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
}
```

> ⚠️ 精确 API 随所选 pdfjs-dist 版本有差异（v4/v5/v6 的 worker 配置与模块入口不同），
> **落地时按锁定的版本验证**，以上为结构示意，不作为最终实现契约。

### 3.4 `normalize.ts` 调用点

第 123 行 `extractPdfText(bytes)` 已在 `async` 函数内，改为 `await extractPdfText(bytes)`。
其余提取状态逻辑（`partial` / `failed`、2 MiB 正文上限）不变。

## 4. 边界情况与降级语义

| 情况 | 行为 |
|---|---|
| 缺 `%PDF-` 头 | 不回退，直接 `failed`（保持现状报错） |
| Type0/ToUnicode/加密/不支持流 | 回退 pdfjs-dist；加密仍失败 → `failed` + 原错误，指路 skill |
| pdfjs-dist 未安装（optional 缺失） | 回退路径报「未安装 pdfjs-dist，无法提取中文/复杂 PDF」，`failed` 保留原件 |
| 扫描件（无文本层） | pdfjs `getTextContent` 返回空 → 沿用「未能提取文字」`failed`，指路 OCR |
| **内置结果乱码（无 ToUnicode 的字体子集）** | 内置引擎逐字节解出大量 C0/C1/私用区字符（曾以 `partial` 落盘二进制 .txt）→ `looksLikeGarbage` 闸门（不可读字符 > 5%）判 `UnsupportedPdfError` → 转 pdfjs；pdfjs 走字体 cmap 反查常能解出正确文本。**2026-09-22 真实故障修复**：某中文简历 PDF（无 ToUnicode）从 14911 乱码字符变为 4004 汉字正确提取 |
| pdfjs-dist 自身抛错/超时 | 保留 pdfjs 错误信息，`failed` + 原错误，不静默降级 |
| 超大 PDF | 仍受 `MAX_PDF_BYTES`（16 MiB）上限约束，进 pdfjs 前已在策略层拦截 |

**`partial` 语义保持不变**：pdfjs 提取同样可能遗漏文字/布局，结果始终标注 `partial`，
不回退到 `extracted` 的过度承诺。

## 5. 测试计划

在 `tests/text-attachments.test.ts` 增补（或独立 fixture 文件）：

1. **中文 PDF 回归（核心）**：构造一个含 Type0 + ToUnicode 的最小 PDF（或嵌入 fixture），
   断言 `status` 从 `failed` → `partial`，且正文含预期中文字符。
2. **快路径不回归**：现有「Uncompressed sentinel」「mapped.pdf 失败」等断言保持通过
   （mapped.pdf 若走 pdfjs 回退，需按新语义调整断言）。
3. **懒加载**：简单 ASCII PDF 不触发 pdfjs import（可用模块加载计数/依赖缺省模拟）。
4. **依赖缺失降级**：模拟 pdfjs-dist 未安装，断言报错信息含「未安装 pdfjs-dist」。
5. **回退判定**：缺 `%PDF-` 头的坏文件仍直接 `failed`，不进 pdfjs。

## 6. 风险与能力差距（诚实标注）

- **表格**：pdfjs `getTextContent` 只给行文顺序 + 坐标，无 pdfplumber 级 table 提取；
  「精确表格结构化」仍不在第一层能力内。
- **版式**：多栏/混排文档的行文顺序不如 `pdftotext -layout` 精准。
- **版本 API 漂移**：pdfjs-dist 版本间 worker/模块入口差异，落地时锁定版本并固化用法。
- **包体积/冷启动**：pdfjs-dist 体积不小，靠 `optional` + 懒加载规避对主路径的影响。

## 7. 后续（第二层，不在本方案）

skill 换血：`.payaso/skills/pdf-official/scripts/*.py` → `*.mjs`，用 `node` 直跑；
表格用 pdfjs 坐标自拼、生成/表单用 `pdf-lib`、OCR 用 `tesseract.js`（WASM 跨平台）。
依赖挂项目 `package.json` 或 skill 自带 `package.json`（前者的取舍见会话记录）。

## 8. 实施顺序与停止条件

1. 锁定 pdfjs-dist 版本，`optionalDependencies` 落地，`npm ci` 验证可装。
2. `pdf.ts` 抽 `extractPdfTextSimple` + 加 async 回退骨架，先让现有测试全绿（行为不变）。
3. 接 pdfjs 提取实现（legacy build + worker 配置），补中文 PDF 测试。
4. `tsc --noEmit` + `tests/text-attachments.test.ts` + `docs-contract.test.ts` 全绿。
5. 停止条件：任一测试红、或 pdfjs 版本 API 无法在 Node 稳定跑文本提取 → 回写明障碍，不硬上线。

## 9. 参考

- 沙箱分层与技术栈根因：`docs/sandbox/sandbox-mental-model.md`
- 附件提取现状：`src/host/attachments/pdf.ts`、`src/host/attachments/normalize.ts`
- pdfjs-dist Node 文本提取（legacy build / worker 坑）：见 nutrient.io《server-side PDF.js text extraction》与 Stack Overflow「fake worker Cannot find module pdf.worker.mjs」。