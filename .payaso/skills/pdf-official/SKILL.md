---
name: pdf-official
description: PDF 读取/组装/变换/表单填写工具集（pypdf/pdfplumber/pypdfium2/reportlab/qpdf/Tesseract，Apache-2.0）。附件 PDF 提取标记 partial/failed、需要表格/坐标级文本/OCR/扫描件、或要生成与填充 PDF 时使用。
version: 1.0.0
---

# PDF skill

基于宽松许可开源库（pypdf、pdfplumber、pypdfium2、reportlab、pdf-lib、qpdf）从零编写的
Apache-2.0 工具集，可嵌入商业项目。

## 按动词路由任务

| 任务 | 路径 | 阅读 |
|---|---|---|
| 从既有 PDF 提取文本/表格/元数据/图片 | Extract | `read .payaso/skills/pdf-official/extract.md` |
| 合并/拆分/旋转/裁剪/水印/加密/压缩 | Transform | `read .payaso/skills/pdf-official/transform.md` |
| 从零生成 PDF（报告/发票/证书） | Compose | `read .payaso/skills/pdf-official/compose.md` |
| 填表单（AcroForm 或扫描件） | Interactive | `read .payaso/skills/pdf-official/interactive.md` |
| 扫描件/纯图片 PDF（无可选文本） | Extract → OCR | extract.md §5 |

任务涉及多项时按顺序：probe → plan → extract or compose → validate。

子指南用 `read` 工具按 workspace 相对路径阅读；脚本在
`.payaso/skills/pdf-official/scripts/` 下，用 shell 工具执行。

## 与内建附件提取的衔接

Host 在附件入库时已对 PDF 做过简易提取，结果在附件清单的 `extraction` 字段：

- `partial`：简易提取可能遗漏文字或布局（不支持 OCR、加密和 Type0/ToUnicode 字体映射，
  中文 PDF 常见失败）。正文够用就直接用；不够再走本 skill。
- `failed`：提取失败不代表文件没有内容，原件已保留，直接用本 skill 处理原件。
- 需要**表格、字符级坐标、扫描件 OCR、表单字段**时，简易提取不覆盖，直接走本 skill。

## 权限与环境要求

- 本 skill 至少需要 `workspace-write` 权限档；`read-only` 模式下 skill 注册表不会被扫描，
  也无法安装依赖或写出文件。
- 首次安装需要网络（pip 拉取 PyPI 包）。
- **pip 不能安装到 workspace 之外**（沙箱会拒绝）：一律先建 venv 再安装。venv 放受管
  scratch。scratch 在沙箱内的稳定入口是 `$TMPDIR`（Mac 主机对应 `/tmp/payaso-shell`，
  等价于 Host 侧 `PAYASO_SHELL_SCRATCH_ROOT`，但该变量只存在于 Host、不进入子 shell，
  脚本里一律用 `$TMPDIR`）：

```bash
python3 -m venv "$TMPDIR/pdf-venv"
"$TMPDIR/pdf-venv/bin/pip" install --upgrade pypdf pdfplumber pypdfium2 reportlab Pillow
"$TMPDIR/pdf-venv/bin/python" .payaso/skills/pdf-official/scripts/survey.py 文件.pdf --pretty
```

- 安装失败先怀疑 wheel：宿主 Python 版本很新时 reportlab/pypdfium2 可能还没有对应
  wheel 而回源编译失败。纯 Python 的 pypdf/pdfplumber/pdfminer 通常可用；受阻时先用
  pypdf 管线（text_dump.py --engine python），或改用宿主已装的外部二进制。
- 仅在确实需要时追加外部二进制（外部二进制用 shell 执行，受 `network.mode` 全局开关
  约束，默认 on；host 工具链不可用时报错而非静默降级）：

