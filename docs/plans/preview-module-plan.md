# 文件预览模块 · 技术设计（Preview Module）

> 状态：**M1–M4 已落地（已推送），M5 未开始**；open-in-app 的 **Windows / Linux 适配器未实现**（回落白名单，见文末「平台缺口」），图片附件的 `thumbnail` 变体（48px contain）暂无消费方。实施记录与手动验收清单见文末 §9。前置调研：[`preview-gui-调研报告.md`](preview-gui-调研报告.md)（范围与选型结论，本文不再重复论证）。
> 范围：**独立预览模块** —— 后端 `src/host/preview/` + 前端 `web/src/preview/`。终端、浏览器预览不做。
> 文档类型：Word（.docx）/ PDF / Excel（.xlsx）/ txt / md，另含图片与代码。

---

## 0. 结论

**两个自包含模块 + 一套 API 契约 + 一个 viewer registry。**

| | 结论 |
|---|---|
| 后端 | 新增 `src/host/preview/`（types / service）＋ `src/host/routes/preview-handler.ts`（HTTP 边界），`routes.ts` 加一行分发；**零新依赖**，安全逻辑全部复用 sandbox 与 static-handler |
| 前端 | 新增 `web/src/preview/` 自包含模块；**viewer registry 模式**——新增一种文件类型 = 加一个 viewer 文件 + registry 一行，不改其他代码 |
| 文档渲染库 | pdfjs-dist / mammoth / xlsx 三个库**全部动态 import 懒加载**，首屏零成本；渲染失败统一降级 |
| 降级兜底 | 直接复用现有 `src/host/attachments/` 的 docx/xlsx/pdf 文本提取端点（已验证的生产代码），不重写 |
| 集成面 | 只有 4 处：routes.ts 一行、App.tsx 挂 Dock、i18n 加 `preview.ts`、Timeline 点文件改指向 dock；FileModal 退役 |
| 关键约束 | 只读优先；`read-only` 权限档禁写回；大小上限**复用 `attachment-policy.ts` 单一来源**（office 8MB / pdf 16MB / text 2MB / image 8MB） |
| 错误处理 | **自定义 `PreviewError` 异常**（封闭 code 枚举 + 唯一 code→HTTP 映射表，§2.4）：替代现状"消息字符串当错误身份"的脆弱模式；前端按 code 分叉 + i18n。**不做全局异常框架**——与项目朴素风格对齐 |

---

## 1. 模块定位与边界

### 1.1 是什么

- **工作区文件的可视化预览面板**：右侧可折叠停靠 dock，多标签，目录树导航，按类型渲染
- **数据源是 workspace，不是 run**：没有进行中的 Run/会话时也能独立使用（与现有 `/runs/:runId/files` 的 run 作用域本质不同，这是必须新建 workspace 级 API 的原因）

### 1.2 不是什么（非目标）

- 不做富文本编辑器（M5 才有轻量写回，且仅 txt/md/代码）
- 不做终端、不做浏览器 iframe
- 不做 pptx 渲染（`pptx.ts` 提取已存在；幻灯片渲染复杂度高，二期；当前降级文本预览）
- 不做 Excel 编辑态 / 完整电子表格内核（只读表格预览）

### 1.3 与现有组件的关系

| 现有 | 处置 |
|---|---|
| `FileModal`（模态预览） | **退役**——能力被 PreviewDock 覆盖；迁移其 md/源码渲染逻辑进 viewers |
| `/runs/:runId/files` | 不动（run 产物语义继续服务 Timeline） |
| `attachments/` 提取 | 复用为降级兜底端点，**preview 模块不反向依赖 attachments 内部**（只走 HTTP 契约） |
| `workspace-browser.ts` | 复用其目录枚举实现（列目录/truncated/Windows 盘符层），抽为 preview-service 的依赖 |

---

## 2. 后端设计：`src/host/preview/`

### 2.1 文件结构（三件，单一职责）

```
src/host/preview/
  types.ts            # 契约类型 + 错误码枚举（前后端共享的镜像源）
  preview-service.ts  # 业务逻辑：目录树 / 读文件 / stat / 写回；忽略规则；权限判定
src/host/routes/
  preview-handler.ts  # HTTP 边界：参数解析、鉴权（route-context）、响应封装
```

**依赖方向**：`preview-handler → preview-service → {sandbox-manager, static-handler 安全读, workspace-browser, permission-mode, attachment-policy}`。handler 不认识文件系统，service 不认识 HTTP。

### 2.2 路由注册（`routes.ts` 一行）

```ts
// Workspace 域之后：
if (s[0] === 'preview') {
  return handlePreview(s, method, req, res, manager, port);
}
```

### 2.3 API 契约

统一响应：成功 `200 application/json`（二进制除外）；失败 `{ "error": "<code>" }`，HTTP 状态按错误码映射。

#### `GET /preview/tree?path=<rel>`

列一层目录（懒加载语义：前端点开目录才请求下一级，与服务端 500 条上限的 truncated 机制天然匹配）。

```jsonc
// 200
{
  "path": "src",                    // 相对工作区根；"" = 根
  "parent": "",                     // 上级目录（根为 null）
  "entries": [
    { "name": "host", "path": "src/host", "kind": "dir",  "hidden": false },
    { "name": "cli.ts", "path": "src/cli.ts", "kind": "file", "size": 1234, "mtime": 1728..., "hidden": false }
  ],
  "truncated": false                // 超 500 条置 true，前端提示
}
```

- 忽略规则：`node_modules/.git/dist/build/coverage` 默认折叠（与 grep/glob 工具同一份规则，实施时从 `src/tools/` 抽出共享常量，preview 不复制一份）；`includeIgnored=true` 可查忽略项（树UI"显示隐藏文件"开关）
- `kind` 由 `dirent.isDirectory()` 判定；symlink 不跟随（与 glob/grep 一致，防逃逸）

#### `GET /preview/file?path=<rel>`

按扩展名分发（`Accept` 不参与判定，避免浏览器 sniff 歧义）：

| 类别 | 扩展名 | 响应 |
|---|---|---|
| 文本 | **默认类别**：不在下表任一名单的扩展名（含无扩展名的 Makefile/Dockerfile）均按文本 | `text/plain; charset=utf-8` body（超 2MB → `413 too_large`） |
| 图片 | png/jpg/jpeg/webp/gif | 二进制 + `IMAGE_EXT_MIME`（复用 static-handler 表；超 8MB → `413`） |
| 文档 | pdf/docx/xlsx | 二进制 + 对应 MIME（pdf 16MB / office 8MB 上限，超限 `413`） |
| 其他 | 已知二进制拒绝名单（zip/tar/音视频/字体/可执行/数据库等，`KNOWN_BINARY_EXTS`） | `415 unsupported`（前端转"下载"兜底） |

> 文本类别的实现取向（M1 落地）：**已知二进制拒绝名单 + 默认文本**，而非封闭白名单——白名单会让 `.csv`/`.log`/`.env`/无扩展名文件全部落入 415，对预览面板是不可接受的缺失；utf8 解码不存在安全风险（字节原样呈现），安全性由路径校验 + 大小上限保证。绝对路径输入按工作区相对语义降格（`/src` 与 `src` 同义）。

二进制直接 `res.end(buffer)`；文本一次性写。**大小上限常量全部 import 自 `attachment-policy.ts`**，不新造数字。

#### `GET /preview/stat?path=<rel>`

`{ name, path, kind, size, mtime }` —— 树 UI 行内展示与 P3 刷新的比对基准。

#### `POST /preview/file`（M5）

```jsonc
// request
{ "path": "docs/a.md", "content": "..." }   // base64 或 utf8 二选一，按字段名区分
// 403 permission_denied：当前工作区 permissionMode 为 read-only
```

- 权限：非 read-only 才允许；写路径校验与 `write` 工具同链（`assertInsideRoot` + 原子写）
- 并发：单文件单写者，无锁（预览场景单人本地）

### 2.4 错误处理：自定义异常机制（`PreviewError`）

