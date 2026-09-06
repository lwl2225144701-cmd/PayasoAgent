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

// 单张图片进入模型上下文的字节上限（与 read 工具读图上限一致）。
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function loadImage(image: MessageImage, workspaceRoot: string): MessageImage | null {
  if (typeof image.data === 'string' && image.data.length > 0) return image;
  if (!image.path) return null;
  try {
    const real = resolveWorkspacePath(workspaceRoot, image.path);
    assertInsideRoot(workspaceRoot, real);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const data = fs.readFileSync(real).toString('base64');
    return { mimeType: image.mimeType, path: image.path, data };
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
            `${message.content ? message.content + '\n' : ''}` +
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

// 附件落盘辅助（Host 侧）：把 base64 附件写入工作区 attachments 目录，
// 返回工作区相对路径。文件名做基础清洗防穿越；MIME 白名单由调用方校验。
export function writeAttachmentFile(input: {
  workspaceRoot: string;
  directory: string;
  fileName: string;
  dataBase64: string;
}): { relPath: string } {
  const safeName = path
    .basename(input.fileName)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_');
  const dir = resolveWorkspacePath(input.workspaceRoot, input.directory);
  assertInsideRoot(input.workspaceRoot, dir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, safeName);
  assertInsideRoot(input.workspaceRoot, target);
  fs.writeFileSync(target, Buffer.from(input.dataBase64, 'base64'));
  const relPath = path.relative(input.workspaceRoot, target).split(path.sep).join('/');
  return { relPath };
}
