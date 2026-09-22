---
name: pdf-official
description: PDF 处理工具集（Node 生态：pdfjs-dist 提取 + pdf-lib 变换）。分诊/提取/合并/拆分/旋转已可用；表格、OCR、表单、生成等能力待迁移。附件 PDF 提取 partial/failed、或需处理原件时使用。
version: 2.0.0
---

# PDF skill

基于 Node 生态（`pdfjs-dist` + `pdf-lib`，均为宽松许可）的 PDF 工具集，
随 PayasoAgent 项目 `optionalDependencies` 分发，脚本用 `node` 直跑——沙箱工具链
白名单只放行 `node/git/npm`，Node 脚本天然可达（详见 `docs/sandbox/sandbox-mental-model.md`）。

## 能力状态

| 能力 | 脚本 | 状态 |
|---|---|---|
| 分诊（页数/加密/表单字段/扫描） | `survey.mjs` | ✅ Node（pdfjs） |
| 纯文本提取（含中文 Type0/ToUnicode） | `text_dump.mjs` | ✅ Node（pdfjs） |
| 合并多个 PDF | `combine.mjs` | ✅ Node（pdf-lib） |
| 拆分（按范围/逐页/固定块） | `carve.mjs` | ✅ Node（pdf-lib） |
| 旋转页面 | `reorient.mjs` | ✅ Node（pdf-lib） |
| 表格/坐标级文本 | — | ⏳ 待实现（pdfjs 坐标自拼） |
| 表单探测/填充/覆盖文本 | `probe_fields.py` `apply_values.py` `overlay_text.py` | ⏳ 原 Python，沙箱不可达，待迁移 pdf-lib |
| OCR（扫描件） | `recognize.py` | ⏳ 原 Python，待迁移 tesseract.js |
| 页 → 图片渲染 | `render_pages.py` | ⏳ 原 Python，待迁移 canvas |
| 完整性校验 | `sanity_check.py` | ⏳ 原 Python，待迁移 pdf-lib |

**只调用标记 ✅ 的 Node 脚本**；⏳ 项当前在沙箱里跑不起来（Python 解释器 `python3` 不在工具链白名单，
Homebrew 二进制「能读不能执行」），不要尝试，明确告知用户该能力暂未提供即可。

## 按动词路由任务

| 任务 | 脚本 |
|---|---|
| 探测 / 分诊 | `node scripts/survey.mjs 文件.pdf --pretty` |
| 提取纯文本 | `node scripts/text_dump.mjs 文件.pdf [--out out.txt] [--select 1-3,5]` |
| 合并 | `node scripts/combine.mjs A.pdf B.pdf --out out.pdf [--preserve-metadata FIRST\|NONE]` |
| 拆分 | `node scripts/carve.mjs 文件.pdf --by-range 1-3 4-6 --dest DIR/` |
| 旋转 | `node scripts/reorient.mjs 文件.pdf --angle 90 --targets 1,3-5 --out out.pdf` |

脚本路径相对 skill 目录：`.payaso/skills/pdf-official/scripts/`。

## 与内建附件提取的衔接

Host 在附件入库时已对 PDF 做过提取（内建 `pdf.js`：手写快路径 + pdfjs-dist 兜底，含中文），
结果在附件清单的 `extraction` 字段：

- `partial` / `failed`：正文不够用、或需要**表格 / 表单 / 拆分 / 旋转 / 合并**时，
  用本 skill 的 Node 脚本处理原件（原件的 workspace 相对路径来自附件清单 `path`）。
- 需要 OCR（扫描件）或「页 → 图片」时，当前 Node 版尚未提供——如实说明，不要硬试。

## 权限与环境要求

- 至少 `workspace-write` 权限档；`read-only` 模式 skill 注册表不会被扫描。
- **零额外安装**：依赖 `pdfjs-dist` / `pdf-lib` 已在项目 `optionalDependencies` 中，
  随 `npm ci` / `npm install` 安装。脚本用 `node` 直接运行，不建 venv、不碰 pip、不依赖 Homebrew 二进制。
- 溢出说明：optional 依赖装不上时不阻断安装，脚本运行时会报「未安装 xxx」，提示补装。

## 一步分诊

```bash
node .payaso/skills/pdf-official/scripts/survey.mjs 文件.pdf --pretty
```

```json
{
  "path": "/abs/path/file.pdf",
  "page_count": 12,
  "is_locked": false,
  "form_field_count": 34,
  "looks_scanned": false,
  "metadata": {"Title": "...", "Producer": "..."}
}
```

路由：

- `is_locked: true` → 加密 PDF，Node 脚本暂不支持解密，如实告知。
- `form_field_count > 0` → 有表单字段；Node 版表单填充待迁移，先如实告知。
- `looks_scanned: true` → 扫描件；Node 版 OCR 待迁移，先如实告知。

## 脚本退出码契约

所有脚本统一：`0` 成功 · `1` 运行失败 · `2` 用法错误（参数/路径）。`scripts/lib.mjs` 提供
`run` / `CliError` / `readPdfBytes` 三个复用原语，新脚本沿用即可。

## 常见坑

- PDF 坐标原点在**左下**，图片原点在**左上**。「差几个点」的 bug 几乎都是这两套坐标系用错。
- 扫描件 `text_dump.mjs` 返回空文本——那是文件里没有文本层，不是 bug，需 OCR（当前待迁移）。
- PDF 加密时，pdfjs 提取抛 `PasswordException`，`survey.mjs` 会据此判定 `is_locked: true`。