**为什么做**：项目现状的错误身份靠**消息字符串**承载（`throw new Error('缺少 fromName/toName')`），顶层兜底靠**精确字符串匹配**（`server.ts` 匹配 `'untrusted origin'`），前端 `jsonFetch` 不解析错误体。preview 的错误码是**封闭集合**且前端必须按 code 分叉（`too_large` → 显示上限数值；`unsupported` → 转 FallbackViewer；`permission_denied` → 禁用写回按钮）——字符串方案撑不住「按码分叉 + i18n」。

**为什么不做全局框架**：项目风格朴素直接（无框架、每域自理），runtime 侧的 `tool-error-classifier.ts` 证明「重机制」只在该有地方出现（它服务重试语义）。preview 需要的是**类型安全的封闭枚举 + 单一映射表**，一个 ~30 行的异常类即可，不引入责任链/注册表。

#### 2.4.1 后端：`PreviewError` + code 枚举（`preview/types.ts` 单一来源）

```ts
/** 封闭集合：新增 code 必须同步本表、handler 映射、前端 union、i18n 四处。 */
export const PREVIEW_ERROR_CODES = [
  'invalid_path',        // 400 空/含 .. /非法字符
  'outside_workspace',   // 403 解析后逃逸工作区根
  'not_found',           // 404 路径不存在
  'too_large',           // 413 超分类型上限（body 带 limit 字段）
  'unsupported',         // 415 已知二进制扩展名（拒绝名单命中）
  'permission_denied',   // 403 read-only 档写回
  'no_workspace',        // 409 未选择工作区（树/文件端点通用前置）
] as const;
export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

/** code → HTTP 状态。唯一映射表。 */
const CODE_STATUS: Record<PreviewErrorCode, number> = {
  invalid_path: 400, outside_workspace: 403, not_found: 404,
  too_large: 413, unsupported: 415, permission_denied: 403, no_workspace: 409,
};

export class PreviewError extends Error {
  constructor(readonly code: PreviewErrorCode, readonly detail?: Record<string, unknown>) {
    super(code); // message === code：日志与响应都以 code 为身份，不再有散文消息
  }
  get status(): number { return CODE_STATUS[this.code]; }
}
```

- `message === code`：日志、HTTP 响应三处身份统一，**不写散文消息**（现状中文散文泄漏到 API 的问题在此止住）
- service 层只抛 `PreviewError`；handler 只认它：

```ts
// preview-handler.ts —— 统一收口，每个端点 try/catch 只此一种形态
try {
  const listing = previewService.listTree(path, includeIgnored);
  return sendJson(res, 200, listing);
} catch (err) {
  if (err instanceof PreviewError) {
    return sendJson(res, err.status, { error: err.code, ...err.detail });
  }
  throw err; // 未预期错误冒泡到 server.ts 既有顶层 catch → 500，不猜不吞
}
```

- 响应体契约：`{ "error": "<code>" }`，`too_large` 附 `{ limit: 8388608 }`（数值来自 `attachment-policy`，前端直接展示"超过 8MB 上限"）
- 与既有 `RequestBodyTooLargeError → payload_too_large` 的关系：**不动它**（18 处调用点的迁移属另一个变更）；preview 的 body 读取若超限，转抛 `new PreviewError('too_large', { limit })`，两个机制不混用

#### 2.4.2 可选增益（不阻塞 M1）：共享 `HttpError` 基类

`PreviewError` 的形态（code + status + detail）对其它域同样成立。若评审通过，在 `route-context.ts`（既有「统一响应」约束的 owner）落一个 ~20 行基类，`RequestBodyTooLargeError` 作为第一个移民——**增量迁移，不强制其它域跟进**。不做也在此记录决策，避免下一个模块重新发明。

#### 2.4.3 前端：错误体解析 + 按码分叉（`preview/api.ts` + viewers）

```ts
// preview/api.ts —— 不用通用 jsonFetch（它把错误体丢成文本），自己保留解析后的 body
export class PreviewApiError extends Error {
  constructor(readonly code: PreviewErrorCode, readonly detail?: { limit?: number }) { super(code); }
}
```

| code | 前端行为（i18n key 进 `messages/preview.ts`） |
|---|---|
| `too_large` | 展示"超过 N 上限"（N 用 `detail.limit` 格式化）+ 提供下载入口 |
| `unsupported` | 该文件树行置灰 + FallbackViewer（下载 + 以文本查看） |
| `permission_denied` | 写回按钮禁用 + tooltip 说明当前为只读工作区 |
| `not_found` / `invalid_path` / `outside_workspace` | toast + 从树缓存移除该节点（文件被外部删除的常见路径） |
| `no_workspace` | dock 显示"先选择工作区"空态 |

- `PreviewErrorCode` 前端 union 与后端 `PREVIEW_ERROR_CODES` **手工镜像**（项目现有前后端契约即此模式，如 `web/src/types.ts`）；契约测试（§5）断言两边集合一致，防漂移

### 2.5 安全边界（全部既有机制，零新代码）

- 路径：`resolveWorkspaceRoot` → `resolveWorkspacePath` → `assertInsideRoot`，与 run 文件端点同链
- 鉴权/Origin：`route-context.ts` 的 `checkOrigin`/`requireAuth`，handler 入口照旧调用
- symlink 不跟随；忽略目录不枚举
- 只读优先：`permissionMode` 从当前 workspace 快照读取，`read-only` 档 POST 一律 403

---

## 3. 前端设计：`web/src/preview/`

### 3.1 文件结构

```
web/src/preview/
  api.ts               # preview API client（对齐现有 api.ts 的 jsonFetch 风格）
  types.ts             # 契约镜像（手抄自后端 types.ts，项目现有前后端契约即此模式）
  registry.ts          # ★ 扩展名 → viewer 的单一注册表（图标/标签/懒加载）
  PreviewDock/         # 停靠面板：标签栏 + 空态(树) + 开关 + 宽度拖拽/持久化
  FileTree/            # 目录树：懒加载展开/面包屑/过滤/忽略项开关
  viewers/
    MarkdownViewer.tsx # 文档级排版 + 相对图片重写
    PdfViewer.tsx      # pdfjs-dist 懒加载
    WordViewer.tsx     # mammoth 懒加载
    SheetViewer.tsx    # xlsx(SheetJS) 懒加载
    TextViewer.tsx     # txt/代码：行号 + 高亮 + 截断策略
    ImageViewer.tsx    # lightbox
    FallbackViewer.tsx # 415/渲染失败：类型徽标 + 下载 + 降级文本入口
  hooks/
    usePreviewTabs.ts  # 标签状态（开哪些文件/激活哪个/宽度），提升到 App 级
    useFileTree.ts     # 树的懒加载缓存（展开过的目录不重复请求）
    useLazyViewer.ts   # React.lazy + Suspense 封装，统一骨架屏
```

### 3.2 Viewer Registry（结构性的核心）

```ts
// registry.ts —— 新增文件类型只动这里 + 新增一个 viewer 文件
interface ViewerSpec {
  match: (fileName: string) => boolean;
  icon: FileIconName;
  labelKey: string;                      // i18n key
  load: () => Promise<{ default: ComponentType<ViewerProps> }>; // 动态 import
}

export const VIEWERS: ViewerSpec[] = [
  { match: isMarkdown, load: () => import('./viewers/MarkdownViewer') },
  { match: isPdf,      load: () => import('./viewers/PdfViewer') },
  { match: isDocx,     load: () => import('./viewers/WordViewer') },
  { match: isSheet,    load: () => import('./viewers/SheetViewer') },
  { match: isImage,    load: () => import('./viewers/ImageViewer') },
  { match: isText,     load: () => import('./viewers/TextViewer') },
];
// 未命中 → FallbackViewer（下载/降级）
```

- `match` 顺序即优先级（如 `.md` 先于通用文本）
- 图标与标签也从 registry 取，FileTree / 标签栏 / Fallback 三处消费同一来源

### 3.3 各 Viewer 要点

