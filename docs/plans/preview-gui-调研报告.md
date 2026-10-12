# 预览 GUI 调研报告：PayasoAgent 加上「文件预览面板」需要做哪些工作

> 调研时间：当前会话 · 调研对象：`/Users/luweiliang/Downloads/myProject/PayasoAgent`（payaso-agent v2.2）
> **本期范围（已收窄）：只做文件预览停靠面板**（工作区文件树 + 文档预览）。终端、浏览器预览不做。
> **文档类型要求：Word（.docx）、PDF、Excel（.xlsx）、txt、md**（另含图片、代码，见矩阵）。
> 目标形态参照：截图 2（文件树 + 面包屑）与截图 3（Markdown 文档预览标签页）。

---

## 一、结论（TL;DR）

本期不碰终端/浏览器，无新增安全暴露面。核心增量在「一个 workspace 级文件 API + 一个 Dock 面板 UI + **五种文档类型的渲染管线**」。

| 模块 | 现状 | 新增工作量 |
|---|---|---|
| workspace 级文件 API（列目录/读文件/stat + 文档二进制） | 有 run 级 `/runs/:runId/files`，无工作区级 | 小（2–3 天） |
| Dock 布局（右侧可折叠面板 + 标签栏） | 无 dock 概念 | 中（3–4 天） |
| 文件树组件 | 无（侧栏 WorkspaceSection 是会话分组，不是文件树） | 中（3–4 天） |
| txt 预览 | 文本预览已存在（FileModal `<pre>`） | ~0（沿用 + 大文件截断策略） |
| md 预览 | 有模态 FileModal，需升级为文档级排版 + 相对图片解析 | 小（2 天） |
| **PDF 预览** | 服务端仅有文本提取（`pdf.ts`），无渲染 | **中（3–4 天）** |
| **Word 预览** | 服务端仅有文本提取（`docx.ts` → TSV），无渲染 | **中（2–3 天）** |
| **Excel 预览** | 服务端仅有 TSV 提取（`xlsx.ts`），无渲染 | **中（2–3 天）** |
| 图片 lightbox | 时间线内有 `<img>`，无 lightbox | 小（1–2 天） |
| 代码高亮 | 纯 `<pre>` | 小（1–2 天） |
| 开始态入口卡片 + 快捷键 | 无 | 小（1 天） |
| 文件监听自动刷新 / 编辑写回 | 无（P3，可选） | 小–中（3–5 天） |

**合计：约 4–4.5 周**（含测试；P0 文件面板 2–2.5 周 + 文档渲染 1.5–2 周）。加 P3 约 5 周。

文档渲染的三个库（pdfjs-dist / mammoth / SheetJS）**全部走前端动态 import 懒加载**，首屏不受影响；后端继续零新依赖。

---

## 二、现状盘点（已有什么）

### 2.1 后端（`src/host`，纯 `node:http`，127.0.0.1:4500）

| 能力 | 位置 | 说明 |
|---|---|---|
| 页内目录枚举 | `src/host/workspace-browser.ts` + `/workspace` 路由 | 原本给 Workspace 选择器用；单层 500 条上限、`truncated` 标志、Windows 盘符虚拟层、隐藏文件过滤 |
| 工作区文件读取 | `runs-handler.ts` 的 `/runs/:runId/files` | 列文件、读文本（2MB 上限）、图片扩展名直接返二进制（`IMAGE_EXT_MIME` 白名单，`<img src>` 可用） |
| 安全读实现 | `src/host/routes/static-handler.ts` | MIME 白名单、路径穿越防护、`assertInsideRoot`/`resolveWorkspacePath` 校验、SPA fallback |
| **文档文本提取（给 LLM 用，非预览）** | `src/host/attachments/` | `docx.ts`（段落/表格→TSV）、`xlsx.ts`（sheet→TSV 分节）、`pdf.ts`（零依赖快路径 + pdfjs 兜底）、`pptx.ts`；全部手写零依赖，共用 `zip.ts` 解压 |
| 权限模式 | `permission-mode.ts` | `read-only` / `workspace-write`（默认）/ `full-access`，Run 创建时快照 |
| SSE 事件流 | `src/host/event-stream-service.ts` | 已有实时推送通道（P3 文件变更通知可复用） |
| 鉴权 | `setHostApiToken` + Origin 检查 | 无 token 跳过鉴权（本机单用户假设） |

> 注意：`attachments/` 下的提取产物是**扁平纯文本/TSV**（表格丢结构、图片丢失、无排版），只能作为预览失败时的降级兜底，不能直接当预览渲染。

### 2.2 前端（`web/`，React 18 + Vite + CSS Modules）

