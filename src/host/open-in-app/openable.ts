// open-in-app 的目标类别判定与按类别过滤（纯函数，可单测）。
//
// "这个文件能用哪些应用打开"由两段 Host 侧事实拼成：
//   ① 文件后缀 → 目标类别（openableKindForPath，下面这张表）；
//   ② 应用声明自己能打开哪些类别（catalog.ts 的 opens 字段）。
// 客户端不猜：两端都在 Host，端点只把过滤后的列表发给前端。
//
// 这不是 Launch Services 查询（那要原生桥）：清单应用 + 声明式能力对
// "装了什么应用是 Host 的事实"这个立场已经够用，且可预测、可测试。

import path from 'node:path';
import { TEXT_EXTENSIONS, TEXT_NAMES } from '../../attachment-policy.js';
import type { OpenableKind } from './catalog.js';

/** 后缀 → 目标类别（文本/代码类走后缀表，未识别的返回 null）。 */
const EXT_KIND: Record<string, OpenableKind> = {
  '.pdf': 'pdf',
  // 图片
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  '.svg': 'image',
  // 文字处理
  '.docx': 'word',
  '.doc': 'word',
  '.rtf': 'word',
  '.odt': 'word',
  // 表格
  '.xlsx': 'sheet',
  '.xls': 'sheet',
  '.csv': 'sheet',
  '.tsv': 'sheet',
  '.ods': 'sheet',
  // 演示
  '.pptx': 'slides',
  '.ppt': 'slides',
  '.odp': 'slides',
};

/**
 * 工作区相对路径 → 目标类别。
 * 返回 null = 未识别的后缀（只有 opens 含 'any' 的应用——访达——会列出）。
 */
export function openableKindForPath(rel: string): OpenableKind | null {
  const base = path.basename(rel);
  const ext = path.extname(base).toLowerCase();
  const kind = EXT_KIND[ext];
  if (kind) return kind;
  // 文本/代码：后缀表 + 无扩展名的特知名称（Makefile/Dockerfile/README…）
  if (TEXT_EXTENSIONS.has(ext.replace(/^\./, ''))) return 'text';
  if (TEXT_NAMES.has(base.toLowerCase())) return 'text';
  return null;
}

/** 参与过滤的应用最小形状（ResolvedApp 即满足）。 */
export interface OpenableApp {
  id: string;
  label: string;
  opens: readonly OpenableKind[];
}

/**
 * 过滤出能打开目标的应用。
 * - `rel` 为 null = 目标是**文件夹**（工作区根）：opens 含 'folder' 或 'any'；
 * - `rel` 给出 = 目标是**文件**：opens 含该文件类别，或 'any'。
 */
export function filterAppsForTarget(
  apps: readonly OpenableApp[],
  rel: string | null,
): OpenableApp[] {
  if (rel === null) {
    return apps.filter((app) => app.opens.includes('folder') || app.opens.includes('any'));
  }
  const kind = openableKindForPath(rel);
  return apps.filter(
    (app) => app.opens.includes('any') || (kind !== null && app.opens.includes(kind)),
  );
}
