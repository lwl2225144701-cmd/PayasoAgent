// Windows 更新交接工具：NSIS 调用它，生命周期独立于被替换的 Electron。
// .NET Framework 4.x（Windows 内置），不依赖应用目录里的 Node/Electron。
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public sealed class LinkSnapshot {
    public string Path;
    public string Bytes;
    public bool Create;
}
public sealed class UpdateSnapshot {
    public string Exe;
    public string OldVersion;
    public string OldHash;
    public List<LinkSnapshot> Links = new List<LinkSnapshot>();
}

public static class PayasoUpdate {
    // 禁用对象 ID 与路径跟踪；不改变系统服务或其他应用链接。
    const uint NoTracking = 0x00000100 | 0x00040000 | 0x00100000;
    const string AppId = "com.payaso.agent";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static string LogPath;

    [STAThread]
    public static int Main(string[] args) {
        LogPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PayasoAgent", "logs", "windows-install.log");
        try {
            if (args.Length < 1) throw new ArgumentException("Missing operation");
            Log("begin " + String.Join(" | ", args));
            switch (args[0]) {
#if PAYASO_TESTING
                case "test-launch":
                    LaunchAndConfirm(args[1], args[2], Int32.Parse(args[3]), true); break;
#endif
                case "prepare":
                    if (args.Length != 5) throw new ArgumentException("prepare state exe desktop startmenu");
                    Prepare(args[1], args[2], new string[] { args[3], args[4] }); break;
                case "finish":
                    if (args.Length != 3) throw new ArgumentException("finish state exe");
                    Finish(args[1], args[2]); break;
                case "restore":
                    if (args.Length != 2) throw new ArgumentException("restore state");
                    Restore(args[1]); break;
                case "repair":
                    if (args.Length != 4) throw new ArgumentException("repair exe desktop startmenu");
                    RequireExe(args[1]);
                    foreach (string link in new string[] { args[2], args[3] })
                        if (File.Exists(link)) CreateLink(link, args[1]);
                    break;
                case "inspect":
                    if (args.Length != 2) throw new ArgumentException("inspect link");
                    Console.WriteLine(Json.Serialize(Inspect(args[1]))); break;
                case "launch":
                    if (args.Length < 3 || args.Length > 4) throw new ArgumentException("launch exe version [timeoutMs]");
                    LaunchAndConfirm(args[1], args[2], args.Length == 4 ? Int32.Parse(args[3]) : 90000); break;
                default: throw new ArgumentException("Unknown operation");
            }
            Log("completed " + args[0]);
            return 0;
        } catch (Exception error) {
            Log("FAILED " + error.ToString());
            Console.Error.WriteLine(error.Message + "\nLog: " + LogPath);
            return 1;
        }
    }

