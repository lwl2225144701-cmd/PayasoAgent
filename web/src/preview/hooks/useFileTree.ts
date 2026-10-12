// Preview 目录导航：当前目录 + 单层懒加载（点击目录才请求下一级，从不拉全树）。
//
// 错误身份只存 code（不存消息）—— 组件按 code 映射 i18n 文案，
// 与后端 PreviewError 的 code 身份约定一致。

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTree, PreviewApiError } from '../api';
import type { PreviewTreeError, PreviewTreeListing } from '../types';

export interface FileTreeNav {
  /** 当前展示的目录（POSIX 相对路径；'' = 工作区根）。 */
  currentPath: string;
  listing: PreviewTreeListing | null;
  loading: boolean;
  /** 当前目录加载失败的身份（已知 code 或 'unknown'）；null = 无错。 */
  errorCode: PreviewTreeError | null;
  includeIgnored: boolean;
  navigate: (path: string) => void;
  refresh: () => void;
  setIncludeIgnored: (value: boolean) => void;
}

export function useFileTree(runId?: string | null): FileTreeNav {
  const [currentPath, setCurrentPath] = useState('');
  const [listing, setListing] = useState<PreviewTreeListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<PreviewTreeError | null>(null);
  const [includeIgnored, setIncludeIgnoredState] = useState(false);
  // 自增 token：刷新与切换目录时作废迟到的旧响应，防止竞态覆盖新列表
  const loadTokenRef = useRef(0);
  const includeIgnoredRef = useRef(includeIgnored);
  includeIgnoredRef.current = includeIgnored;
  // 作用域（会话 Run）走 ref 参与请求参数，并作为重载依赖：切会话即重新拉根层
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const load = useCallback(async (path: string) => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setErrorCode(null);
    try {
      const next = await fetchTree(path, includeIgnoredRef.current, { runId: runIdRef.current });
      if (token !== loadTokenRef.current) return; // 竞态：已有更新的请求
      setListing(next);
      setCurrentPath(path);
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setListing(null);
      // 非 PreviewApiError（网络/HTML/解析失败）也要有身份：不能退化成"空目录"
      setErrorCode(err instanceof PreviewApiError ? err.code : 'unknown');
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, []);

  // runId 变化（切换会话）→ 重新加载根层：树属于"某个工作区"，作用域换了必须重取。
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId 经 ref 进入请求参数（load 内部读取），这里只借它当重载触发器
  useEffect(() => {
    void load('');
  }, [load, runId]);

  const setIncludeIgnored = useCallback(
    (value: boolean) => {
      setIncludeIgnoredState(value);
      // 忽略规则变化影响整棵树 → 清空重载当前目录
      void load(currentPath);
    },
    [load, currentPath],
  );

  // refresh 稳定化：变更流触发"当前目录刷新"时作为依赖使用
  const refresh = useCallback(() => void load(currentPath), [load, currentPath]);

  return {
    currentPath,
    listing,
    loading,
    errorCode,
    includeIgnored,
    navigate: (path: string) => void load(path),
    refresh,
    setIncludeIgnored,
  };
}
