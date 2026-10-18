// 模块: 「用某个应用打开某个目标」要传什么参数、工作目录设哪 —— 纯函数，无 IO。
//
// 为什么单独抽出来（两个都是真机踩出来的坑，且都在 Windows 上暴露）：
//   1. **终端**：Windows Terminal 把**裸路径当命令执行** —— `wt.exe D:\ws` 会去启动
//      `D:\ws` 这个"程序"，Windows 报 `0x80070005（启动"D:\ws"时）`，用户看到的就是
//      一个黑窗口加一行错误。正确做法是 `wt.exe -d <dir>`；cmd.exe 不需要参数，
//      工作目录本身就是"在哪个目录开"。
//   2. **文件目标**：原来 cwd 被设成 `target` 本身 —— 目标是文件时那不是目录，
//      进程起不来（编辑器/浏览器都受影响）。cwd 必须是**目录**：目录目标用它自己，
//      文件目标用它的父目录。
//
// 参数与 cwd 的推导不进 IO、不看平台之外的状态，套件里逐个断言（见
// tests/open-in-app.test.ts 的 invocation 用例）。

import path from 'node:path';

export interface LaunchInvocation {
  /** 传给可执行文件的参数（不含 argv[0]）。 */
  args: string[];
  /** 进程工作目录（必须是目录）。 */
  cwd: string;
  /**
   * explorer.exe 打开成功也经常立刻以非 0 退出，不能把这个退出码当成启动失败。
   */
  ignoreExitCode?: boolean;
}

export interface InvocationInput {
  /** 应用 id（catalog 里的稳定 id，如 `terminal`）。 */
  appId: string;
  /** 解析出来的可执行文件绝对路径（`wt.exe` / `cmd.exe` / `Code.exe` …）。 */
  executablePath: string;
  /** 要打开的目标（工作区根、目录，或某个文件的绝对路径）。 */
  target: string;
  platform: NodeJS.Platform;
  /** target 是不是目录（调用方 stat 过；stat 失败按"不是目录"处理）。 */
  targetIsDirectory: boolean;
}

export function buildLaunchInvocation(input: InvocationInput): LaunchInvocation {
  const { appId, executablePath, target, platform, targetIsDirectory } = input;
  // 按**目标所在平台**选路径实现：在 macOS 上跑单测时也要能正确解析 `D:\ws`。
  // 用宿主默认的 path 会让行为随"跑在哪台机器"变 —— 那就没法测，也没法信任。
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const cwd = targetIsDirectory ? target : impl.dirname(target);
  const exe = impl.basename(executablePath).toLowerCase();

  if (platform === 'win32') {
    // Windows Terminal：`-d` 才是"起始目录"；裸参数会被当成要运行的命令。
    if (appId === 'terminal' && exe === 'wt.exe') return { args: ['-d', cwd], cwd };
    // cmd.exe：不带参数就是开一个交互 shell，落点由 cwd 决定。
    if (appId === 'terminal' && exe === 'cmd.exe') return { args: [], cwd };
    // 资源管理器：参数就是要打开的路径。退出码不可靠，见 ignoreExitCode。
    if (exe === 'explorer.exe') return { args: [target], cwd, ignoreExitCode: true };
  }
  return { args: [target], cwd };
}