| 能力 | 位置 | 说明 |
|---|---|---|
| 模态式文件预览 | `web/src/components/FileModal/` | `.md/.markdown/.mdx` 走 `MarkdownText` 渲染，其余 `<pre>` 源码 |
| Markdown 渲染 | `MarkdownText` + `remark-gfm` + `MermaidBlock` | 聊天内富文本，含 mermaid 图表 |
| 图片渲染 | `Timeline`（附件 + read 工具结果） | 走 `/runs/:runId/files/<rel>` 二进制端点 |
| i18n | `web/src/i18n/` + 闸门测试 | 用户可见位置不得残留中文 |
| E2E | playwright（已在 devDeps） | 已有依赖，缺用例 |

### 2.3 明确缺失（对照截图 2/3）

- ❌ **无停靠面板（dock）概念**：`App.tsx` 布局是「侧栏 + 主时间线」，没有右侧可折叠多标签面板
- ❌ **无工作区级文件树**：现有文件访问都是 **run 作用域**，没有"浏览整个工作区目录树"的 API 和 UI
- ❌ **五类文档均无可视化预览**：md 有模态渲染但非文档级排版；pdf/docx/xlsx 只有服务端文本提取；txt 有纯文本但无大文件策略
- ❌ **代码预览无高亮**、图片预览无 lightbox
- ❌ **无文件监听**：Agent 改了工作区文件，界面不会自动刷新

---

## 三、工作清单

### 3.1 后端：workspace 级文件 API（约 2–3 天）

```
GET  /workspace/files?path=<rel>        # 列目录（复用 workspace-browser 的 listDir + truncated 语义）
GET  /workspace/files/<rel>             # 读文件：文本走安全读；图片/文档按 MIME 白名单返二进制
GET  /workspace/files/<rel>/stat        # 大小/mtime（树 UI 与 P3 刷新需要）
POST /workspace/files/<rel>             # 写回（P3，权限校验同 write 工具；read-only 模式禁用）
```

- 复用 `assertInsideRoot` / `resolveWorkspacePath` + `static-handler` 的 MIME 白名单，**不新写安全逻辑**
- **扩展二进制白名单**：现有 `IMAGE_EXT_MIME` 只覆盖图片；需新增 `.pdf / .docx / .xlsx`（返回原始字节，前端解析）
- **分类型大小上限**：现有文本 2MB / 图片 8MB 太紧——docx/xlsx 是 zip（内嵌图片常超 2MB）、pdf 在 `pdf.ts` 里已有 32MB 先例。建议：文档类 32MB 上限，与 `MAX_DOCUMENT_BYTES` 对齐
- 尊重 `permissionMode` 快照：`read-only` 下只读、禁写回
- 忽略规则（`node_modules`、`.git` 等）与 `grep`/`glob` 工具保持一致，避免列目录被 300+ 目录拖垮

### 3.2 前端：Dock 布局（约 3–4 天）

- `App.tsx` 从「侧栏 + 主区」扩为「侧栏 + 主区 + **右侧可折叠/可拖宽 dock**」
- 标签栏：打开的文件各占一个标签（截图 3 形态）；空态显示目录树（截图 2 形态）
- 状态提升到 App 级：时间线里点文件 → 在 dock 中打开（替代现有 FileModal 弹模态）
- CSS Modules 体系内新增，不引 UI 框架

### 3.3 前端：文件树组件（约 3–4 天）

- 懒加载展开（点击目录才请求子级）
- 面包屑（截图 2 顶部路径条）+ 刷新按钮
- 扩展名图标（`icons.tsx` 体系内扩展，覆盖 md/pdf/docx/xlsx/txt/图片/代码）
- 名称过滤框；隐藏文件/忽略目录默认折叠，与后端忽略规则对齐

### 3.4 前端：文档类型预览矩阵（约 1.5–2 周）

| 类型 | 技术路线（推荐） | 要点 |
|---|---|---|
| **txt** | 现有 `<pre>` + 大文件截断 | 沿用 `read` 工具的首尾截断语义（超预算保留首尾 + 精确续读区间提示）；等宽字体 + 行号可选 |
| **md** | `MarkdownText` + 文档级排版 | 标题层级/表格/代码块留白按文档风格重排版（截图 3）；**相对路径图片重写**为 `/workspace/files/...` URL（当前 FileModal 未处理，工作区文档里的本地图会裂）；mermaid 已支持 |
| **PDF** | `pdfjs-dist` 动态 import → canvas 渲染 | pdfjs-dist 6.3.289 已是 root optionalDeps（服务端提取在用），web 侧单独引入同版本；分页虚拟滚动（只渲染可视页 ±1）、缩放、页码跳转、文本选择层（可选）；渲染失败降级到服务端已有文本提取兜底 |
| **Word (.docx)** | `mammoth.js` 动态 import → HTML | docx→HTML 保留标题/列表/表格/加粗等；**内嵌图片**：mammoth `convertImage` 给 base64 → data URI 内联（避免新增 zip-entry 端点）；样式映射到文档预览主题；不支持 legacy `.doc`（OLE 二进制）→ 提示下载 |
| **Excel (.xlsx)** | `SheetJS`（xlsx）动态 import → HTML 表格 + sheet 标签 | 多 sheet 切换标签；大 sheet 行虚拟化；列宽自适应；数字/日期按格式渲染；CSV/TSV 顺带支持（SheetJS 直接读）；legacy `.xls` SheetJS 也能读 |