| Viewer | 库（懒加载） | 关键设计 |
|---|---|---|
| MarkdownViewer | 无（复用 `MarkdownText`+`MermaidBlock`） | **相对图片重写**：以文件所在目录为 base，`![](img/x.png)` → `/preview/file?path=<dir>/img/x.png`；文档级排版 CSS（标题层级/表格/代码块留白，对照截图 3） |
| PdfViewer | `pdfjs-dist@6.3.289`（与 root optionalDeps 同版本） | worker 走 `new URL('pdfjs-dist/build/pdf.worker.min.js', import.meta.url)`（vite ?url 处理）；**分页虚拟滚动**（可视页 ±1）；缩放/页码跳转；文本层默认关；渲染 throw → FallbackViewer + 降级文本入口 |
| WordViewer | `mammoth` | `convertToHtml` + `convertImage`（内嵌图 → data URI 内联，**不新增 zip-entry 端点**）；**输出 HTML 必须消毒**：mammoth 产物经 allowlist 清洗（script/on*/javascript: 一律剥）后再 `dangerouslySetInnerHTML`，或只用其结构化 JSON 自绘——二选一在 M3 定，默认前者 + 消毒；样式映射到文档主题；渲染失败 → 服务端 docx TSV 降级 |
| SheetViewer | `xlsx`(SheetJS) | `sheet_to_json` 按 sheet 渲染 HTML 表格 + **sheet 切换标签**；>2000 行虚拟化；数字/日期格式列宽自适应；CSV/TSV 顺带覆盖；失败 → 服务端 xlsx TSV 降级 |
| TextViewer | highlight.js（或 shiki，M2 定） | 行号；超 2MB 前端先拦（与后端 413 对齐提示）；大文件沿用 `read` 工具的首尾截断语义 |
| ImageViewer | 无 | 缩放/平移/适应；超 8MB 提示（后端 413 文案透出） |
| FallbackViewer | 无 | 415/渲染失败/legacy `.doc`：类型徽标 + 下载按钮 + "以文本查看"入口（office/pdf 类型可用，调服务端提取端点） |

### 3.4 Dock 与状态

- `App.tsx` 挂 `<PreviewDock>`；开关状态/激活标签/宽度存 localStorage（对齐现有外观设置持久化方式）
- 空态 = FileTree（对照截图 2：面包屑 + 刷新）
-  Timeline 里点文件 → `openPreview(path)` 进 dock（替换 `setViewingFile`）；窄屏（<阈值）退化为全屏覆盖层而非右侧停靠
- ⌘P 切换面板焦点；开始态放「工作区文件」入口卡片

### 3.5 i18n

- 新增 `web/src/i18n/messages/preview.ts`，注册进 `messages/index.ts`（照现有 app/common/shell/timeline 分域惯例）
- 所有用户可见文案（错误码透出、按钮、加载态、降级提示）必须进 messages，过 `tests/frontend-i18n-coverage.test.ts` 闸门

---

## 4. 集成改动清单（全部集成面）

| # | 位置 | 改动 | 量级 |
|---|---|---|---|
| 1 | `src/host/routes.ts` | +1 分发分支（preview） | 3 行 |
| 2 | `src/host/preview/` | 新模块三件 | 新增 |
| 3 | `src/host/routes/static-handler.ts` | `IMAGE_EXT_MIME` 旁扩文档 MIME 表（或 preview-service 自带，二选一，倾向后者避免动静态域） | ~10 行 |
| 4 | `web/src/App.tsx` | 挂 PreviewDock；`viewingFile` → `usePreviewTabs` | ~30 行 |
| 5 | `web/src/components/Timeline/` | 文件点击改 `openPreview` | ~10 行 |
| 6 | `web/src/i18n/messages/preview.ts` | 新文案域 | 新增 |
| 7 | `web/src/components/FileModal/` | **删除**（能力覆盖） | 删 |
| 8 | `web/package.json` | +3 devDeps… 实为 dependencies：`pdfjs-dist` `mammoth` `xlsx`（懒加载，不进首屏 chunk） | 3 行 |

---

## 5. 测试矩阵

| 层 | 用例 |
|---|---|
| Host 契约（`tests/` 新套件 `preview-api.test.ts`） | tree 懒加载/truncated/忽略规则；file 四类分发 + 大小上限 + 415；stat；写回 403(read-only)/200；**7 个错误码逐一触发**（每个 code 断言 HTTP 状态 + 响应体 `{error, ...detail}`）；`PreviewError.message === code` 不变量；非 PreviewError 的意外错误冒泡为 500 不吞 |
| 契约一致性 | 后端 `PREVIEW_ERROR_CODES` 与前端 union 集合一致（防漂移测试） |
| 前端单测 | registry 路由优先级；图片重写函数；截断策略；mammoth 消毒函数；**`PreviewApiError` 按码分叉**（too_large 展示 limit / unsupported 置灰 / permission_denied 禁写） |
| fixtures | `tests/fixtures/preview/`：最小 docx（含表格+内嵌图）/xlsx（2 sheet）/pdf（2 页）/md（含相对图片）/txt/大文件样本 |
| Playwright e2e | 树导航 → 各类型渲染断言 → 降级路径 → lightbox → 标签开关/宽度持久化 → i18n 双语抽查 → 超限文件走 FallbackViewer + 下载入口 |
| 闸门 | `frontend-i18n-coverage.test.ts` 必须通过 |

---

## 6. 分期实施（M1–M5）

| 阶段 | 内容 | 估算 |
|---|---|---|
| M1 | 后端 `src/host/preview/` + 契约测试 | 2–3 天 |
| M2 | Dock + FileTree + TextViewer/MarkdownViewer/ImageViewer + registry 骨架 | 1 周 |
| M3 | PdfViewer / WordViewer / SheetViewer + 消毒与降级 + fixtures | 1–1.5 周 |
| M4 | 集成（Timeline 指向、FileModal 退役、i18n、⌘P 入口）+ Playwright e2e | 2–3 天 |
| M5 | P3：SSE 文件变更自动刷新 + 轻量写回 | 3–5 天 |

每阶段独立可演示、可回滚；M2 结束即可替代 FileModal 上线（md/txt/图片先可用）。

---

## 7. 验收标准

1. 五类文档 + 图片 + 代码：正确渲染、超限提示、失败降级三条路径全通
2. **结构性证明**：现场新增一个 viewer 文件 + registry 一行即可支持一种新类型，无其他改动
3. 无 run/会话时预览面板独立可用
4. read-only 档：树可看、文件可读、写回 403
5. i18n 闸门 + 既有测试全绿；后端零新依赖；首屏 bundle 无增长（三库全部懒加载，构建产物 chunk 分析佐证）

---

## 8. 显式任务约束（给实施者）

- 大小上限只从 `attachment-policy.ts` import，禁止在 preview 模块内出现新的字节数常量
- 路径校验只调 sandbox-manager 现有函数，禁止 preview 模块内出现 `path.resolve` 直算
- 错误只以 `PreviewError`（code 身份）穿越 service→handler 边界；**禁止手写散文消息当错误**；未预期错误一律冒泡不吞
- `PREVIEW_ERROR_CODES` 是封闭集合：新增 code 必须同步 handler 映射、前端 union、i18n 三处，并有契约一致性测试佐证
- 忽略规则从 `src/tools/` 抽共享常量，preview 不得复制第二份
- mammoth HTML 未消毒不得进 `dangerouslySetInnerHTML`（M3 硬门槛）

---

## 9. 实施记录

### M1 后端（已完成）

- `src/host/preview/{types,preview-service}.ts` 与 `src/host/routes/preview-handler.ts` 落地；`src/host/routes.ts` 加一行 `preview` 分发；`src/host/workspace-browser.ts` 导出共享 `MAX_ENTRIES = 500`。
- 只读 GET：`/preview/tree`（单层 + truncated）、`/preview/file`（text/image/pdf/office 四类分发）、`/preview/stat`。§8 四条约束全部遵守（上限 import `attachment-policy.ts`、路径只走 sandbox-manager、忽略规则复用 `DEFAULT_IGNORED_DIRS`、错误只以 `PreviewError` 穿越）。
- 测试：`tests/preview-api.test.ts` **21 通过 / 0 失败**（7 个错误码逐一、413 带 limit、symlink 逃逸 403、截断 500、no_workspace 409、POST 404、`message === code` 不变量）。

