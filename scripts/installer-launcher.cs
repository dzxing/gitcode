using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;

// Compiled as a Windows GUI application: neither this process nor its child allocates a console.
internal static class InstallerLauncher {
    private static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    [STAThread]
    private static int Main(string[] args) {
        if (args.Length != 3 && args.Length != 4) return 3;
        if (args.Length == 4 && args[3] != "silent") return 3;
        try {
            string windows = Environment.GetEnvironmentVariable("SystemRoot");
            string system = Environment.Is64BitOperatingSystem && !Environment.Is64BitProcess ? "Sysnative" : "System32";
            var info = new ProcessStartInfo();
            info.FileName = Path.Combine(windows, system, @"WindowsPowerShell\v1.0\powershell.exe");
            info.Arguments = "-NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File " + Quote(args[0]) +
                " -InstallDirectory " + Quote(args[1]) + " -ExecutableName " + Quote(args[2]) +
                (args.Length == 4 ? " -Silent" : "");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.EnvironmentVariables["GITCODE_INSTALLER_DIALOG_ASSEMBLY"] = typeof(InstallerLauncher).Assembly.Location;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (var process = Process.Start(info)) {
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                stdout.GetAwaiter().GetResult();
                stderr.GetAwaiter().GetResult();
                return process.ExitCode;
            }
        } catch { return 3; }
    }
}

// Hosted on the PowerShell STA thread so process-check delegates stay on their runspace thread.
public sealed class InstallerTaskDialog : IDisposable {
    private const int Cancel = 2, Close = 100, ForceClose = 110;
    private const uint NavigatePage = 0x400 + 101, ClickButton = 0x400 + 102;
    private enum Stage { Ready, Waiting, Force, Stopping, Error }
    private readonly Func<bool> isRunning;
    private readonly Action requestClose, forceClose;
    private readonly Callback callback;
    private readonly List<IntPtr> allocations = new List<IntPtr>();
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private Stage stage;
    private long deadline;
    private bool completed;
    private IntPtr largeIcon, smallIcon;

