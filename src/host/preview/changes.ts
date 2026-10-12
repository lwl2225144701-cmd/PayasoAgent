// 工作区文件变更流 —— GUI 预览自动刷新与「外部写入发现」共用同一份 watch。
//
// 形态：每个工作区根一个 fs.watch（recursive；macOS/Windows 原生支持，Linux 内核
// 不支持递归时会抛错 → 该根降级为无事件，预览退回手动刷新，不影响其它功能）。
// 事件按 400ms 去抖聚合成一批相对路径推给订阅者；订阅者全走这里，不各自开 watch。
//
// 边界：事件是"通知"不是"事实"——订阅方收到批次后自行 re-stat 取权威版本
// （预览面板按 mtimeMs+size 比对决定是否重载）。
import fs from 'node:fs';

type Listener = (paths: string[]) => void;

interface Subscription {
  watchers: fs.FSWatcher[];
  listeners: Set<Listener>;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
}

const subscriptions = new Map<string, Subscription>();

const DEBOUNCE_MS = 400;

/** 订阅某工作区根的变更批次；返回退订函数（最后一个订阅者退订时关闭 watch）。 */
export function subscribeWorkspaceChanges(root: string, listener: Listener): () => void {
  let entry = subscriptions.get(root);
  if (!entry) {
    entry = { watchers: [], listeners: new Set(), pending: new Set(), timer: null };
    subscriptions.set(root, entry);
    startWatch(root, entry);
  }
  entry.listeners.add(listener);
  return () => {
    const current = subscriptions.get(root);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      if (current.timer) clearTimeout(current.timer);
      current.watchers.forEach((watcher) => {
        watcher.close();
      });
      subscriptions.delete(root);
    }
  };
}

function startWatch(root: string, entry: Subscription): void {
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (typeof filename !== 'string' || filename.length === 0) return;
      entry.pending.add(filename.replace(/\\/g, '/'));
      if (entry.timer === null) {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          const paths = [...entry.pending];
          entry.pending.clear();
          if (paths.length === 0) return;
          for (const listener of entry.listeners) {
            try {
              listener(paths);
            } catch {
              // 单个订阅者抛错不影响其它订阅者
            }
          }
        }, DEBOUNCE_MS);
      }
    });
  } catch {
    // Linux 无 recursive 支持：降级为无变更流（预览退回手动刷新）
    subscriptions.delete(root);
    return;
  }
  // 根被删除/不可访问：关闭 watch 并通知订阅者空批次（它们各自清理）
  watcher.on('error', () => {
    watcher.close();
    const current = subscriptions.get(root);
    if (!current) return;
    subscriptions.delete(root);
    for (const listener of current.listeners) {
      try {
        listener([]);
      } catch {
        // 忽略
      }
    }
  });
  entry.watchers.push(watcher);
}
