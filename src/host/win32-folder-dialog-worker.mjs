// Windows 原生文件夹选择器（子进程）。
//
// 为什么不走 PowerShell：旧实现是 `powershell.exe -NoProfile -STA -Command
// "Add-Type -AssemblyName System.Windows.Forms; ..."`，光是 PowerShell 冷启动 +
// 加载 WinForms 程序集就要 1.5~4 秒（真机反馈"打开原生目录很慢"）。这里用
// koffi 直接驱动 COM 的 **IFileOpenDialog**（Vista+ 的现代通用文件对话框），
// 不 spawn shell、不加载 .NET，对话框近乎立刻出现。
//
// 为什么必须是子进程：`Show` 是阻塞调用，跑在宿主进程里会把 host 事件循环卡住；
// 放子进程里则原生崩溃也被隔离。
//
// 关键细节（缺一个真机就会出问题）：
// - **Alt 合成**：后台宿主 spawn 出来的进程没有前台权，对话框会开在别的窗口后面。
//   `Show` 之前用 `keybd_event` 合成一次 Alt 按下/抬起，系统会把随后出现的窗口
//   判定为前台。
// - **STA**：文件对话框要求 apartment-threaded，必须先 `CoInitializeEx`。
// - **DPI**：优先 per-monitor-v2，逐级回退；`SetThreadDpiAwarenessContext` 对不支持
//   的上下文返回 NULL 而不是抛错（DPI 只是观感，失败不影响功能）。
// - **UTF-16 取值**：路径经 `IShellItem::GetDisplayName(SIGDN_FILESYSPATH)` 返回
//   `LPWSTR`，取完要 `CoTaskMemFree`。
//
// 协议（与父进程的 IPC 通道）：
//   → { kind: 'showing', threadId }   即将进入阻塞 Show
//   → { kind: 'done', path }          选中路径（node:null 表示用户取消）
//   → { kind: 'error', message }      失败
//
// 本文件的 Win32 COM 绑定部分移植自 DeepSeek Harness（DSH）的
// @deepseek-ai/dsh-host-directory-picker-native（MIT License,
// Copyright (c) 2026 DeepSeek）。COM vtable 槽位、GUID、FOS_*/SIGDN_* 常量
// 都是 Vista 起冻结的 Windows ABI 事实。

const COINIT_APARTMENTTHREADED = 2;
const CLSCTX_INPROC_SERVER = 1;
const SIGDN_FILESYSPATH = -2147123200;
/** 每显示器 DPI v2(1703+) → 每显示器(1607+) → 系统级；逐级回退。 */
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2];
const VK_MENU = 18;
const KEYEVENTF_KEYUP = 2;
/** IFileOpenDialog vtable 槽位（IUnknown 0-2、IModalWindow 3、IFileDialog 4+）。 */
const SLOT_RELEASE = 2;
const SLOT_SHOW = 3;
const SLOT_SET_OPTIONS = 9;
const SLOT_SET_TITLE = 17;
const SLOT_GET_RESULT = 20;
/** IShellItem 的 GetDisplayName 槽位。 */
const SLOT_GET_DISPLAY_NAME = 5;
/** FOS_PICKFOLDERS(0x20) | FOS_FORCEFILESYSTEM(0x40) | FOS_PATHMUSTEXIST(0x08)。 */
const FOS_FOLDER_OPTIONS = 104;
/** ERROR_CANCELLED：用户关掉对话框（不是错误）。 */
const HRESULT_CANCELLED = -2147023673;

/** 读一个以 NUL 结尾的 UTF-16 分配：koffi 的 str16 需要一个"指向指针"的缓冲。 */
function readUtf16(koffi, address, pointerSize) {
  const pointer = Buffer.alloc(8);
  pointer.writeBigUInt64LE(BigInt(address));
  return koffi.decode(pointer.subarray(0, pointerSize), 'str16');
}

/** 规范 GUID 文本 → CoCreateInstance 需要的 16 字节小端表示。 */
function guidBytes(text) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(
    text,
  );
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(match[1], 16), 0);
  bytes.writeUInt16LE(parseInt(match[2], 16), 4);
  bytes.writeUInt16LE(parseInt(match[3], 16), 6);
  Buffer.from(match[4] + match[5], 'hex').copy(bytes, 8);
  return bytes;
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7');
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960');

