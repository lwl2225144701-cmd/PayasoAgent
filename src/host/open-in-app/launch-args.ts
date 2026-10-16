// 启动参数形态 —— 纯函数、可单测（不做任何 IO：「目标是不是目录」由调用方探测后传入）。
//
// 为什么需要这张表：**部分应用把位置参数当成"要运行的命令"，而不是"起始目录"。**
// Windows Terminal 就是典型：`wt.exe <dir>` 会让它去 CreateProcess 一个目录，拿到
// `0x80070005`（ERROR_ACCESS_DENIED —— 对目录调 CreateProcess 的固定错误码），用户
// 看到的是「[出现错误 2147942405 (0x80070005) (启动"<dir>"时)]」。正确形态是
// `wt.exe -d <dir>`：`-d` 才是"起始目录"。
//
// cmd.exe 同理——传目录会被当成命令，所以只靠调用方的 cwd，一个参数都不传。
// 其余应用（VS Code / Cursor 等编辑器）把目录当项目路径打开，位置参数才是对的形态，
// 因此保持默认。
//
// 边界：文件目标一律位置参数（`<app> <file>`）；只有目录目标才查这张表。

import path from 'node:path';

/** 目录目标的参数模板：`{target}` 是占位符；未列出的可执行文件默认 `['{target}']`。 */
const FOLDER_ARG_TEMPLATES: Record<string, readonly string[]> = {
  'wt.exe': ['-d', '{target}'],
  'cmd.exe': [],
};

/**
 * 算出打开某个目标时应传给应用的参数。
 *
 * @param executablePath 解析出的可执行文件绝对路径（按 basename 匹配，大小写不敏感）
 * @param target 要打开的目标（工作区根目录，或工作区内的文件）
 * @param targetIsDirectory 目标是否为目录（调用方 stat 后传入；探测失败按文件处理）
 */
export function launchArgsFor(
  executablePath: string,
  target: string,
  targetIsDirectory: boolean,
): string[] {
  if (!targetIsDirectory) return [target];
  const template = FOLDER_ARG_TEMPLATES[path.basename(executablePath).toLowerCase()];
  if (template === undefined) return [target];
  return template.map((arg) => (arg === '{target}' ? target : arg));
}
