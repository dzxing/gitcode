param([string]$ProjectSource, [string]$WorkDirectory, [string]$ReportDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class InstallerDialogProbe {
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
}
'@
New-Item -ItemType Directory -Path (Join-Path $WorkDirectory 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectSource 'scripts\installer-launcher.cs') -Destination (Join-Path $WorkDirectory 'scripts\installer-launcher.cs')
New-Item -ItemType Directory -Path (Join-Path $WorkDirectory 'assets') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectSource 'assets\icon.ico') -Destination (Join-Path $WorkDirectory 'assets\icon.ico')
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectSource 'scripts\prepare-installer.ps1') -ProjectRoot $WorkDirectory
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed' }
$launcher = Join-Path $WorkDirectory '.gitcode-local\installer\gitcode-installer-launcher.exe'
$helper = Join-Path $WorkDirectory 'installer-processes.ps1'
Copy-Item -LiteralPath (Join-Path $ProjectSource 'scripts\installer-processes.ps1') -Destination $helper
. $helper -FunctionsOnly
$exe = Join-Path $WorkDirectory 'Fixture.exe'
Add-Type -TypeDefinition @'
using System;
using System.Windows.Forms;
public class InstallerDialogFixture {
 [STAThread] public static void Main(string[] args) {
  var form = new Form(); form.Text = "GitCode installer test fixture";
  if (args.Length > 0 && args[0] == "block") form.FormClosing += (s,e) => { e.Cancel = true; };
  Application.Run(form);
 }
}
'@ -ReferencedAssemblies System.Windows.Forms -OutputAssembly $exe -OutputType WindowsApplication
$target = ConvertTo-InstalledPath $exe
$otherDirectory = Join-Path $WorkDirectory 'other'
New-Item -ItemType Directory -Path $otherDirectory | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $otherDirectory 'Fixture.exe')
$owned = New-Object Collections.Generic.List[Diagnostics.Process]
function Start-Fixture([switch]$Block, [switch]$Other) {
    $path = if ($Other) { Join-Path $otherDirectory 'Fixture.exe' } else { $exe }
    $info = New-Object Diagnostics.ProcessStartInfo $path
    if ($Block) { $info.Arguments = 'block' }
    $process = [Diagnostics.Process]::Start($info)
    $null = $process.Handle
    $owned.Add($process)
    if (-not $process.WaitForInputIdle(10000)) { throw 'Fixture window not ready' }
    return $process
}
function Start-Dialog([string]$Script = $helper) {
    $info = New-Object Diagnostics.ProcessStartInfo $launcher
    $info.Arguments = '"' + $Script + '" "' + $WorkDirectory + '" Fixture.exe'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($info)
    $null = $process.Handle
    $owned.Add($process)
    $until = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $child = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $process.Id) | Select-Object -First 1
        if ($child) {
            $owned.Add([Diagnostics.Process]::GetProcessById([int]$child.ProcessId))
            return @{ Process = $process; ChildId = [int]$child.ProcessId }
        }
        Start-Sleep -Milliseconds 100
    } while (-not $process.HasExited -and [DateTime]::UtcNow -lt $until)
    throw 'Dialog host did not start'
}
function Window($dialog) {
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,$dialog.ChildId)
    return [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,$condition)
}
function Wait-Element($dialog, [string]$Name, [int]$Seconds = 12) {
    $until = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $window = Window $dialog
        if ($window) {
            $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$Name)
            $element = $window.FindFirst([Windows.Automation.TreeScope]::Descendants,$condition)
            if ($element -and $element.Current.IsEnabled) { return $element }
        }
        Start-Sleep -Milliseconds 100
    } while (-not $dialog.Process.HasExited -and [DateTime]::UtcNow -lt $until)
    $window = Window $dialog
    if ($window) {
        $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
        foreach ($element in $elements) { Write-Output ("UI_ELEMENT=" + $element.Current.Name + " ID=" + $element.Current.AutomationId) }
    }
    throw "Dialog element not found: $Name; exited=$($dialog.Process.HasExited)"
}
function Click($element) { $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Handle($dialog) { return [IntPtr](Window $dialog).Current.NativeWindowHandle }
function Assert-Default($dialog,[string]$Name) {
    $button = Wait-Element $dialog $Name
    $until = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $button = Wait-Element $dialog $Name
        $handle = [IntPtr]$button.Current.NativeWindowHandle
        $style = [InstallerDialogProbe]::GetWindowLong($handle,-16)
        if ($handle -ne [IntPtr]::Zero -and ($style -band 0xf) -eq 1) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $until)
    throw "Native default button is not $Name; HWND=$handle STYLE=$style FOCUS=$($button.Current.HasKeyboardFocus)"
}
function Key($dialog,[int]$Code) {
    $handle = Handle $dialog
    [void][InstallerDialogProbe]::PostMessage($handle,0x100,[IntPtr]$Code,[IntPtr]::Zero)
    [void][InstallerDialogProbe]::PostMessage($handle,0x101,[IntPtr]$Code,[IntPtr]::Zero)
}
function Wait-Exit($dialog,[int]$Code) {
    if (-not $dialog.Process.WaitForExit(10000) -or $dialog.Process.ExitCode -ne $Code) {
        throw "Unexpected dialog exit code: $($dialog.Process.ExitCode), expected $Code"
    }
}
function Capture($dialog,[string]$Name) {
    if (-not $ReportDirectory) { return }
    New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
    $rect = New-Object InstallerDialogProbe+Rect
    $handle = Handle $dialog
    [void][InstallerDialogProbe]::GetWindowRect($handle,[ref]$rect)
    $image = New-Object Drawing.Bitmap($rect.Right-$rect.Left),($rect.Bottom-$rect.Top)
    $graphics = [Drawing.Graphics]::FromImage($image)
    $dc = $graphics.GetHdc()
    try { if (-not [InstallerDialogProbe]::PrintWindow($handle,$dc,2)) { throw 'Dialog capture failed' } }
    finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
    try { $image.Save((Join-Path $ReportDirectory ($Name+'.png')),[Drawing.Imaging.ImageFormat]::Png) }
    finally { $image.Dispose() }
}
try {
    $app = Start-Fixture
    $dialog = Start-Dialog
    $close = Wait-Element $dialog '关闭并继续'
    Capture $dialog 'ready'
    Assert-Default $dialog '关闭并继续'
    Click $close
    Wait-Exit $dialog 0
    if (-not $app.WaitForExit(5000)) { throw 'Normal close left the app running' }
    Write-Output 'NORMAL_CLOSE_PASSED'

    $other = Start-Fixture -Other
    $app = Start-Fixture -Block
    $dialog = Start-Dialog
    $close = Wait-Element $dialog '关闭并继续'
    $originalHandle = Handle $dialog
    Click $close
    $null = Wait-Element $dialog '正在关闭 GitCode…'
    Assert-Default $dialog '取消安装'
    Capture $dialog 'waiting'
    $null = Wait-Element $dialog '强制关闭并继续' 30
    if ((Handle $dialog) -ne $originalHandle) { throw 'Page transition recreated the window' }
    Assert-Default $dialog '取消安装'
    if (-not (Wait-Element $dialog '取消安装').Current.HasKeyboardFocus) { throw 'Force page focus is not on Cancel' }
    Capture $dialog 'force'
    Key $dialog 13
    Wait-Exit $dialog 2
    if ($app.HasExited -or $other.HasExited) { throw 'Enter on force page terminated an app' }
    Write-Output 'FORCE_DEFAULT_CANCEL_AND_ENTER_PASSED'

    $dialog = Start-Dialog
    $null = Wait-Element $dialog '关闭并继续'
    Key $dialog 27
    Wait-Exit $dialog 2
    if ($app.HasExited) { throw 'Escape terminated the app' }
    Write-Output 'ESCAPE_CANCEL_PASSED'

    $dialog = Start-Dialog
    Click (Wait-Element $dialog '关闭并继续')
    Click (Wait-Element $dialog '强制关闭并继续' 30)
    Wait-Exit $dialog 0
    if (-not $app.WaitForExit(5000) -or $other.HasExited) { throw 'Force close affected the wrong application' }
    Write-Output 'FORCE_CLOSE_TARGET_ONLY_PASSED'

    $app = Start-Fixture
    $dialog = Start-Dialog
    $null = Wait-Element $dialog '关闭并继续'
    Request-InstalledClose $target
    Wait-Exit $dialog 0
    if (-not $app.WaitForExit(5000)) { throw 'External exit did not complete installation check' }
    Write-Output 'EXTERNAL_EXIT_PASSED'

    $probe = Join-Path $WorkDirectory 'error.ps1'
    $body = @'
param([string]$InstallDirectory,[string]$ExecutableName)
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.Application]::EnableVisualStyles()
$null = [Reflection.Assembly]::LoadFrom($env:GITCODE_INSTALLER_DIALOG_ASSEMBLY)
$result = [InstallerTaskDialog]::Show([Func[bool]]{return $true},[Action]{throw 'Fixture error'},[Action]{throw 'Fixture error'})
if ($result) { exit 0 } else { exit 2 }
'@
    [IO.File]::WriteAllText($probe,$body,(New-Object Text.UTF8Encoding($true)))
    $dialog = Start-Dialog $probe
    Click (Wait-Element $dialog '关闭并继续')
    $null = Wait-Element $dialog '无法关闭 GitCode'
    Assert-Default $dialog '取消安装'
    Capture $dialog 'error'
    Click (Wait-Element $dialog '取消安装')
    Wait-Exit $dialog 2
    Write-Output 'ACTION_ERROR_BLOCKS_INSTALLATION_PASSED'
    Write-Output 'INSTALLER_TASK_DIALOG_TESTS_PASSED'
} finally {
    foreach ($process in $owned) {
        try { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null } } catch {} finally { $process.Dispose() }
    }
}