async function loadWin32DialogBindings() {
  const koffi = (await import('koffi')).default;
  const ole32 = koffi.load('ole32.dll');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const pointerSize = koffi.sizeof('void *');

  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', []);
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [
    'void *',
    'void *',
    'uint32',
    'void *',
    'void *',
  ]);
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *']);
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', [
    'uint8',
    'uint8',
    'uint32',
    'uintptr',
  ]);

  const protoShow = koffi.proto('int32 __stdcall PayasoDialogShow(void *self, void *owner)');
  const protoSetOptions = koffi.proto(
    'int32 __stdcall PayasoDialogSetOptions(void *self, uint32 options)',
  );
  const protoSetTitle = koffi.proto(
    'int32 __stdcall PayasoDialogSetTitle(void *self, str16 title)',
  );
  const protoGetResult = koffi.proto(
    'int32 __stdcall PayasoDialogGetResult(void *self, _Out_ void **item)',
  );
  const protoGetDisplayName = koffi.proto(
    'int32 __stdcall PayasoItemGetDisplayName(void *self, int32 form, _Out_ void **name)',
  );
  const protoRelease = koffi.proto('uint32 __stdcall PayasoComRelease(void *self)');

  /** 把 COM 对象 self 的第 slot 个 vtable 槽绑成可调用函数。 */
  const method = (self, slot, proto) => {
    const vtable = koffi.decode(self, 'void *');
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *');
    return (...args) => koffi.call(fn, proto, self, ...args);
  };

  return {
    setThreadDpiAwareness: () => {
      let setContext;
      try {
        setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr']);
      } catch {
        return;
      }
      for (const context of DPI_AWARENESS_CONTEXTS) if (setContext(context) !== null) return;
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED),
    coUninitialize: () => {
      coUninitialize();
    },
    currentThreadId: () => getCurrentThreadId(),
    pressAltForForeground: () => {
      keybdEvent(VK_MENU, 0, 0, 0);
      keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
    },
    createFolderDialog: () => {
      const out = Buffer.alloc(pointerSize);
      const created = coCreateInstance(
        CLSID_FILE_OPEN_DIALOG,
        null,
        CLSCTX_INPROC_SERVER,
        IID_IFILE_OPEN_DIALOG,
        out,
      );
      if (created < 0) {
        throw new Error(
          `CoCreateInstance(FileOpenDialog) failed: HRESULT 0x${(created >>> 0).toString(16)}`,
        );
      }
      const dialog = koffi.decode(out, 'void *');
      return {
        setOptions: (options) => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
        setTitle: (title) => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
        show: () => method(dialog, SLOT_SHOW, protoShow)(null),
        resultPath: () => {
          const itemOut = [null];
          const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut);
          if (gotItem < 0) return { hr: gotItem };
          const item = itemOut[0];
          try {
            const nameOut = [null];
            const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(
              SIGDN_FILESYSPATH,
              nameOut,
            );
            if (gotName < 0) return { hr: gotName };
            const path = readUtf16(koffi, nameOut[0], pointerSize);
            coTaskMemFree(nameOut[0]);
            return { hr: gotName, path };
          } finally {
            method(item, SLOT_RELEASE, protoRelease)();
          }
        },
        release: () => {
          method(dialog, SLOT_RELEASE, protoRelease)();
        },
      };
    },
  };
}

function check(hr, what) {
  if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
  return hr;
}

/** 在调用线程上跑一次模态目录选择：DPI → STA → 建框 → Show → 取路径。 */
function runFolderDialog(bindings, title, onShowing) {
  bindings.setThreadDpiAwareness();
  check(bindings.coInitializeSta(), 'CoInitializeEx');
  try {
    const dialog = bindings.createFolderDialog();
    try {
      check(dialog.setOptions(FOS_FOLDER_OPTIONS), 'SetOptions');
      check(dialog.setTitle(title), 'SetTitle');
      onShowing(bindings.currentThreadId());
      bindings.pressAltForForeground();
      const shown = dialog.show();
      if (shown === HRESULT_CANCELLED) return null;
      check(shown, 'Show');
      const result = dialog.resultPath();
      check(result.hr, 'GetResult');
      return result.path;
    } finally {
      dialog.release();
    }
  } finally {
    bindings.coUninitialize();
  }
}

const title = process.env.PAYASO_DIALOG_TITLE ?? '';
if (title === '') throw new Error('win32-folder-dialog-worker: PAYASO_DIALOG_TITLE is required');
if (process.send === undefined) {
  throw new Error('win32-folder-dialog-worker must run as a child process with an IPC channel');
}
const send = process.send.bind(process);
const post = (message) => {
  send(message, () => {
    if (process.connected) process.disconnect();
  });
};
process.on('disconnect', () => process.exit(0));

try {
  const path = runFolderDialog(await loadWin32DialogBindings(), title, (threadId) => {
    post({ kind: 'showing', threadId });
  });
  post({ kind: 'done', path });
} catch (error) {
  post({ kind: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
}
