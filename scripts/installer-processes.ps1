[CmdletBinding()]
param(
    [string]$InstallDirectory,
    [string]$ExecutableName = 'GitCode.exe',
    [switch]$Silent,
    [switch]$FunctionsOnly
)
$ErrorActionPreference = 'Stop'

function ConvertTo-InstalledPath([string]$Value) {
    $full = [IO.Path]::GetFullPath($Value)
    if (-not [IO.File]::Exists($full)) { return $full }
    if (-not ('GitCodeInstaller.NativePaths' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace GitCodeInstaller {
    public static class NativePaths {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder name, uint size, uint flags);
    }
}
'@
    }
    $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        $buffer = New-Object Text.StringBuilder 32768
        $length = [GitCodeInstaller.NativePaths]::GetFinalPathNameByHandle($stream.SafeFileHandle.DangerousGetHandle(), $buffer, $buffer.Capacity, 0)
        if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Cannot resolve the installation executable path.' }
        $resolved = $buffer.ToString()
        if ($resolved.StartsWith('\\?\UNC\')) { return '\\' + $resolved.Substring(8) }
        if ($resolved.StartsWith('\\?\')) { return $resolved.Substring(4) }
        return $resolved
    } finally { $stream.Dispose() }
}
function Get-InstalledProcesses([string]$Target) {
    $name = [IO.Path]::GetFileNameWithoutExtension($Target)
    foreach ($item in [Diagnostics.Process]::GetProcessesByName($name)) {
        $keep = $false
        try {
            if ($item.HasExited) { continue }
            $actual = $item.MainModule.FileName
            if (-not $actual) { throw 'Cannot read the executable path.' }
            if ([String]::Equals((ConvertTo-InstalledPath $actual), $Target, [StringComparison]::OrdinalIgnoreCase)) {
                $keep = $true
                $item
            }
        } catch {
            if (-not $item.HasExited) { throw 'Cannot inspect a running GitCode process. Run the installer with the same permissions as GitCode.' }
        } finally {
            if (-not $keep) { $item.Dispose() }
        }
    }
}
function Test-InstalledRunning([string]$Target) {
    $items = @(Get-InstalledProcesses $Target)
    try { return $items.Count -gt 0 } finally { foreach ($item in $items) { $item.Dispose() } }
}
function Request-InstalledClose([string]$Target) {
    $items = @(Get-InstalledProcesses $Target)
    try {
        foreach ($item in $items) {
            if (-not $item.HasExited -and $item.MainWindowHandle -ne [IntPtr]::Zero) {
                [void]$item.CloseMainWindow()
            }
        }
    } finally { foreach ($item in $items) { $item.Dispose() } }
}
function Stop-InstalledProcesses([string]$Target) {
    # Enumerate again and hold each process handle before killing it; do not kill by image name.
    $items = @(Get-InstalledProcesses $Target)
    try {
        foreach ($item in $items) {
            if (-not $item.HasExited) {
                $null = $item.Handle
                if (-not $item.HasExited -and [String]::Equals((ConvertTo-InstalledPath $item.MainModule.FileName), $Target, [StringComparison]::OrdinalIgnoreCase)) {
                    $tool = Join-Path ([Environment]::GetFolderPath('System')) 'taskkill.exe'
                    $info = New-Object Diagnostics.ProcessStartInfo
                    $info.FileName = $tool
                    $info.Arguments = '/PID ' + $item.Id + ' /T /F'
                    $info.UseShellExecute = $false
                    $info.CreateNoWindow = $true
                    $info.RedirectStandardOutput = $true
                    $info.RedirectStandardError = $true
                    $killer = [Diagnostics.Process]::Start($info)
                    try {
                        $null = $killer.StandardOutput.ReadToEnd()
                        $null = $killer.StandardError.ReadToEnd()
                        $killer.WaitForExit()
                        if ($killer.ExitCode -ne 0 -and -not $item.HasExited) { throw 'Cannot terminate the installed application tree.' }
                    } finally { $killer.Dispose() }
                }
            }
        }
    } finally { foreach ($item in $items) { $item.Dispose() } }
}
if ($FunctionsOnly) { return }

try {
    if (-not $InstallDirectory -or -not [IO.Path]::IsPathRooted($InstallDirectory) -or
        [IO.Path]::GetFileName($ExecutableName) -ne $ExecutableName -or
        [IO.Path]::GetExtension($ExecutableName) -ne '.exe') { throw 'Invalid installation directory or executable name.' }
    $target = ConvertTo-InstalledPath (Join-Path $InstallDirectory $ExecutableName)
    if (-not (Test-InstalledRunning $target)) { exit 0 }
    # Unattended installation must not silently terminate Git operations or terminals.
    if ($Silent) { exit 2 }
    $assembly = $env:GITCODE_INSTALLER_DIALOG_ASSEMBLY
    if (-not $assembly -or -not [IO.File]::Exists($assembly)) { throw 'Installer dialog assembly is unavailable.' }
    $null = [Reflection.Assembly]::LoadFrom($assembly)
    $result = [InstallerTaskDialog]::Show(
        [Func[bool]]{ Test-InstalledRunning $target },
        [Action]{ Request-InstalledClose $target },
        [Action]{ Stop-InstalledProcesses $target }
    )
    if ($result -and -not (Test-InstalledRunning $target)) { exit 0 }
    exit 2
} catch {
    # The installer handles detection/PowerShell failures without replacing any application files.
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 3
}
