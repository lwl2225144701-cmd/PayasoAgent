// True cancellation (v1.6): 统一 Abort 语义。
// 判断必须基于 error.name / signal 状态，禁止对错误消息做字符串全文匹配
// （Node fetch / DOMException / 自定义 AbortError 的表现形式不同）。

export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
