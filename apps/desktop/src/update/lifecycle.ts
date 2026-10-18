// 安装交接必须等待真正退出：quitAndInstall() 的返回值不代表安装成功。
export interface UpdateEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function withTimeout<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 同时监听异步错误与成功事件，并在每个结束路径清理监听器。 */
export function waitForUpdateEvent(options: {
  errors: UpdateEvents;
  success: UpdateEvents;
  event: string;
  trigger: () => void;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      options.errors.off('error', onError);
      options.success.off(options.event, onSuccess);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const onError = (error: unknown) => finish(error);
    const onSuccess = () => finish();
    const timer = setTimeout(() => finish(new Error(options.timeoutMessage)), options.timeoutMs);
    timer.unref?.();
    options.errors.on('error', onError);
    options.success.on(options.event, onSuccess);
    try {
      options.trigger();
    } catch (error) {
      finish(error);
    }
  });
}

/** ad-hoc 的 designated requirement 绑定当前构建的 cdhash，不能跨版本验证。 */
export function requiresManualMacInstall(signature: string): boolean {
  return /Signature=adhoc/i.test(signature) || !/^Authority=/m.test(signature);
}
