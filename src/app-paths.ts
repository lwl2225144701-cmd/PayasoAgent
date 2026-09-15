// 应用持久数据与安装包分离；启动目录不隐含工作区授权。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function appHome(): string {
  const configured = process.env.PAYASO_HOME?.trim();
  if (configured && !path.isAbsolute(configured))
    throw new Error('PAYASO_HOME must be an absolute path');
  return configured || path.join(os.homedir(), '.payaso');
}
export function appDataPath(...parts: string[]): string {
  return path.join(appHome(), ...parts);
}
export function checkpointDir(): string {
  return process.env.PAYASO_CHECKPOINT_DIR
    ? path.resolve(process.env.PAYASO_CHECKPOINT_DIR)
    : appDataPath('checkpoints');
}
// src/ 和 dist/ 均位于包根下一层。
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const webStaticRoot = path.join(packageRoot, 'web', 'dist');
