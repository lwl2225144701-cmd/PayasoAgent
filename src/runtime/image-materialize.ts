// 图片物化：在调用模型的边界，把消息上的图片引用（工作区相对路径）
// 读取为 base64 data。canonical transcript / checkpoint 中图片永远只存
// 路径引用；base64 只活在本轮 LLM 请求的消息副本上，不进 trace、不进 checkpoint。
//
// 安全契约：与文件工具相同 —— 路径相对 workspaceRoot 解析，逃逸（.. / 绝对
// 路径 / symlink）一律拒绝该张图片；单张图片超限直接跳过。任何单张图片
// 问题都不致命：丢弃该张并文本注明，整轮请求继续。
//
// P0 图片预算（docs/plans/context-management-plan.md）：历史图片每轮全量
// base64 内联会把请求体顶到 7.47MB。这里加「张数 + 字节」双上限：从最新的
// 图往回内联，超出预算的旧图降级为「文字占位 + 只读路径」（模型可 read /
// read_image 读回）。降级成批且单调（按 batch 整批降最旧的，已降级的不再
// 恢复），避免每来一张新图就改写一次请求前缀、打断 provider 前缀缓存。

import fs from 'node:fs';
import path from 'node:path';
import { getAttachmentStoreRoot } from '../attachments/store.js';
import type { ChatMessage, MessageImage } from '../llm/llm.js';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';

// 单张图片进入模型上下文的字节上限（与 read 工具读图上限一致）。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// base64 长度约等于原文的 4/3，字节预算按原文估算即可（不必先读成 base64 再量）。
const BASE64_RATIO = 4 / 3;
// 成批降级：一旦要掉图，按此批量整批地把最旧的图降级（单调：已降级的不再恢复）。
const INLINE_IMAGE_BATCH = 2;

/** 本次请求内联图片的预算（张数 + 字节双上限）。 */
export interface InlineImageBudget {
  maxInlineImages: number;
  maxInlineImageBytes: number;
}