### M2 前端骨架（已完成）

- `web/src/preview/`：`registry.tsx`、`api.ts`、`file-url.ts`、`rewrite-relative-images.ts`、`PreviewDock/`、`FileTree/`、`hooks/{usePreviewTabs,useFileTree}.ts`、`viewers/{TextViewer,MarkdownViewer,ImageViewer,FallbackViewer}`。
- `web/src/App.tsx` 挂载（ShellBar `actions` 插槽 + 面板开关），标签/宽度状态存 localStorage；`web/src/components/ShellBar/index.tsx` 仅加可选插槽，`icons.tsx` 仅加 5 个图标。
- 测试：`tests/frontend-preview-registry.test.ts` **18 通过 / 0 失败**（registry 路由、URL 编码统一、图片 title 保留、错误码分叉、sheet-utils 纯函数）。

### M3 PDF / Word / Excel（已完成）

- `PdfViewer`：`pdfjs-dist@6.3.289` 动态 import + `?url` worker；IntersectionObserver 虚拟页渲染、缩放步进、跳页；`task.destroy()` 收尾。
- `WordViewer`：`mammoth.convertToHtml(..., { convertImage: mammoth.images.dataUri })` → **DOMPurify.sanitize(USE_PROFILES:{html:true})** 后才进 `dangerouslySetInnerHTML`（§8 硬门槛遵守）。
- `SheetViewer`：`xlsx` `sheet_to_json({header:1, raw:false})` + 行虚拟化（`sheet-utils.ts` 纯函数，供无 CSS 单测）。
- 构建佐证（`npm run build:web`，7.34s）：7 个 viewer 各有独立 chunk，`pdf` 483 kB / `xlsx` 429 kB / `purify.es` 29 kB / pdf worker 均为独立懒加载 chunk，`dist/index.html` 只加载入口 `index-*.js` + CSS，首屏无增长。

### M4 集成（已完成）

- **Timeline 指向上游**：新增纯函数模块 `web/src/components/Timeline/tool-file-path.ts`（`extractToolFilePath` / `normalizePreviewTarget` / `baseName`），只接受"确定在工作区内"的相对路径；`/etc/passwd`、`../x`、`C:\…`、URL、glob 模式一律返回 null（宁可不出入口）。工具详情里出现"在预览面板中打开"按钮（`read/write/edit/moveFile/deleteFile` 等文件类工具；`glob/ls/grep/shell` 不给）。
- **附件入口**：`FileAttachment` 卡片加"预览"按钮，打开原件路径（`input/attachments/<前缀>-<name>`，本来就是工作区相对路径）——pdf/docx/xlsx 这类原先只能下载的 binary 附件因此可直接在面板里看。
- **标签状态提升**：`usePreviewTabs` 由 App 持有，`PreviewDock` 改为受控（`tabsApi`）；面板内 FileTree 与 Timeline 写同一组标签。`openPreview` 只依赖 hook 内稳定的 `open` 回调，避免破坏 `Timeline` 的 `memo`。
- **FileModal 退役**：删除 `web/src/components/FileModal/`（`setViewingFile(file)` 从未被调用，纯死代码）、App 里 `viewingFile` 状态与 5 处 `setViewingFile(null)`、`shell.file.*` 两条消息；`FileEntry` 仍由 `api.listFiles` 使用，保留。
- **⌘P / Ctrl+P** 切换面板（接管浏览器打印键；设置弹窗/工作区选择器打开时不抢）。
- 测试：`tests/frontend-tool-file-path.test.ts` **11 通过 / 0 失败**（接受/拒绝清单、字段优先级、JSON 字符串与截断串、工具白名单）。

### M4 补丁：会话级作用域 + 实机暴露的两个缺陷（已完成）

实机测试（第一次在浏览器里真用）暴露了三件事，全部已修：

1. **面板看不到文件（"空目录"）**。真机 Host 的 `GET /workspace` 是 `null` —— Host 的"当前工作区"是**进程内状态**，重启即丢；而用户只是点开一条历史会话看文件，于是 `/preview/tree` 返回 409。面板当时把非 `PreviewApiError` 的失败（HTML/解析/网络）当成"空目录"渲染，把故障伪装成正常空态。
2. **`/preview` 没进 Vite dev proxy**（`/runs`、`/workspace` 等都在，独独漏了它）：`npm run dev` 下 Vite 用 index.html 兜底 → 前端拿到 HTML → 同样是"空目录"。已补 `web/vite.config.ts`。
3. **会话工作区**：入口文案本来就是"浏览会话工作区的文件"，但实现只认 Host 当前工作区。现改为**会话级作用域**：
   - 后端：三端点接受 `?runId=`，handler 用 `RunManager.getWorkspaceRoot(runId)`（活跃 + 历史 Run 都支持，与 `/runs/:id/files` 同一信任模型）解析工作区根，交给 `preview-service` 的 `PreviewScope`；显式给了 runId 却解析不到 → 409 `no_workspace`，**绝不静默回落到当前工作区**（否则看 A 会话拿到 B 工作区的内容）。
   - 前端：`runId` 显式透传（`PreviewDock` → `FileTree`/`useFileTree`/viewers → `file-url` 的直链与查询串，含 Markdown 相对图片直链），不使用模块级可变状态；作用域 = 文件来源 Run（Timeline 点开的回合），缺省跟随当前会话，切换回合时归位。
   - 错误身份：新增 `PreviewTreeError = PreviewErrorCode | 'unknown'`，未知失败有独立文案；`no_workspace` 时面板里直接给"选择工作区"按钮（复用宿主既有选择流程）。

测试：`tests/preview-api.test.ts` **24 通过 / 0 失败**（新增 runId 作用域三条：跨工作区取树、解析不到 → 409 不回退、作用域下路径校验不放松）；`tests/frontend-preview-registry.test.ts` **20 通过 / 0 失败**（新增直链/查询串与 Markdown 图片继承 runId 两条）。

### M4 补丁 2：面板首页（"开始"视图）（已完成）

对齐 DSH 右侧面板首页的形态：面板打开时先给入口卡片，点卡片才进文件树。

- `web/src/preview/dock-home.ts`：卡片登记表（纯模块，供无 CSS 单测）+ `shortcutLabel(isMac)`（⌘P / Ctrl P）。
- **只登记"工作区文件"一张卡**（标题复用 `preview.tree.root`，副标题"浏览会话工作区的文件"，右侧快捷键胶囊）；**新建终端 / 浏览器明确不做**（面板只服务文件预览，与调研报告的范围收窄一致）。测试断言 `PREVIEW_HOME_ACTIONS` 恰好只有 `workspace-files` 一项，并对副标题做双语齐备检查。
- `PreviewDock` 增加 `view: 'home' | 'files'`：打开先首页；点卡片进文件视图；有文件被打开（含 Timeline/附件入口）自动切到文件视图；头部多一个"回到开始"按钮（仅在文件视图出现）。

### M4 补丁 3：面板形态对齐 DSH（已完成）

用户拿 DSH 的右侧面板当参照逐项对齐（参照截图：顶部标签条 + 路径栏 + 混排列表）：

- **标签条**：停靠标签分两类 —— "文件"（一个标签一棵独立目录树，各自记住浏览位置/过滤词）与"开始"（首页）；＋ 新建的是"开始"标签（新标签默认落在开始页）；点"工作区文件"卡片把**激活中的"开始"标签转成"文件"标签**（strip 上"开始"消失）；关掉最后一个标签回落到空态（strip 只剩"开始"入口）。状态机抽成纯模块 `web/src/preview/dock-tabs.ts`（增删/激活迁移/命名，单测覆盖）；非激活的目录树**保持挂载仅隐藏**，切回来不丢位置、不重拉数据。
- **路径栏**：面包屑独立成行、刷新按钮右置；根节点显示**真实工作区名**（后端 `/preview/tree` 响应新增 `workspace` 字段 = 根目录 basename——前端依旧拿不到宿主绝对路径，只拿名字）。
- **列表混排**：目录/文件按名称一起排（展示层重排；后端契约仍是目录在前），去掉文件夹右侧箭头；「显示忽略目录」挪进过滤行。
- 面板头部不再放"文件预览"标题文字（标签条即标题），换成 🏠（回到开始）+ ✕（关面板）。

