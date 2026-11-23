param([string]$ProjectSource, [string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Join-Path $WorkDirectory 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectSource 'scripts\installer-launcher.cs') -Destination (Join-Path $WorkDirectory 'scripts\installer-launcher.cs')
New-Item -ItemType Directory -Path (Join-Path $WorkDirectory 'assets') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectSource 'assets\icon.ico') -Destination (Join-Path $WorkDirectory 'assets\icon.ico')
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectSource 'scripts\prepare-installer.ps1') -ProjectRoot $WorkDirectory
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed' }
$launcher = Join-Path $WorkDirectory '.gitcode-local\installer\gitcode-installer-launcher.exe'
$bytes = [IO.File]::ReadAllBytes($launcher)
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
if ([BitConverter]::ToUInt16($bytes, $pe + 24 + 68) -ne 2) { throw 'Launcher must use the GUI subsystem' }
$folder = Join-Path $WorkDirectory 'argument fixture'
New-Item -ItemType Directory -Path $folder | Out-Null
$script = Join-Path $folder 'probe.ps1'
$resultFile = Join-Path $folder 'result.json'
$probe = @'
param([string]$InstallDirectory, [string]$ExecutableName, [switch]$Silent)
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class ConsoleProbe{[DllImport("kernel32.dll")]public static extern IntPtr GetConsoleWindow();}'
@{directory=$InstallDirectory;name=$ExecutableName;silent=[bool]$Silent;hasConsole=([ConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json') -Encoding UTF8
if ($ExecutableName -eq 'cancel.exe') { exit 2 }
'@
[IO.File]::WriteAllText($script,$probe,(New-Object Text.UTF8Encoding($true)))
$directory = 'C:\GitCode QA directory\trailing\'
# Use the same explicit quoting as an installer command line, including a trailing slash.
$arguments = '"' + $script + '" "' + $directory.TrimEnd('\') + '\\" "GitCode.exe" silent'
$process = Start-Process -FilePath $launcher -ArgumentList $arguments -PassThru
$null = $process.Handle
if (-not $process.WaitForExit(15000) -or $process.ExitCode -ne 0) { throw 'Launcher did not return success' }
$process.Dispose()
$result = Get-Content -Raw -LiteralPath $resultFile | ConvertFrom-Json
if ($result.hasConsole -or $result.directory -ne $directory -or $result.name -ne 'GitCode.exe' -or -not $result.silent) { throw 'Console allocation or argument quoting regression' }
$process = Start-Process -FilePath $launcher -ArgumentList ('"' + $script + '" "C:\QA" cancel.exe') -PassThru
$null = $process.Handle
if (-not $process.WaitForExit(15000) -or $process.ExitCode -ne 2) { throw 'Cancel exit code was not preserved' }
$process.Dispose()
Write-Output 'CONSOLE_FREE_LAUNCHER_TESTS_PASSED'