**共性机制**：
- 三个库全部 `await import()` 懒加载，首屏零成本；加载中显示骨架/进度
- 统一「文档预览容器」组件：标题栏（文件名 + 大小 + 类型徽标）+ 内容区，md/pdf/docx/xlsx 复用同一外壳
- 预览失败统一降级：转纯文本预览（xlsx/docx 可直接复用服务端 TSV 提取端点，pdf 复用 `pdf.ts` 文本），并明确提示"已降级为文本视图"
- 所有新文案走 `web/src/i18n/`，过 `tests/frontend-i18n-coverage.test.ts` 闸门

### 3.5 前端：图片 lightbox（约 1–2 天）

- 缩放/平移/适应窗口；走 §3.1 图片二进制端点

### 3.6 前端：代码高亮（约 1–2 天）

- highlight.js（省心）或 shiki（质感好、体积大）；动态 import；超大文件沿用截断策略

### 3.7 前端：入口与快捷键（约 1 天）

- 开始态放「工作区文件 ⌘P」入口卡片，打开 dock 文件面板
- ⌘P 切文件面板；与现有快捷键体系统一

### 3.8 可选项 P3（约 3–5 天）

- **文件监听自动刷新**：`fs.watch`/chokidar → 走**现有 SSE 事件流**推 `file-changed`，已打开预览自动 reload
- **预览内编辑写回**：txt/md/代码预览态可编辑 → §3.1 POST 端点；`read-only` 禁用

### 3.9 测试

- Host 测试扩展：列目录/读文件/路径穿越/权限模式/文档二进制 MIME 与大小上限
- 契约测试：新端点 schema
- **文档 fixtures**：tests 下准备各类型最小样本（含表格/图片/多 sheet/多页的 docx/xlsx/pdf/md/txt）
- Playwright e2e：文件树导航 → 各类型预览渲染断言 → 降级路径 → lightbox → 高亮
- i18n 覆盖闸门必须通过

---

## 四、工作量估算（单人，含测试）

| 范围 | 估算 |
|---|---|
| 核心 P0（API + Dock + 文件树 + md/txt/图片/代码 + 入口） | 2–2.5 周 |
| + 文档渲染（PDF/Word/Excel） | **4–4.5 周** |
| + P3（监听刷新 + 编辑写回） | 5 周 |

新增前端依赖（全部懒加载，不进首屏）：`pdfjs-dist` ~1MB、`mammoth` ~200KB、`xlsx` ~800KB。后端**零新依赖**。

---

## 五、关键决策点（立项前定）

1. **docx/xlsx 渲染路线**：客户端库（mammoth/SheetJS，**推荐**——与"重前端轻后端"现状一致，且附件提取已证明零依赖手写成本高）vs 扩展现有解析器出 HTML（零新依赖但保真度低、工作量大）
2. **PDF 渲染**：pdfjs-dist 客户端 canvas（**推荐**，无替代方案）vs 服务端文本预览降级（现成但不满足"预览"预期）
3. **Excel 渲染深度**：SheetJS 表格 + sheet 标签（**推荐**，2–3 天）vs Univer/Luckysheet 完整电子表格（MB 级、按周算，且编辑态超出预览范围）
4. **大文件策略**：分类型上限（文档 32MB）+ 懒加载 + 降级文本预览的触发条件
5. **legacy `.doc`/`.xls`**：提示不支持 + 下载（推荐）vs 引入 LibreOffice 服务端转换（重）
6. **与 FileModal 的关系**：dock 上线后时间线点文件一律进 dock（推荐），模态退役或仅留窄屏回退

---

## 六、复用清单（不要重写）

- 目录枚举：`src/host/workspace-browser.ts`
- 安全文件读 + MIME 白名单：`src/host/routes/static-handler.ts`
- 路径校验：`src/sandbox/sandbox-manager.ts`（`resolveWorkspacePath` / `assertInsideRoot`）
- Markdown 渲染：`web/src/components/MarkdownText` + `MermaidBlock`
- 图片二进制端点：`IMAGE_EXT_MIME` + 二进制返回逻辑
- 文档提取兜底：`src/host/attachments/docx.ts` / `xlsx.ts` / `pdf.ts`（渲染失败时降级文本预览直接复用，无需重写）
- 权限模式：`permission-mode.ts`（读档位决定写回可用性）
- 实时推送：`event-stream-service.ts`（P3 文件变更通知复用 SSE）

## 七、范围外（本期明确不做）

- ~~网页终端（WebSocket + PTY + xterm.js）~~
- ~~浏览器预览（iframe / 页内 HTML）~~
- pptx 预览（`pptx.ts` 提取已存在；幻灯片渲染复杂度高，二期再说——可先降级文本预览）
- Excel 编辑态（只读预览；完整电子表格内核不做）