测试：`tests/preview-api.test.ts` 24 通过（含 workspace 字段断言）；`tests/frontend-preview-registry.test.ts` **26 通过 / 0 失败**（新增浏览标签状态机 3 条）。

### M4 补丁 4：open-in-app 架构化 + 变更流自动刷新（M5 前半提前落地）

按 DSH 参考实现重做了「在工具中打开」，并落地变更流：

- **应用列表 = Host 机器级探测，客户端只渲染**：`catalog.ts` 固定清单（30+ 应用 × 各平台定位方式：app-bundle 候选名 / PATH / win-path / 注册表 / desktop-entry）；`resolver.ts` 逐条证明装机（扫 /Applications、PATH X_OK、reg.exe、XDG），每进程缓存一次即权威，open 撞 ENOENT 单条目重解析；三路由 `GET /open-in-app/apps`、`GET /open-in-app/icon/<id>`（macOS plutil+sips 从 .app 提 PNG）、`POST /open-in-app/open`（detached + scrubbed 环境 + 300ms 早期失败观察窗）。前端 `open-in-app.ts` controller：页载读一次、选择记 localStorage（选中项标「（默认）」）、只渲染与 POST。原 `/workspace/open-in`（4 个硬编码目标）删除。
- **变更流**：`GET /preview/changes?runId=` SSE；`changes.ts` 每根一个 `fs.watch`（recursive）+ 400ms 去抖批次；Linux 无递归 → 降级手动刷新。
- **预览自动刷新**：面板订阅变更流，批次命中已开文件标签 → 该 viewer 重挂载重取（版本失效即弃旧重走）；目录列表收到批次即刷新当前层；图片/PDF 挂载级缓存破坏。真机验证：外部 append README → SSE 推送 → 预览自动出现新内容。

与参考实现的偏差：Office 走前端直解析（mammoth/xlsx），不做 Host 转 PDF；agent 编辑侧的 FS_STALE_VERSION 守卫未实现（属 Runtime 工具语义，另立任务）；「文档预览列表 = OS 按文件类型返回关联应用」未做（本面板是工作区级，非单文件级）。

### M4 补丁 5：右上角三步交互序列对齐（已完成）

用户拿真机截图按顺序说明右上角入口的交互（① 点 ◧ 开面板 → ② 点"工作区文件"卡片 → ③ 点 ＋），要求复刻：

- **标签状态机升级为两类停靠标签**：纯模块 `browser-tabs.ts`（只有"文件"一种、初始恒有一个）重写为 `web/src/preview/dock-tabs.ts`（`DockTabKind = 'home' | 'browser'`，初始**空**集）。文件标签（Word/PDF…）仍归 App 层 `tabsApi`，strip 顺序 = 停靠标签 + 文件标签 + ＋。
- **① 空态**：`tabs: []` → strip 只有一个"开始"入口（`.homeEntry`：无激活胶囊、无 ×、**不显示 ＋**），正文是首页卡片。首页依旧**只有"工作区文件"一张卡**（终端/浏览器不做）。
- **② 点卡片**：`openFilesTab()` 把**激活中的"开始"标签转成"文件"标签**（同一页签内导航，strip 上"开始"消失 → `[文件 ×][＋]`）；没有激活的"开始"标签（空态/已在文件标签）才新建一棵目录树。
- **③ 点 ＋**：`addStartTab()` 新建一个**"开始"标签**并激活（新标签默认落在开始页 → `[文件][开始 ×]`），不再是"文件 2"。从新的"开始"标签点卡片，它再转成"文件 2"——多棵目录树的玩法不变。
- **关闭**：关掉最后一个停靠标签 → 空集（回 ① 的首页占位）；关激活标签迁移到右邻/左邻；正在看文件时关后台标签不打扰视图（`activeKind` 只在 `activePath` 变化时被 effect 纠正，`dockTabs` 变化不拽回文件视图）。
- × 仍渲染在每个停靠标签上（参考实机只在激活标签上显示 ×，这里保留"全部可见"：关闭后台标签是常用操作，不为像素一致牺牲可用性）。

测试：`tests/frontend-preview-registry.test.ts` 停靠标签用例从 3 条扩到 7 条（空态/转签/追加/＋/关闭迁移/关光/命名）；`tests/run-all.ts` 117 套件全绿；`web` `tsc -b && vite build` 通过。

### M4 补丁 6：PDF 预览页面挤压修复（真机反馈）

真机验收发现 PDF 预览"效果很不好"：中文字符糊成一团、部分行呈碎裂乱码状。

- **根因**：canvas 同时被设置了行内 `style.width/height`（= 页面原始尺寸 × zoom）与 CSS `max-width: 100%; height: auto`。容器窄于页面时宽度被 CSS 压窄、行内高度（优先级更高）不跟着缩 —— A4 页（615×870）被显示成 385×870，**横向挤压 37%**，字形互相重叠即成"乱码"。实测复现：`cssRatio 0.443` vs 正确的 `0.707`。
- **修法**：显示尺寸一律由 JS 算准后写成行内样式，**不再给 canvas 任何 CSS 缩放**（`max-width/height:auto` 删除）。布局规则抽成纯模块 `web/src/preview/viewers/pdf-layout.ts`（`computePageLayout`）：以「适配容器宽度」为基准 × zoom，宽高从同一个 scale 推出，**比例恒等于页面原始比例**。
- **顺带修正的两处**：① 占位高度不再硬编码 A4 宽高比，改为文档加载时逐页读真实 viewport（混合方向/非 A4 文档也不会错位）；② zoom 语义从"绝对缩放"改为"相对适配宽度"（100% = 铺满容器，窄面板里默认就能看全，放大出横向滚动条）——与常见 PDF 查看器一致。
- **验证**：playwright（系统 Chrome，deviceScaleFactor=2）驱动真机 app 量化——修复前 `attr 1230×1740 / css 385×870`，修复后 `attr 774×1093 / css 387×547`，比例 0.708 全程一致，200% 下等比翻倍；5 页文档虚拟渲染、页码同步正常。回归测试 4 条（`computePageLayout`）守住"宽高同源、比例不变"。

### M4 补丁 7：去掉预览大小上限（真机反馈）

真机预览 9.4MB docx 被"文件超过 8.0 MB 上限"挡住。用户明确要求："这个限制去掉，不要加。"

- **只动预览域，不动附件上传**：上限常量本就在 `src/attachment-policy.ts`（附件上传与预览共用），
  上传侧的上限保留；预览侧 `preview-service.ts` 的 `readFile` 不再做大小校验，
  `categorize` 的 `maxBytes` 字段与 4 个 `MAX_*_BYTES` import 一并移除。
- **`too_large` 错误码整套摘除**（预览域不再产生它，留着即死代码）：后端
  `PREVIEW_ERROR_CODES`/`CODE_STATUS`、前端镜像 `web/src/preview/types.ts`、
  `api.ts` 的码集合与 `PreviewApiError.detail`、`FallbackViewer` 的 reason 分支、
  i18n `preview.viewer.reason.too_large`；6 个 viewer 的 `detail: {limit}` 失败态管线同步清掉。
  错误码集合 7 → 6（两侧测试断言同步）。
- 代价（已在代码注释里写明）：host 整文件读入内存后吐给浏览器，几十 MB 无压力；
  真正超大文件由浏览器/解析器自然失败，走 FallbackViewer 下载兜底——不再前置拦截。
- 真机验证：9.4MB docx（含 35 张内嵌图）HTTP 200 全量返回、**1.5s** 渲染完成、35 图全部 inline；
  小 docx 0.5s 正常。回归：`tests/preview-api.test.ts` 新增"超旧上限的大文件也返 200"用例，
  `tests/run-all.ts` 117 套件全绿 + web build 通过。

### M4 补丁 8：文件预览操作栏（路径 + 刷新 + 在应用中打开）

真机参照 DSH 的文件预览形态，在文件视图顶部加一条窄栏：