    // CommCtrl.h wraps TASKDIALOG_BUTTON and TASKDIALOGCONFIG in pshpack1.h.
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct Button { public int id; public IntPtr text; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct Config {
        public uint size;
        public IntPtr owner, instance;
        public uint flags, commonButtons;
        public IntPtr title, icon, instruction, content;
        public uint buttonCount;
        public IntPtr buttons;
        public int defaultButton;
        public uint radioCount;
        public IntPtr radios;
        public int defaultRadio;
        public IntPtr verification, expanded, expandedControl, collapsedControl, footerIcon, footer, callback, callbackData;
        public uint width;
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int Callback(IntPtr window, uint notification, IntPtr wParam, IntPtr lParam, IntPtr data);
    [DllImport("comctl32.dll", PreserveSig = true)]
    private static extern int TaskDialogIndirect(IntPtr config, out int button, IntPtr radio, IntPtr verification);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ActivationContext {
        public uint size, flags;
        public string source;
        public ushort architecture, language;
        public string directory;
        public IntPtr resource;
        public string application;
        public IntPtr module;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateActCtx(ref ActivationContext context);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ActivateActCtx(IntPtr context, out UIntPtr cookie);
    [DllImport("kernel32.dll")]
    private static extern bool DeactivateActCtx(uint flags, UIntPtr cookie);
    [DllImport("kernel32.dll")]
    private static extern void ReleaseActCtx(IntPtr context);
    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint ExtractIconEx(string path, int index, out IntPtr large, out IntPtr small, uint count);
    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);

    private InstallerTaskDialog(Func<bool> isRunning, Action requestClose, Action forceClose) {
        this.isRunning = isRunning;
        this.requestClose = requestClose;
        this.forceClose = forceClose;
        callback = Notify;
        ExtractIconEx(typeof(InstallerTaskDialog).Assembly.Location, 0, out largeIcon, out smallIcon, 1);
    }
    private IntPtr Allocate(int bytes) {
        IntPtr pointer = Marshal.AllocHGlobal(bytes);
        allocations.Add(pointer);
        return pointer;
    }
    private IntPtr Text(string value) {
        IntPtr pointer = Marshal.StringToHGlobalUni(value);
        allocations.Add(pointer);
        return pointer;
    }
    private IntPtr Page(Stage next) {
        var config = new Config();
        config.size = (uint)Marshal.SizeOf(typeof(Config));
        config.flags = 0x8 | 0x800; // Allow Esc/X cancellation and timer callbacks.
        config.title = Text("GitCode 安装程序");
        config.width = 220; // Keep native padding; dialog units scale with the system font and monitor DPI.
        string instruction, content, action = null;
        int actionId = Close;
        switch (next) {
            case Stage.Ready:
                instruction = "安装前需要关闭 GitCode";
                content = "安装程序将请求关闭正在运行的版本，然后继续安装。";
                action = "关闭并继续";
                break;
            case Stage.Waiting:
                instruction = "正在关闭 GitCode…";
                content = "如果 GitCode 显示退出确认，请先在应用中完成确认。";
                break;
            case Stage.Force:
                instruction = "GitCode 尚未退出";
                content = "强制关闭可能丢失未保存的草稿，并中止 Git 操作和终端命令。";
                action = "强制关闭并继续";
                actionId = ForceClose;
                config.icon = new IntPtr(65535); // TD_WARNING_ICON
                break;
            case Stage.Stopping:
                instruction = "正在结束 GitCode 进程…";
                content = "进程退出后将继续安装。";
                break;
            default:
                instruction = "无法关闭 GitCode";
                content = "安装尚未开始。请检查运行权限后重试。";
                config.icon = new IntPtr(65535);
                break;
        }
        if (next == Stage.Waiting || next == Stage.Stopping) config.flags |= 0x400;
        config.instruction = Text(instruction);
        config.content = Text(content);
        config.defaultButton = next == Stage.Ready ? Close : Cancel;
        config.buttonCount = action == null ? 1u : 2u;
        int buttonSize = Marshal.SizeOf(typeof(Button));
        config.buttons = Allocate(buttonSize * (int)config.buttonCount);
        Marshal.StructureToPtr(new Button { id = Cancel, text = Text("取消安装") }, config.buttons, false);
        if (action != null) Marshal.StructureToPtr(new Button { id = actionId, text = Text(action) }, IntPtr.Add(config.buttons, buttonSize), false);
        config.callback = Marshal.GetFunctionPointerForDelegate(callback);
        IntPtr pointer = Allocate((int)config.size);
        Marshal.StructureToPtr(config, pointer, false);
        return pointer;
    }
    private void Navigate(IntPtr window, Stage next) {
        stage = next;
        deadline = clock.ElapsedMilliseconds + (next == Stage.Waiting ? 20000 : 10000);
        SendMessage(window, NavigatePage, IntPtr.Zero, Page(next));
    }
    private int Notify(IntPtr window, uint notification, IntPtr wParam, IntPtr lParam, IntPtr data) {
        try {
            if (notification == 0 || notification == 1) { // Created / navigated
                SendMessage(window, 0x80, IntPtr.Zero, smallIcon); // WM_SETICON / ICON_SMALL
                SendMessage(window, 0x80, new IntPtr(1), largeIcon);
                if (stage == Stage.Waiting || stage == Stage.Stopping)
                    SendMessage(window, 0x400 + 107, new IntPtr(1), new IntPtr(30)); // Start native marquee.
            } else if (notification == 2) { // Button clicked
                int id = wParam.ToInt32();
                if (id == Cancel) return 0;
                if (id == Close && stage == Stage.Ready) {
                    Navigate(window, Stage.Waiting);
                    requestClose();
                } else if (id == ForceClose && stage == Stage.Force) {
                    Navigate(window, Stage.Stopping);
                    forceClose();
                }
                return 1; // An action never closes the dialog before all target processes exit.
            } else if (notification == 4 && stage != Stage.Error) { // Timer
                if (!isRunning()) {
                    completed = true;
                    SendMessage(window, ClickButton, new IntPtr(Cancel), IntPtr.Zero);
                } else if (clock.ElapsedMilliseconds >= deadline) {
                    if (stage == Stage.Waiting) Navigate(window, Stage.Force);
                    else if (stage == Stage.Stopping) Navigate(window, Stage.Error);
                }
            }
        } catch {
            // Exceptions must never cross the native callback boundary or enable installation.
            if (stage != Stage.Error) Navigate(window, Stage.Error);
            if (notification == 2) return 1;
        }
        return 0;
    }
    public static bool Show(Func<bool> isRunning, Action requestClose, Action forceClose) {
        if (isRunning == null || requestClose == null || forceClose == null) throw new ArgumentNullException();
        var activation = new ActivationContext();
        activation.size = (uint)Marshal.SizeOf(typeof(ActivationContext));
        activation.flags = 0x8; // ACTCTX_FLAG_RESOURCE_NAME_VALID
        activation.source = typeof(InstallerTaskDialog).Assembly.Location;
        activation.resource = new IntPtr(1); // Embedded Win32 manifest, also available in the PowerShell child.
        IntPtr context = CreateActCtx(ref activation);
        if (context == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        UIntPtr cookie;
        if (!ActivateActCtx(context, out cookie)) {
            int error = Marshal.GetLastWin32Error();
            ReleaseActCtx(context);
            throw new System.ComponentModel.Win32Exception(error);
        }
        IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4)); // Per-monitor v2
        try {
            using (var dialog = new InstallerTaskDialog(isRunning, requestClose, forceClose)) {
                int button;
                int result = TaskDialogIndirect(dialog.Page(Stage.Ready), out button, IntPtr.Zero, IntPtr.Zero);
                GC.KeepAlive(dialog.callback);
                Marshal.ThrowExceptionForHR(result);
                return dialog.completed;
            }
        } finally {
            if (previousDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
            DeactivateActCtx(0, cookie);
            ReleaseActCtx(context);
        }
    }

    public void Dispose() {
        if (largeIcon != IntPtr.Zero) DestroyIcon(largeIcon);
        if (smallIcon != IntPtr.Zero) DestroyIcon(smallIcon);
        foreach (IntPtr pointer in allocations) Marshal.FreeHGlobal(pointer);
        allocations.Clear();
    }
}
