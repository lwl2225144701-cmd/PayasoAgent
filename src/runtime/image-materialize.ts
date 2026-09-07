// 图片物化：在调用模型的边界，把消息上的图片引用（工作区相对路径）
// 读取为 base64 data。canonical transcript / checkpoint 中图片永远只存
// 路径引用；base64 只活在本轮 LLM 请求的消息副本上，不进 trace、不进 checkpoint。
//
// 安全契约：与文件工具相同 —— 路径相对 workspaceRoot 解析，逃逸（.. / 绝对
// 路径 / symlink）一律拒绝该张图片；单张图片超限直接跳过。任何单张图片
// 问题都不致命：丢弃该张并（对 user 消息）文本注明，整轮请求继续。

import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, MessageImage } from '../llm/llm.js';
import { assertInsideRoot, resolveWorkspacePath } from '../sandbox/sandbox-manager.js';
import {
  getAttachmentStoreRoot,
  publishAttachmentIntoWorkspace,
  putAttachmentObject,
  sweepAttachmentTmpOnce,
} from './attachment-store.js';

// 单张图片进入模型上下文的字节上限（与 read 工具读图上限一致）。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function loadImage(image: MessageImage, workspaceRoot: string): MessageImage | null {
  if (typeof image.data === 'string' && image.data.length > 0) return image;
  // 内容寻址优先：sha256 可直接推导库内对象路径（入库对象已按模型预算归一化，
  // ≤2048²/≤4MiB；按模型差异化预算的 request-images 变体缓存见方案文档，暂缓）。
  // workspace 副本只是同一 inode 的别名/历史回退。
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
      /* 库缺失（迁移/清理）→ 回退 workspace 副本 */
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

// 生成模型视图消息数组（新数组 + 新消息对象，不修改 transcript 原件）。
// - vision=false：剥离全部图片。user 消息追加省略说明（用户发的图需要明确
//   告知"图没发出去"）；tool 消息静默丢弃（视觉关闭时 read 工具本就只返回
//   文本占位，出现图片只可能是防御性场景）。
// - vision=true：逐张物化；缺失/超限/逃逸的图片跳过，user 消息文本注明。
export function materializeMessagesForModel(
  messages: ChatMessage[],
  workspaceRoot: string,
  vision: boolean,
): ChatMessage[] {
  return messages.map((message) => {
    if (!message.images || message.images.length === 0) return message;
    const total = message.images.length;

    if (!vision) {
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
    }

    const loaded: MessageImage[] = [];
    const missing: string[] = [];
    for (const image of message.images) {
      const resolved = loadImage(image, workspaceRoot);
      if (resolved) loaded.push(resolved);
      else missing.push(image.path ?? '(embedded image)');
    }

    const out: ChatMessage = { ...message };
    if (loaded.length > 0) {
      out.images = loaded;
    } else {
      delete out.images;
    }
    if (missing.length > 0 && message.role === 'user') {
      out.content =
        `${out.content ?? ''}\n[以下 ${missing.length} 张图片未能载入上下文：${missing.join(', ')}]`.trim();
    }
    return out;
  });
}

// 附件落盘（Host 侧，v2 内容寻址）：字节入库（sha256 去重 + 原子发布，
// 见 attachment-store.ts）→ 硬链接进工作区 attachments 目录供 agent 可见。
// 返回工作区相对路径 + 内容键；MIME 白名单/数量/大小由调用方校验。
// 落盘任一步失败直接抛错（调用方按创建失败处理，不留下无附件的 Run）。
export function writeAttachmentFile(input: {
  workspaceRoot: string;
  directory: string;
  fileName: string;
  dataBase64: string;
}): { relPath: string; sha256: string } {
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0) throw new Error('附件内容为空');
  const storeRoot = getAttachmentStoreRoot();
  sweepAttachmentTmpOnce(storeRoot);
  const stored = putAttachmentObject(storeRoot, bytes);
  const { relPath } = publishAttachmentIntoWorkspace(
    stored.storePath,
    input.workspaceRoot,
    input.directory,
    input.fileName,
  );
  return { relPath, sha256: stored.sha256 };
}