- **`web/src/preview/FileActionBar.tsx`**（+ 私有 CSS）：左侧等宽字体显示**工作区相对路径**
  （宿主绝对路径不出前端，与 /preview 的安全立场一致；要定位到机器上的位置用右侧动作），
  右侧两个动作 —— **刷新**（`manualReload` 令牌并入 viewer key → 重挂载重取）与
  **"在应用中打开"分段胶囊**（默认应用图标 | ⌄，默认应用 = localStorage 记忆，否则列表首个）。
- **后端 `POST /open-in-app/open` 扩可选 `path`**：给出即打开工作区内的**该文件**（此前只能开
  工作区根，ShellBar 入口胶囊的语义不变）。路径校验复用 preview 域的 `resolveChecked`
  （从 preview-service 导出，**单一实现**）——`..` 穿越 / symlink 逃逸在应用查找之前就拒。
- **菜单抽成共享组件 `OpenInAppMenu.tsx`**：Launcher 与操作栏共用（装机列表 / 真图标 /
  默认应用记忆 / 单条目重解析都在原有 controller 与 Host，零重复）；`useClickOutside`
  增加 `ignoreRef` 参数——触发按钮不再被"点外部"抢先关掉，toggle 行为修正。
- 新增 `tests/open-in-app.test.ts`（6 条：apps 列表、缺 id、开工作区根、合法 path 到达应用
  阶段、`..` 拒、symlink 逃逸拒；用不存在的 app id 收尾，**不真启动任何应用**）。
- 真机验证：9MB docx 上三件套齐备；刷新触发重新请求；点默认应用（访达）→ 200
  `{"opened":true,"id":"finder"}` 且 Finder 真起来；菜单列访达（默认）/Cursor/IntelliJ IDEA 带真图标。

### M4 补丁 9：open-in-app 按文档后缀过滤可用应用

真机反馈：PDF 的"在应用中打开"菜单列出 Cursor / IntelliJ IDEA——代码编辑器打不开 PDF，
列表没有信息量。要求"根据文档后缀自动识别宿主机有哪些应用可以打开预览文件"。

- **能力声明进 catalog**：`AppCatalogEntry` 新增 `opens: OpenableKind[]`
  （`folder/pdf/image/word/sheet/slides/text/any`；`any` = 访达这种不挑的，
  `folder` = 终端/IDE 只对文件夹有意义）。原 16 个条目全部补齐声明。
- **补全文档类应用**（此前清单只有编辑器/IDE/终端 + 访达，PDF 只能挑出访达）：
  Safari / Chrome / Firefox / Edge（pdf+image+text）、**预览**（pdf+image）、
  文本编辑（text）、Microsoft Word/Excel/PowerPoint（各自 office 类）、
  WPS Office（word+sheet+slides 三态）。装机与否仍由 resolver 逐条证明。
- **纯模块 `src/host/open-in-app/openable.ts`**：`openableKindForPath`（后缀 → 类别；
  文本/代码类后缀表与无扩展名特知名称**复用 attachment-policy 导出的
  TEXT_EXTENSIONS/TEXT_NAMES**，不复制第二份）+ `filterAppsForTarget`（文件夹目标取
  folder/any，文件目标取该类别/any）。未识别后缀（.zip）只剩访达。
- **端点过滤**：`GET /open-in-app/apps?path=<rel>` 按目标返回（缺 path = 工作区根的
  文件夹语义，ShellBar 入口胶囊不受影响）；响应带 `opens` 供契约断言。
- **前端按目标缓存**：`listOpenInApps(path)` 换目标即换列表；状态抽成
  `hooks/useOpenInApps.ts`（Launcher 与操作栏共用，含图标 404 回退）；
  `OpenInAppMenu` 改为纯展示（apps/loadFailed 由父级传入）。
  默认应用在**过滤后的列表**里选（localStorage 记忆不在列表里则让位给列表首个）。
- 测试扩到 10 条：类别判定（含大小写/无扩展名/未识别）、过滤矩阵
  （文件夹/PDF/docx/代码/zip）、端点按 path 过滤（逐条断言 opens 含目标类别或 any）。
- 真机验证（本机）：`pdf → [访达, Safari, Chrome, 预览]`、`docx → [访达, WPS Office]`、
  `ts → [访达, Cursor, IntelliJ IDEA, Safari, Chrome, 文本编辑]`、`zip → [访达]`、
  文件夹 → [访达, Cursor, IntelliJ IDEA]；docx 菜单 UI 实测只剩访达 + WPS Office。

### M4 补丁 10：打开方式改为"问操作系统"（对齐参考实现）

参考实现点明关键分工：**目录**用编译期白名单（系统没有"用某 App 打开目录"的统一
关联机制），**文件**每次现问操作系统（文件关联是系统事实，静态清单只会猜错——
上一版 PDF 菜单里出现 Cursor 就是猜的代价）。本轮把文件目标切成真查询。

- **新模块 `src/host/open-in-app/os-assoc.ts`（macOS 适配器）**：内嵌一段**固定** JXA
  脚本，`osascript -l JavaScript -e <脚本> <路径>` 跑 NSWorkspace：
  `URLsForApplicationsToOpenURL`（列表）+ `URLForApplicationToOpenURL`（默认项）。
  - 路径只经 argv 传入（不经 shell、不插脚本文本）；只读关联，绝不改系统默认；
  - **图标**：直读 bundle 内 icns 走 ImageIO 缩略图（32px，~10ms / ~1.5KB）——
    曾实测 `NSWorkspace.iconForFile` 的 TIFFRepresentation 会把整张 1024px 图标
    光栅出来（74MB / 190ms），只为 32px 缩略图代价荒谬，故列为兜底；
  - **去重**（同参考实现）：同 bundleId + 同显示名折叠一条——自更新 App 会留多份
    拷贝（本机 3 份 LibreOffice：codex / TRAE / MiMo 各带一份），保留默认项、
    否则版本最高的；
  - selector 坑记录：JXA 对以缩写开头的方法名**保留大写**（`URLsForApplications…`，
    小写 `urls…` 是 undefined）；CF 函数返回的 Ref 无法直接枚举，故全走 ObjC 方法。
- **端点分流**：`GET /open-in-app/apps?path=<rel>[&runId=]` —— 文件目标问系统
  （拿不到/非 macOS → 回落 `openable.ts` 白名单过滤），目录目标恒走白名单；
  响应带 `source: 'os' | 'catalog'`。
- **安全边界**（对齐参考实现）：`POST /open-in-app/open` 的文件目标**打开前用最新
  系统列表复验 id**（伪造/陈旧的 .app 路径拒掉）；新增 `action: 'reveal'`
  （`open -R` / `explorer /select` / `xdg-open`，即"显示文件位置"，文案不点名访达）。
- **前端**：`OpenInApp` 带 `icon`（dataURL）/`isDefault`；`listOpenInApps` 改按
  「runId+路径」缓存并加 10s TTL（展开菜单重查 → 新装应用很快出现）；菜单直接渲染
  dataURL 图标、按系统默认标记「（默认）」，文件目标末尾多一项"显示文件位置"。
- 测试扩到 12 条：端点按来源分流断言（os 形状 vs catalog 形状）、真机
  `queryFileAssociations` 结构断言、reveal 缺 path 400、伪造 id 400。
- 真机验证：docx 菜单 = wpsoffice（默认）+ Pages/TextEdit/WorkBuddy/ChatGPT/
  LibreOffice×2 + 显示文件位置，全部真图标；单次查询 ~0.5s、图标合计 13KB。
  Windows / Linux 暂无适配器 → 自动回落白名单（`openable.ts` 的分类型过滤，
  见下方「平台缺口」）。

### M4 补丁 11：操作栏胶囊显示系统默认应用图标（真机反馈）

真机反馈：文件预览操作栏"在应用中打开"**胶囊左段显示的是通用文件图标**，
而展开菜单里同一个应用（WPS）却有真图标——两处图标来源不一致。

