// 精确文件集合：既检查用户路径，也检查当下真实路径，禁止软链接和目录替换。
import fs from 'node:fs';
import path from 'node:path';

export function scopedPath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f]/u.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('文件范围必须是规范的工作区相对文件路径');
  }
  const base = fs.realpathSync(root);
  const parts = relative.split('/');
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && i === parts.length - 1) return current;
      throw new Error('约束文件的父目录必须已存在');
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('文件范围不允许软链接、目录或特殊文件');
    }
  }
  return current;
}

export function assertWriteScope(root: string, requested: string, allowed?: readonly string[]): void {
  if (allowed === undefined) return;
  const relative = path.isAbsolute(requested) ? path.relative(root, requested) : requested;
  if (!allowed.includes(relative)) throw new Error('操作被拒绝：文件不在本轮允许修改的范围内');
  scopedPath(root, relative);
}
