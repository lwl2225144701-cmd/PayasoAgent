// 工具输出 spill：超预算的完整结果落盘，并把「可读回的路径」交给模型。
//
// 为什么需要（docs/plans/context-management-plan.md B 项）：guard 把超过 16KB
// 的工具输出切成「头 + [OUTPUT TRUNCATED] + 尾」，中间那段落库前就被丢掉，
// 模型没有任何恢复途径（events 表里最大的 tool_result 正好卡在 16KB 上，
// 证明落库的也是砍过的）。这里补上"完整原文 + 地址"。
//
// 存哪（与 DSH 的关键差异）：本仓库的 read 工具严格限制在工作区内
// （filesystem.ts rejectPath：禁止穿越 / 绝对路径 / symlink 逃逸），所以
// DSH 那种"写进私有应用目录 + 给模型绝对路径"在这里读不回来。因此复用
// 既有模式——与 input/attachments/ 同级，落进工作区 input/spill/，沿用
// 附件库的「内容寻址入库 → hardlink 发布进工作区 → 0444 只读 → 永不覆盖」，
// 不引入任何安全边界放宽，也不需要第二套存储。
//
// 生命周期：spill 与 input/attachments/ 同属运行时产物，随工作区（会话）
// 生命周期回收——不新建清理机制。
//
// 防循环：read 自身输出被 sliceNumberedWindow 卡在「16KB − 2048 预留」内，
// 结构上永远够不到 guard 的预算，因此不会被二次落盘，不存在
// 「读 spill 文件 → 又落盘 → 再读」的循环。
//
// fail-soft：任何失败返回 null，调用方保留原受限结果——宁可上下文大一点，
// 也绝不因为落盘失败而丢数据。

import fs from 'node:fs';
import path from 'node:path';
import {
  getAttachmentStoreRoot,
  publishAttachmentIntoWorkspace,
  putAttachmentObject,
} from '../attachments/store.js';

/** spill 在 workspace 内的目录（与 input/attachments/ 同级）。 */
export const TOOL_OUTPUT_SPILL_DIR = 'input/spill';

export interface SpillTarget {
  workspaceRoot: string;
  toolName: string;
  runId: string;
}

/** 只保留字母数字与连字符，避免工具名污染文件名。 */
function safeToolName(toolName: string): string {
  const cleaned = toolName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'tool';
}

/**
 * 把完整工具输出落盘并发布进工作区，返回工作区相对路径；失败返回 null。
 *
 * 幂等：文件名 = 工具名 + 内容 sha 前 16 位，所以同一份内容永远得到同一个
 * 路径——重复落盘（工具重复输出同样内容是常态）不会在 input/spill/ 里堆出
 * -2/-3 副本，模型拿到的句柄也保持稳定。名字已含内容身份，命中同名文件时
 * 再核对一次字节数即可信（文件是 0444 只读、发布用 hardlink/EXCL 从不覆盖）。
 */
export function spillToolOutput(text: string, target: SpillTarget): string | null {
  try {
    const bytes = Buffer.byteLength(text, 'utf8');
    const stored = putAttachmentObject(getAttachmentStoreRoot(), Buffer.from(text, 'utf8'));
    const fileName = `${safeToolName(target.toolName)}-${stored.sha256.slice(0, 16)}.txt`;
    const relPath = `${TOOL_OUTPUT_SPILL_DIR}/${fileName}`;
    const existing = path.join(target.workspaceRoot, relPath);
    try {
      const stat = fs.statSync(existing);
      if (stat.isFile() && stat.size === bytes) return relPath;
    } catch {
      /* 尚未发布 → 走下面的正常发布 */
    }
    const published = publishAttachmentIntoWorkspace(
      stored.storePath,
      target.workspaceRoot,
      TOOL_OUTPUT_SPILL_DIR,
      fileName,
    );
    return published.relPath;
  } catch {
    return null;
  }
}

/** 追加在受限结果之后的落盘提示（模型据此用 read 读回被省略的部分）。 */
export function spillNotice(relPath: string): string {
  return `[中间被省略的内容已完整落盘，可用 read 读回：${relPath}]`;
}