- **根因**：胶囊图标走 `openInAppIconUrl(id)` → `GET /open-in-app/icon/<id>`
  端点。但补丁 10 之后文件目标的列表来自**问操作系统**（`source: 'os'`），
  id 是 `/Applications/X.app` 这种路径，**不在白名单里 → 端点 404** →
  `<img>` `onError` 回退字形。而列表响应里其实就带着系统给的 32px PNG
  dataURL（`app.icon`），胶囊没用它。
  另有第二处不一致：`defaultAppId()` 只认 localStorage 记忆 / 列表首个，
  **不认系统返回的 `isDefault` 标记**，所以"默认那一个"也可能选错。
- **修复**（纯前端 `web/src/preview/`，后端零改动）：
  - 胶囊改读 `app.icon`（dataURL）直接渲染，与菜单**同源**；
  - 默认项解析改为系统 `isDefault` 优先；
  - 抽出两个纯函数到 `open-in-app.ts`，三个调用点（`FileActionBar` /
    `OpenInAppMenu` / `Launcher`）统一调用，消除此前各写一份的分叉：
    - `effectiveDefaultId(apps)`：系统 `isDefault` → localStorage 记忆 → 列表首个；
    - `openInAppItemIconUrl(app, broken)`：`app.icon` dataURL → `/icon/<id>`
      （白名单来源）→ `null`（调用方回退字形芯片）。
- 验证：`tsc -b` + `vite build` 通过；真机 docx 胶囊左段显示 WPS 真图标。

### M4 补丁 12：用户消息图片附件对齐 DSH Message Images 变体规范

真机反馈多轮迭代后定型。前几版先后试过"固定 132px 方图"→"按原比例 ≤420px"→
"多图 112px 缩略阵"，都不对：DSH 的做法是**固定盒 + 比例夹紧 + cover 裁切**，
尺寸只由「变体 + 原图 intrinsic 宽高」决定，与视图宽度、容器查询、响应式无关。

**变体分派**（唯一的尺寸决策点，对应 DSH `MessageImage.tsx:178` 同一条件）：

| 变体 | 触发 | 显示尺寸 | 裁切 |
|---|---|---|---|
| `single` | 单张图、非 compact | `singleFit()`：长边 240 基准，渲染宽高比先夹紧到 `[0.25, 4]`，**从不放大**（小图按原始像素显示），结果取整且每边 ≥1 | `cover`；锚点极高图 `center top`、极宽图 `left center`、其余 `center` |
| `tile` | compact，或组内多于 1 张 | 固定 **64×64** | `cover` 居中 |
| `thumbnail` | 调用方显式要求 | 固定 **48×48** | `contain` 不裁（DSH 的 Trajectory 附件行用它；本仓暂无消费方，保留契约） |

尺寸数值不是估的：48/240 是用 Pillow 量用户提供的 DSH 截图得到的（2x 截图上
缩略图 97×97 图像 px = 48.5 CSS px；单图卡片宽 478 图像 px = 239 CSS px），
64px 来自 DSH 包内 `dsh-client-ui-attachment/README.zh.md` 的原文。

**compact 判定用附件总数而不是图片数**（DSH `MessageItem.tsx:185`）：1 张图 +
1 个文档时那张图也是 64px 方格。前几版只数图片数，这里不对。

**Host 侧补图片宽高**（消掉与 DSH 的最后一处差异）：DSH 的尺寸来自落库附件引用
`attachment.width/height`，图片加载前就知道；本仓此前没有，只能在 `<img>`
onLoad 里探测，首帧会跳一下。改动其实很小——`normalize.ts` 早就算出归一化后的
宽高（EXIF 已应用）、`publish.ts` 也已经在用它组装给模型的 `attachmentImages`，
缺的只是没写进 UI 那份 `run_started.attachments`：

- `publish.ts`：图片附件的视图里带上 `width`/`height`/`originalDimensions`
  （与 `attachmentImages` 同一份数值，不重算）；
- `HostAttachment`（`src/host/run-events.ts`）与 `RunAttachment`（`web/src/types.ts`）
  同步扩字段；
- 前端新增纯函数 `singleBox()` 定**来源优先级**：Host 宽高 → onLoad 探测 →
  240×240 兜底。历史事件缺字段时才走探测，正常路径第一帧即最终尺寸。

**结构**：尺寸决策抽成 `web/src/components/Timeline/message-image.ts`（纯函数：
`messageImageVariant` / `singleFit` / `squareBox` / `singleBox`），组件
`MessageImage.tsx` 只做测量与渲染。尺寸不靠 CSS 宽高，而是写成盒子上的
inline style，`<img>` 恒 `100%×100%`（CSS 里 `cover` 居中裁，thumbnail 变体
改 `contain`）；加载态与失败态沿用同一个尺寸盒 + 重试按钮，文案变长不会撑大布局。

**其余**：附件容器 gap 8 → 10px（对齐 DSH）、附件移到用户文字气泡**之前**
（先看到带了什么，再读要它做什么）、文字气泡改 `fit-content` +
`margin-left:auto` 不再被附件那一行撑宽、提取说明（"PDF 为简易提取…"）不再
渲染（卡片自带预览入口；Host 仍照旧产出 `extraction.message`——那是模型可见的
附件清单内容）、文件卡片按类型着色图标（PDF 红 / Word 蓝 / 表格绿 / 幻灯片橙 /
图片蓝，图标取自新增的共享模块 `components/file-kind.tsx`，`registry.tsx` 改为
import 后原样再导出）。

**测试**：新增 `tests/frontend-message-image.test.ts`（20 条：常量契约、变体分派、
`singleFit` 的小图不放大/长边 240/夹紧与锚点/兜底/整数与 ≥1/长边不超 240、
`singleBox` 来源优先级）、`tests/text-attachments.test.ts` 补发布断言（图片视图带
宽高、文本附件不带）。真机几何复核（1400 / 420 视口）：单图 240×160、小图 120×80、
竖图 60×240、宽图 240×60、tile 64×64 同一行、`img` 撑满盒子、均无溢出。

### M4 补丁 13：胶囊默认应用按当前列表校验，记忆不再悬空

真机现象：工作区胶囊左段回退成**通用文档图标**，展开菜单里访达 / Cursor /
IntelliJ IDEA 三项**都没有「（默认）」后缀**。

根因不在图标，在默认项算不出来：`defaultAppId()` 原是
`getSelectedAppId() ?? apps[0]?.id`，**不校验记忆值是否还在当前列表里**。而记忆键
`payaso.openInApp` 是两个目标共用的，两边 id 空间并不通用——目录目标是白名单 id
（`finder`），文件目标是系统 `.app` 路径（`/Applications/WPS Office.app`）。
给 PDF 选过打开方式后，那个 `.app` 路径存进同一个键，回到目录目标时
`apps.find(app => app.id === 记忆值)` 恒为 `undefined` → `selectedApp = null`
→ 图标回退 `FileIcon`、菜单无任何项标默认。

- **列表内校验**：记忆值不在当前列表就让位给列表首个。列表本身也会随装机 / 过滤
  变化，所以悬空不止跨目标才发生。
- **记忆按作用域分键**（`folder` / `file`）：`scopeOfTarget(path)` 由目标推导，
  `OpenInAppMenu` 按 `path` 决定读写哪个键。给文件选打开方式不再顶掉胶囊的默认应用。
- 旧的未分域键里的悬空值无需清理——校验这一层已让它无害。

**测试**：新增 `tests/frontend-open-in-app.test.ts`（11 条：记忆为空 / 命中 /
悬空各自的结果、两套键互不覆盖、`scopeOfTarget` 推导、`isDefault` 优先于记忆、
空列表返回 `null`、localStorage 被禁时隐私模式不抛错）。

### 平台缺口：Windows / Linux 的 open-in-app 适配器（**未实现**）

> 这是本轮**明确的未完成项**，不是遗漏。功能层面 Windows / Linux 可用（自动回落
> 白名单过滤），但**精度不如系统查询**，与 macOS 不对等。

现状：补丁 10 的"文件目标问操作系统"**只有 macOS 适配器**（`os-assoc.ts` 内嵌
JXA + NSWorkspace）。在 Windows / Linux 上 `queryFileAssociations()` 直接返回
`null`，端点自动回落到补丁 9 的白名单过滤（`openable.ts` 按后缀分类型）。