```bash
# qpdf — merge/split/encrypt/repair，Apache-2.0
brew install qpdf                  # macOS
apt-get install -y qpdf            # Debian/Ubuntu

# Tesseract — 扫描件 OCR，Apache-2.0（本机已装则跳过）
python3 -m pip install pytesseract pdf2image

# Poppler — pdftotext/pdftoppm/pdfimages，GPL-2.0。仅在接受 CLI 层 GPL 依赖时安装
brew install poppler
apt-get install -y poppler-utils
```

- `scripts/` 下全部为 argparse 独立脚本。退出码：0 成功 · 1 运行失败 · 2 参数错误 ·
  3 校验失败（apply_values.py / overlay_text.py；sanity_check.py 以 exit 1 报告问题）。
  任一脚本可单独摘出复用，无共享框架依赖。

## 一步分诊

```bash
"$TMPDIR/pdf-venv/bin/python" .payaso/skills/pdf-official/scripts/survey.py 文件.pdf --pretty
```

```json
{
  "path": "/abs/path/file.pdf",
  "page_count": 12,
  "is_locked": false,
  "form_field_count": 34,
  "looks_scanned": false,
  "metadata": {"Title": "...", "Author": "...", "Producer": "..."}
}
```

按标志路由：

- `is_locked: true` → 先解锁（`qpdf --password=… --decrypt`）。几乎所有读取库都拒绝加密文件。
- `form_field_count > 0` → interactive.md §1 的 widgets 路径。
- `form_field_count == 0` 但需要填表 → interactive.md §2 的 overlay 路径。
- `looks_scanned: true` → 跳过 pypdf 文本提取，直接 OCR（extract.md §5）。

## 哪个任务用哪个库

| 任务 | 首选 | 原因 | 备选 |
|---|---|---|---|
| 纯文本 | pdftotext -layout | 最快，保留分栏 | pypdf |
| 带坐标文本 | pdfplumber | 字符级 bbox | pypdfium2.get_text |
| 表格 | pdfplumber | table_settings 可调 | pandas 手动拼 CSV |
| 页 → 图片 | pypdfium2 | Apache/BSD，无 GPL | pdftoppm（GPL） |
| 合并/拆分/旋转 | pypdf | 纯 Python | qpdf --pages（大文件更快） |
| 加密/修复/线性化 | qpdf | 能处理损坏输入 | pypdf（仅基础 encrypt） |
| 从零生成 | reportlab | 成熟，BSD | Node 侧 pdf-lib |
| 填 AcroForm | pypdf.update_page_form_field_values | 保留 widget 外观 | Node 侧 pdf-lib |
| 覆盖写入不可填表单 | reportlab + pypdf.merge_page | 双层合并，见 interactive.md | — |

## 常见坑

- PDF 坐标原点在**左下**，图片原点在**左上**。所有“差几个点”的 bug 基本是这两套坐标系
  用错了。坐标换算集中在一处：interactive.md §2.c。
- `pypdf.extract_text()` 对扫描件返回空。这不是 bug——文件里本来就没有文本流。
  用 `looks_scanned` 标志路由到 OCR。
- Unicode 上下标在 reportlab 里渲染成黑方块：Helvetica/Times/Courier 不含这些字形。
  用 Paragraph 的 `<sub>` / `<super>` XML，或在 canvas 上手动移笔。见 compose.md §5。
- CJK 文本渲染成黑框通常是字体没注册。reportlab 不查操作系统字体；坏的字体名/路径
  （思源黑体、PingFang、Noto 在缺失的机器上）加上被吞掉的异常 = 静默回退 Helvetica——
  而 Helvetica 没有 CJK 字形。按 compose.md §4 的 `resolve_cjk_font()` 阶梯解析；
  终端兜底是内建 CID 字体，绝不回退 Helvetica。
- XFA 不是 AcroForm。`probe_fields.py` 在 Adobe Reader 里明明有 widget 的 PDF 上返回 []，
  就是 XFA——先在 Acrobat 里拍平。
- pypdf 的 `writer.encrypt(pw)` 默认 RC4。要真 AES-256 需显式 `algorithm="AES-256"`，
  或用 `qpdf --encrypt … 256 --`。
