// Host 负责上传文件发布；模型侧只收到持久路径引用。
import fs from 'node:fs';
import path from 'node:path';
import type { MessageImage } from '../../llm/llm.js';
import type { HostAttachment } from '../run-events.js';
import type { CreateRunAttachmentInput } from './types.js';
import { attachmentKind } from '../../attachment-policy.js';
import {
  getAttachmentStoreRoot,
  publishAttachmentIntoWorkspace,
  putAttachmentObject,
  sweepAttachmentTmpOnce,
} from '../../attachments/store.js';

// 附件落盘（Host 侧，v2 内容寻址）：字节入库（sha256 去重 + 原子发布，
// 见 attachments/store.ts）→ 硬链接进工作区 attachments 目录供 agent 可见。
// 返回工作区相对路径 + 内容键；MIME 白名单/数量/大小由调用方校验。
// 落盘任一步失败直接抛错（调用方按创建失败处理，不留下无附件的 Run）。
export function writeAttachmentFile(input: {
  workspaceRoot: string;
  directory: string;
  fileName: string;
  dataBase64: string;
  independentCopy?: boolean;
}): { relPath: string; sha256: string } {
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0 && !input.independentCopy) throw new Error('附件内容为空');
  const storeRoot = getAttachmentStoreRoot();
  sweepAttachmentTmpOnce(storeRoot);
  const stored = putAttachmentObject(storeRoot, bytes);
  const { relPath } = publishAttachmentIntoWorkspace(
    stored.storePath,
    input.workspaceRoot,
    input.directory,
    input.fileName,
    input.independentCopy,
  );
  return { relPath, sha256: stored.sha256 };
}

export function publishAttachments(
  workspaceRoot: string,
  runId: string,
  attachments: CreateRunAttachmentInput[],
) {
  const published: string[] = [];
  try {
    const attachmentImages: MessageImage[] = [];
    const attachmentViews: HostAttachment[] = [];
    for (const attachment of attachments) {
      const { relPath, sha256 } = writeAttachmentFile({
        workspaceRoot,
        directory: 'input/attachments',
        fileName: `${runId.slice(0, 8)}-${attachment.name}`,
        dataBase64: attachment.dataBase64,
        independentCopy: !attachment.mimeType.startsWith('image/'),
      });
      published.push(relPath);
      if (attachment.mimeType.startsWith('image/'))
        attachmentImages.push({
          mimeType: attachment.mimeType,
          path: relPath,
          sha256,
          width: attachment.width,
          height: attachment.height,
          originalDimensions: attachment.originalDimensions,
        });
      const extracted =
        attachment.extraction?.text === undefined
          ? undefined
          : writeAttachmentFile({
              workspaceRoot,
              directory: 'input/attachments',
              fileName: `${runId.slice(0, 8)}-${attachment.name}.txt`,
              dataBase64: Buffer.from(attachment.extraction.text, 'utf8').toString('base64'),
              independentCopy: true,
            });
      if (extracted) published.push(extracted.relPath);
      attachmentViews.push({
        ...(attachment.extraction
          ? {
              extraction: {
                status: attachment.extraction.status,
                message: attachment.extraction.message,
                ...(extracted
                  ? {
                      path: extracted.relPath,
                      sha256: extracted.sha256,
                      sizeBytes: Buffer.byteLength(attachment.extraction.text!, 'utf8'),
                    }
                  : {}),
              },
            }
          : {}),
        name: attachment.name,
        mimeType: attachment.mimeType,
        path: relPath,
        kind: attachment.mimeType.startsWith('image/')
          ? 'image'
          : attachmentKind(attachment.name, attachment.mimeType) !== 'text'
            ? 'binary'
            : 'text',
        sizeBytes: Buffer.from(attachment.dataBase64, 'base64').length,
        sha256,
      });
    }

    return { images: attachmentImages, views: attachmentViews };
  } catch (error) {
    for (const rel of published) {
      try {
        fs.unlinkSync(path.join(workspaceRoot, rel));
      } catch {
        /* 尽力清理本批次副本，内容库对象仍可复用。 */
      }
    }
    throw error;
  }
}