**回落后的行为差异**（相对 macOS）：

| | macOS（问系统） | Windows / Linux（回落白名单） |
|---|---|---|
| 列表来源 | LaunchServices 实时关联 | 编译期 `catalog.ts` + `opens` 声明 |
| 新装应用 | 立刻出现（10s TTL 重查） | 只有清单里声明过、且 resolver 探测到装机才出现 |
| 默认项 | 系统真实默认（`isDefault`） | 无系统默认 → localStorage 记忆 / 列表首个 |
| 图标 | bundle icns 直读，真图标 | 走 `/icon/<id>` 端点（现为 macOS plutil+sips；Win/Linux 无提取实现 → 字形回退） |
| 未声明后缀 | 仍能列出系统认得的所有应用 | 只剩"不挑类型"的条目（如访达类） |

**未做的原因**：本轮只在 macOS 本机验证过。Windows / Linux 适配器无法在开发机
真机验证，按项目"不盲写无法验证的平台代码"的立场暂缓——宁可不写，也不提交一段
只有编译期正确、运行语义未知的实现。

**要补的话，两端的正确姿势**（已调研，待实现）：

| 平台 | 数据源 | 要点 |
|---|---|---|
| **Windows** | `SHAssocEnumHandlers` / `AssocQueryString`（shell32） | 由扩展名拿关联 ProgID → 枚举 handlers。Node 侧无现成 API，需 PowerShell + `Add-Type` 内联 C#（或原生 napi 模块）。**必须一并实现"打开前用最新列表复验 id"的安全边界**（与 macOS 对齐），以及从 `.exe`/`.lnk` 提图标（`SHGetFileInfo`）。 |
| **Linux** | GIO（`gio mime`）+ XDG desktop entries | `gio mime <mime-type>` 拿默认项与候选；mime-type 由 `xdg-mime query filetype <path>` 或后缀映射得到。desktop entry 的 `Exec=` 解析要处理 field codes（`%f`/`%u`）与引号转义，**路径绝不能进 shell**（沿用 `execFile` + argv）。 |

实现时**保持现有分层与契约不变**：新增 `os-assoc-win.ts` / `os-assoc-linux.ts`，
`queryFileAssociations` 按 `process.platform` 分派，返回同一 `OsAssocApp` 形状
（`id` / `label` / `isDefault` / `icon?`）→ **前端零改动**；图标字段缺省即回落字形芯片。

### 待做

- **open-in-app 的 Windows / Linux 适配器**（本轮明确的未完成项）：现状回落白名单过滤，
  精度不如 macOS 的系统查询。数据源、安全边界与分层约束见上方「平台缺口」一节。
- **图片附件的原图灯箱**：DSH 点击消息图片打开文档级 `ImageLightbox`（`max-width:
  min(100%, 1600px)` + `object-fit: contain` + 40px stage 内边距，不放大不裁切），
  本仓当前是 `<a target="_blank">` 新标签页打开原件。真机反馈是尺寸/排列问题，
  灯箱这层未做。
- **M5 剩余**：轻量写回（编辑保存）；agent 编辑侧 FS_STALE_VERSION 守卫。
- **Playwright e2e**：`web/package.json` 有 `playwright` 依赖但仓库内**没有任何 e2e 配置或 spec**（无 config、无脚本），补这套等于新建一套测试基础设施（还需下载浏览器二进制 + 起 Host + fixtures）。本次先不引入：前端行为由纯函数单测（registry 路由 / URL 编码 / 图片重写 / 路径提取）+ 构建产物 chunk 分析覆盖，交互部分走下面的手动清单。**若要多这一层，需单独确认。**

### 手动验收清单（交给用户）

1. 顶栏文件图标 / `⌘P`：面板开合，宽度拖拽后在刷新后保持。
2. 面板内 FileTree：逐级展开（每次只请求一层）、忽略目录开关、过滤框、截断提示。
3. `md`（含相对路径图片）、`png/jpg`（缩放/拖拽）、`pdf`（滚动虚拟渲染 + 跳页 + 缩放）、`docx`（含表格/内嵌图，且样式未被 DOMPurify 清空）、`xlsx`（多 sheet 切换 + 行列表头）、`txt`/代码（行号）、无扩展名文件。
4. 已知二进制（zip）→ 415 提示；**预览已无大小上限**（补丁 7 移除 `too_large`），超大 docx（约 9MB）应正常 200 渲染。
5. Timeline：工具行展开 → "在预览面板中打开"；附件卡片 → "预览"；两者都进同一个标签集合。
6. 英文界面切换后新增文案（`timeline.tool.openPreview` 等）显示为英文。
7. 文件操作栏：路径 + 刷新 + "在应用中打开"胶囊——**胶囊左段显示系统默认应用的真图标**（补丁 11），展开菜单与胶囊图标一致，菜单末尾有"显示文件位置"。
8. 用户消息里的图片附件：单张按原比例显示且**长边 ≤240px**（小截图保持原尺寸不放大），同一条消息附件多于 1 个时图片降级为 64px 方格、与文件卡同排；图片下方不再出现"PDF 为简易提取…"那段说明。
9. 工作区胶囊（顶栏预览入口）：左段显示默认应用的真图标，展开菜单里默认那项带「（默认）」后缀——给某个 PDF 选过打开方式之后，回到这里**不应该**退化成通用图标（补丁 13）。

### 2026-10-18：收起后重开保留预览状态（用户已确认推送）

- 根因：App 用 `previewOpen && <PreviewDock>` 条件挂载，收起时整个面板被卸载，
  停靠标签、当前目录、筛选词和 viewer 状态随之销毁。
- 改为首次打开后保持挂载，开合只控制 `hidden`；CSS 显式覆盖面板的 flex 显示规则。
  「关闭预览面板」保留状态，标签上的「×」仍真正关闭标签。
- 文件浏览页在切到开始页或文件 viewer 后也保持挂载。重开面板时只刷新当前目录，
  保留列表 DOM 与滚动；真正切换目录时才新建列表。隐藏时暂停变更流订阅。
- 作用域切换由文件树重新加载新工作区根目录，避免重开刷新拿旧目录抢占根目录请求。
  PDF 的 ResizeObserver 忽略隐藏时的零宽测量，保留缩放、分页布局与阅读位置。
- 本地独立数据验收：目录 documents、筛选 note、滚动 675px 在收起/重开前后完全一致；
  PDF 的 150% 缩放、页码与滚动位置保留；跨工作区切换正常；关闭最后一个标签后回开始页。
  130 个确定性套件通过，根类型检查、前端生产构建及 Biome error 门禁通过。

### 与设计稿的偏差

- 图片重写与 `/preview/file` URL 编码抽到 `file-url.ts` 统一（原设计散在两处，实现时发现 `URLSearchParams` 的 `+` 与 `%20` 漂移会导致图片 404）。
- `registry.tsx` 保持单文件（曾尝试把纯逻辑拆成 `registry.ts` 以便测试静态 import，但根 `npx tsc --noEmit` 会连带解析其懒加载的 `.tsx`，故改为在根 tsconfig 开 `"jsx": "react-jsx"` + 新增 `tests/ambient-web-assets.d.ts` 声明 CSS Modules / `?url` 资源；registry 的"新增类型只加一行"契约因此保持不变）。
- 根 `tsconfig.json` 加 `"jsx": "react-jsx"`、新增 `tests/ambient-web-assets.d.ts`（CSS Modules / `?url` 声明）：根类型检查本就会顺着 `tests/` 的 import 编译 web 模块，之前没有任何 `.tsx` 被测试引用所以没暴露；这两处是让既有闸门继续可用的最小补充，`tsconfig.build.json` 只包含 `src/**/*.ts`，产出不受影响。
- M4 的"Timeline 指向"落在工具详情里的显式按钮，而不是把工具行整行改成"点路径即预览"：工具行本身已经是 `button`（点开技术详情），内部再嵌按钮是非法 HTML；附件卡片则直接加"预览"按钮（不替换原有的内联 `<pre>` 预览，既有行为零改动）。