export const DEFAULT_INLINE_IMAGE_BUDGET: InlineImageBudget = {
  // 覆盖"当前讨论中"的最近几张；更早的截图不再内联（可 read_image 读回）。
  maxInlineImages: 4,
  // 次要保险：封住"张数不超但每张都很大"的病态总量。取 8MB，保证单张
  // 归一化上限（≤4MiB → base64 ≤5.6MB）的图即使只有一张也仍可内联。
  maxInlineImageBytes: 8 * 1024 * 1024,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** 从环境变量解析预算（非法值回退默认，fail-closed，与 llmTimeoutPolicy 一致）。 */
export function resolveInlineImageBudget(
  env: Record<string, string | undefined> = process.env,
): InlineImageBudget {
  return {
    maxInlineImages: positiveInt(
      env.PAYASO_MAX_INLINE_IMAGES,
      DEFAULT_INLINE_IMAGE_BUDGET.maxInlineImages,
    ),
    maxInlineImageBytes: positiveInt(
      env.PAYASO_MAX_INLINE_IMAGE_BYTES,
      DEFAULT_INLINE_IMAGE_BUDGET.maxInlineImageBytes,
    ),
  };
}

// 只 stat 不读：返回图片原始字节数；找不到 / 逃逸 / 超单张上限 → 0（视为不可用）。
function imageRawBytes(image: MessageImage, workspaceRoot: string): number {
  if (image.sha256) {
    const storePath = path.join(
      getAttachmentStoreRoot(),
      'objects',
      image.sha256.slice(0, 2),
      image.sha256,
    );
    try {
      const stat = fs.statSync(storePath);
      return stat.isFile() && stat.size <= MAX_IMAGE_BYTES ? stat.size : 0;
    } catch {
      /* 库缺失（迁移/清理）→ 回退 workspace 副本 */
    }
  }
  if (!image.path) return 0;
  try {
    const real = resolveWorkspacePath(workspaceRoot, image.path);
    assertInsideRoot(workspaceRoot, real);
    const stat = fs.statSync(real);
    return stat.isFile() && stat.size <= MAX_IMAGE_BYTES ? stat.size : 0;
  } catch {
    return 0;
  }
}

function loadImage(image: MessageImage, workspaceRoot: string): MessageImage | null {
  if (typeof image.data === 'string' && image.data.length > 0) return image;
  if (image.sha256) {
    const storePath = path.join(
      getAttachmentStoreRoot(),
      'objects',
      image.sha256.slice(0, 2),
      image.sha256,
    );
    try {
      const stat = fs.statSync(storePath);
      if (stat.isFile() && stat.size <= MAX_IMAGE_BYTES) {
        const data = fs.readFileSync(storePath).toString('base64');
        return { mimeType: image.mimeType, path: image.path, sha256: image.sha256, data };
      }
    } catch {
      /* 库缺失 → 回退 workspace 副本 */
    }
  }
  if (!image.path) return null;
  try {
    const real = resolveWorkspacePath(workspaceRoot, image.path);
    assertInsideRoot(workspaceRoot, real);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const data = fs.readFileSync(real).toString('base64');
    return { mimeType: image.mimeType, path: image.path, sha256: image.sha256, data };
  } catch {
    return null;
  }
}

// 占位符里的"显示名 + 尺寸 + 类型"，让模型知道这里原本是什么。
function imageLabel(image: MessageImage): string {
  const name = image.path ? image.path.split('/').pop() || image.path : '(embedded)';
  const dims =
    image.width && image.height
      ? `${image.width}x${image.height}`
      : (image.originalDimensions ?? '尺寸未知');
  return `${name}（${dims}，${image.mimeType}）`;
}

// 生成模型视图消息数组（新数组 + 新消息对象，不修改 transcript 原件）。
// - vision=false：剥离全部图片。user 消息追加省略说明（用户发的图需要明确
//   告知"图没发出去"）；tool 消息静默丢弃（视觉关闭时 read 工具本就只返回
//   文本占位，出现图片只可能是防御性场景）。
// - vision=true：从最新往回内联，撞到张数/字节预算即停；其余降级为文字占位
//   + 只读路径。
export function materializeMessagesForModel(
  messages: ChatMessage[],
  workspaceRoot: string,
  vision: boolean,
  budget: InlineImageBudget = DEFAULT_INLINE_IMAGE_BUDGET,
): ChatMessage[] {
  if (!vision) {
    return messages.map((message) => {
      if (!message.images || message.images.length === 0) return message;
      const total = message.images.length;
      if (message.role === 'user') {
        return {
          ...message,
          images: undefined,
          content:
            `${message.content ? `${message.content}\n` : ''}` +
            `[图片已省略：当前模型不支持视觉输入，共 ${total} 张图片未发送给模型。]`,
        };
      }
      const { images: _dropped, ...rest } = message;
      return rest;
    });
  }

  // 统计所有图片位置与原始字节（只 stat，不读 base64）。
  const slots: Array<{ mi: number; ii: number; rawBytes: number }> = [];
  const rawBytesByKey = new Map<string, number>();
  for (let mi = 0; mi < messages.length; mi++) {
    const images = messages[mi].images;
    if (!images || images.length === 0) continue;
    for (let ii = 0; ii < images.length; ii++) {
      const rawBytes = imageRawBytes(images[ii], workspaceRoot);
      slots.push({ mi, ii, rawBytes });
      rawBytesByKey.set(`${mi}:${ii}`, rawBytes);
    }
  }

  // 决定内联集合（始终是"最新的一段连续后缀"）：
  // - 张数预算（成批 + 单调）：最旧 omit 张降级，omit 只随总数增长、按 batch 成批。
  // - 字节预算：从新到旧累加 base64 估长，超了就停（更旧的也一并降级）。
  const total = slots.length;
  const rawOmit =
    total <= budget.maxInlineImages
      ? 0
      : Math.ceil((total - budget.maxInlineImages) / INLINE_IMAGE_BATCH) * INLINE_IMAGE_BATCH;
  // 至少内联最新 1 张（即使病理配置张数上限 < 批量，也不把最新的也降级掉）。
  const omitCount = Math.min(total - 1, rawOmit);
  const inlineSet = new Set<string>();
  let inlineBytes = 0;
  for (let s = total - 1; s >= omitCount; s--) {
    const est = Math.ceil(slots[s].rawBytes * BASE64_RATIO);
    if (inlineBytes + est > budget.maxInlineImageBytes) break;
    inlineBytes += est;
    inlineSet.add(`${slots[s].mi}:${slots[s].ii}`);
  }

  return messages.map((message, mi) => {
    const images = message.images;
    if (!images || images.length === 0) return message;

    const loaded: MessageImage[] = [];
    const dropped: Array<{ image: MessageImage; unavailable: boolean }> = [];
    for (let ii = 0; ii < images.length; ii++) {
      const image = images[ii];
      if (inlineSet.has(`${mi}:${ii}`)) {
        const resolved = loadImage(image, workspaceRoot);
        if (resolved) loaded.push(resolved);
        else dropped.push({ image, unavailable: true });
      } else {
        // 预算降级：能否读回取决于文件是否还可用（rawBytes=0 → 视为不可用）。
        dropped.push({ image, unavailable: rawBytesByKey.get(`${mi}:${ii}`) === 0 });
      }
    }

    const out: ChatMessage = { ...message };
    if (loaded.length > 0) out.images = loaded;
    else delete out.images;

    const notes: string[] = [];
    for (const d of dropped) {
      if (d.unavailable) {
        notes.push(`[图片未能载入上下文：${d.image.path ?? '(embedded)'}]`);
      } else {
        notes.push(
          `[图片已省略（超出本次请求的图片预算），只读路径 ${d.image.path ?? '（无）'}：${imageLabel(d.image)}]`,
        );
      }
    }
    if (notes.length > 0) {
      out.content = `${out.content ?? ''}${out.content ? '\n' : ''}${notes.join('\n')}`.trim();
    }
    return out;
  });
}