    static void Log(string value) {
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
            File.AppendAllText(LogPath, DateTime.UtcNow.ToString("o") + " " + value + Environment.NewLine, Encoding.UTF8);
        } catch { /* 诊断目录不可写不改变操作本身结果。 */ }
    }
    static bool SamePath(string a, string b) {
        return String.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }
    static void RequireExe(string exe) {
        if (!Path.IsPathRooted(exe) || !File.Exists(exe) || !String.Equals(Path.GetExtension(exe), ".exe", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Application executable missing or invalid: " + exe);
    }
    static string HashFile(string file) {
        using (var hash = SHA256.Create()) using (var input = File.OpenRead(file)) return Convert.ToBase64String(hash.ComputeHash(input));
    }
    static UpdateSnapshot ReadState(string state) {
        return Json.Deserialize<UpdateSnapshot>(File.ReadAllText(state, Encoding.UTF8));
    }
    static void Prepare(string state, string exe, string[] links) {
        bool fresh = !File.Exists(exe);
        var snapshot = new UpdateSnapshot { Exe = Path.GetFullPath(exe), OldVersion = fresh ? null : FileVersionInfo.GetVersionInfo(exe).ProductVersion };
        snapshot.OldHash = fresh ? null : HashFile(exe);
        foreach (string link in links) {
            if (link == "-") continue;
            bool exists = File.Exists(link);
            // 路径由安装器从 Windows shell 目录提供；只管理本应用的已知名称。
            if (!String.Equals(Path.GetFileName(link), "PayasoAgent.lnk", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Unexpected shortcut name: " + link);
            snapshot.Links.Add(new LinkSnapshot { Path = link, Create = exists || fresh, Bytes = exists ? Convert.ToBase64String(File.ReadAllBytes(link)) : null });
            if (exists) {
                try { Log("snapshot " + Json.Serialize(Inspect(link))); }
                catch (Exception error) { Log("unreadable shortcut (bytes backed up): " + link + " " + error.Message); }
            }
        }
        // 先落盘完整快照，部分删除失败也能恢复此前删除的链接。
        File.WriteAllText(state, Json.Serialize(snapshot), Encoding.UTF8);
        try {
            foreach (LinkSnapshot link in snapshot.Links) if (link.Bytes != null) File.Delete(link.Path);
            NotifyShell();
        } catch { Restore(state); throw; }
    }
    static void Finish(string state, string exe) {
        RequireExe(exe);
        UpdateSnapshot snapshot = ReadState(state);
        if (!SamePath(snapshot.Exe, exe)) throw new IOException("Installation directory changed during update");
        foreach (LinkSnapshot link in snapshot.Links) if (link.Create) CreateLink(link.Path, exe);
        NotifyShell();
    }
    static void Restore(string state) {
        if (!File.Exists(state)) return;
        UpdateSnapshot snapshot = ReadState(state);
        if (!File.Exists(snapshot.Exe)) throw new IOException("Cannot restore shortcuts: executable missing");
        bool oldStillPresent = snapshot.OldHash != null && snapshot.OldHash == HashFile(snapshot.Exe);
        foreach (LinkSnapshot link in snapshot.Links) {
            if (oldStillPresent && link.Bytes != null) File.WriteAllBytes(link.Path, Convert.FromBase64String(link.Bytes));
            else if (link.Create) CreateLink(link.Path, snapshot.Exe);
        }
        NotifyShell();
    }

    static object NewShellLink() { return new ShellLink(); }
    public static Dictionary<string, object> Inspect(string file) {
        object com = NewShellLink();
        try {
            ((IPersistFile)com).Load(file, 0);
            var link = (IShellLinkW)com;
            var target = new StringBuilder(32768);
            var cwd = new StringBuilder(32768);
            var icon = new StringBuilder(32768);
            int iconIndex;
            // SLGP_RAWPATH，只读，不调用 Resolve，避免取证改变链接。
            link.GetPath(target, target.Capacity, IntPtr.Zero, 4);
            link.GetWorkingDirectory(cwd, cwd.Capacity);
            link.GetIconLocation(icon, icon.Capacity, out iconIndex);
            uint flags;
            Marshal.ThrowExceptionForHR(((IShellLinkDataList)com).GetFlags(out flags));
            return new Dictionary<string, object> { { "file", file }, { "target", target.ToString() }, { "cwd", cwd.ToString() }, { "icon", icon.ToString() }, { "flags", flags } };
        } finally { Marshal.FinalReleaseComObject(com); }
    }
    static void CreateLink(string file, string exe) {
        RequireExe(exe);
        object com = NewShellLink();
        string temp = file + "." + Guid.NewGuid().ToString("N") + ".lnk";
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            var link = (IShellLinkW)com;
            link.SetPath(exe);
            link.SetWorkingDirectory(Path.GetDirectoryName(exe));
            link.SetIconLocation(exe, 0);
            link.SetDescription("PayasoAgent");
            uint flags;
            var data = (IShellLinkDataList)com;
            Marshal.ThrowExceptionForHR(data.GetFlags(out flags));
            Marshal.ThrowExceptionForHR(data.SetFlags(flags | NoTracking));
            SetAppId(com);
            ((IPersistFile)com).Save(temp, true);
            Dictionary<string, object> observed = Inspect(temp);
            if (!SamePath((string)observed["target"], exe) || ((uint)observed["flags"] & NoTracking) != NoTracking)
                throw new IOException("Shortcut verification failed: " + file);
            // 替换整个新链接，避免加载旧链接的跟踪数据。
            if (File.Exists(file)) File.Delete(file);
            File.Move(temp, file);
            Log("link verified " + Json.Serialize(Inspect(file)));
        } finally {
            Marshal.FinalReleaseComObject(com);
            if (File.Exists(temp)) File.Delete(temp);
        }
    }
    static void SetAppId(object com) {
        var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
        var value = new PropVariant { Type = 31, Pointer = Marshal.StringToCoTaskMemUni(AppId) };
        try {
            var store = (IPropertyStore)com;
            Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
            Marshal.ThrowExceptionForHR(store.Commit());
        } finally { Marshal.FreeCoTaskMem(value.Pointer); }
    }
    static void NotifyShell() { SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); }

    static void LaunchAndConfirm(string exe, string version, int timeout, bool testSameUser = false) {
        RequireExe(exe);
        if (timeout < 100 || timeout > 120000) throw new ArgumentException("Invalid readiness timeout");
        string token = Guid.NewGuid().ToString("N");
        string pipeName = "PayasoAgent-update-" + token;
        IntPtr userToken = IntPtr.Zero;
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        bool elevated = !testSameUser && new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        try {
            if (elevated) {
                userToken = InteractiveToken();
                using (var identity = new WindowsIdentity(userToken)) user = identity.User;
            }
            var security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security)) {
                IAsyncResult connection = pipe.BeginWaitForConnection(null, null);
                string args = "--updated --payaso-update-token=" + token;
                int pid = StartAsUser(exe, args, userToken);
                Log("launch pid=" + pid + " exe=" + exe + " version=" + version + " user=" + user.Value);
                if (!connection.AsyncWaitHandle.WaitOne(timeout)) throw new TimeoutException("New application did not connect to readiness pipe");
                pipe.EndWaitForConnection(connection);
                uint clientPid;
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out clientPid) || clientPid != (uint)pid)
                    throw new IOException("Readiness pipe client is not the launched application");
                // 有界读取，防止已连接但未回报的进程永久拖住安装器。
                byte[] buffer = new byte[4096];
                var received = new MemoryStream();
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeout);
                while (received.Length < buffer.Length) {
                    int remaining = Math.Max(1, (int)(deadline - DateTime.UtcNow).TotalMilliseconds);
                    IAsyncResult read = pipe.BeginRead(buffer, 0, buffer.Length - (int)received.Length, null, null);
                    if (!read.AsyncWaitHandle.WaitOne(remaining)) throw new TimeoutException("New application did not report ready");
                    int count = pipe.EndRead(read);
                    if (count == 0) break;
                    received.Write(buffer, 0, count);
                    if (Array.IndexOf(buffer, (byte)10, 0, count) >= 0) break;
                }
                var ack = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(received.ToArray()));
                if ((string)ack["token"] != token || (string)ack["version"] != version || !SamePath((string)ack["exe"], exe) || Convert.ToInt32(ack["pid"]) != pid)
                    throw new IOException("New application readiness identity did not match this update");
                using (Process process = Process.GetProcessById(pid)) if (process.HasExited) throw new IOException("New application exited before verification");
                Log("READY " + Json.Serialize(ack));
            }
        } finally { if (userToken != IntPtr.Zero) CloseHandle(userToken); }
    }
    static int StartAsUser(string exe, string args, IntPtr token) {
        if (token == IntPtr.Zero) {
            using (Process process = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) })) return process.Id;
        }
        IntPtr environment = IntPtr.Zero;
        try {
            if (!CreateEnvironmentBlock(out environment, token, false)) throw new Win32Exception();
            var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Desktop = "winsta0\\default" };
            ProcessInformation process;
            if (!CreateProcessWithTokenW(token, 1, exe, new StringBuilder("\"" + exe + "\" " + args), 0x400, environment, Path.GetDirectoryName(exe), ref startup, out process)) throw new Win32Exception();
            CloseHandle(process.Thread);
            CloseHandle(process.Process);
            return process.Pid;
        } finally { if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment); }
    }
    static IntPtr InteractiveToken() {
        uint pid;
        GetWindowThreadProcessId(GetShellWindow(), out pid);
        if (pid == 0) throw new IOException("Interactive Explorer process not found; refusing elevated application launch");
        using (Process explorer = Process.GetProcessById((int)pid)) {
            if (explorer.SessionId != Process.GetCurrentProcess().SessionId) throw new IOException("Interactive user session mismatch");
            IntPtr source, token;
            if (!OpenProcessToken(explorer.Handle, 0x000A, out source)) throw new Win32Exception();
            try {
                if (!DuplicateTokenEx(source, 0x000B, IntPtr.Zero, 2, 1, out token)) throw new Win32Exception();
                return token;
            } finally { CloseHandle(source); }
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr findData, uint flags);
        void GetIDList(out IntPtr id); void SetIDList(IntPtr id);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder cwd, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string cwd);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short key); void SetHotkey(short key); void GetShowCmd(out int cmd); void SetShowCmd(int cmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
    [ComImport, Guid("45E2B4AE-B1C3-11D0-B92F-00A0C90312E1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IShellLinkDataList {
        [PreserveSig] int AddDataBlock(IntPtr data); [PreserveSig] int CopyDataBlock(uint signature, out IntPtr data);
        [PreserveSig] int RemoveDataBlock(uint signature); [PreserveSig] int GetFlags(out uint flags); [PreserveSig] int SetFlags(uint flags);
    }
    [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore {
        [PreserveSig] int GetCount(out uint count); [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value); [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value); [PreserveSig] int Commit();
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved; public string Desktop; public string Title;
        public int X, Y, XSize, YSize, XCount, YCount, Fill, Flags; public short Show, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public int Pid, Tid; }
    [DllImport("shell32.dll")] static extern void SHChangeNotify(uint eventId, uint flags, IntPtr first, IntPtr second);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr source, uint access, IntPtr attributes, int level, int type, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessWithTokenW(IntPtr token, uint flags, string application, StringBuilder command, uint creationFlags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
    [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
}
