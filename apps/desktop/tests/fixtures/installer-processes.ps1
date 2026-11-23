param([string]$HelperSource, [string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
. $HelperSource -FunctionsOnly
$targetDirectory = Join-Path $WorkDirectory 'target'
$otherDirectory = Join-Path $WorkDirectory 'other'
New-Item -ItemType Directory -Path $targetDirectory,$otherDirectory -Force | Out-Null
$fixture = Join-Path $targetDirectory 'Fixture.exe'
$fixtureSource = @'
using System;
using System.Windows.Forms;
public class Fixture {
 [STAThread] public static void Main(string[] args) {
  var f = new Form(); f.Text = "GitCode installer test fixture";
  if (args.Length > 0) f.FormClosing += (s,e) => { e.Cancel = true; };
  if (args.Length > 0 && args[0] == "block") System.Diagnostics.Process.Start(Application.ExecutablePath, "child");
  Application.Run(f);
 }
}
'@
Add-Type -TypeDefinition $fixtureSource -ReferencedAssemblies System.Windows.Forms -OutputAssembly $fixture -OutputType WindowsApplication
Copy-Item -LiteralPath $fixture -Destination (Join-Path $otherDirectory 'Fixture.exe')
$owned = New-Object 'Collections.Generic.List[Diagnostics.Process]'
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HelperSource -InstallDirectory $targetDirectory -ExecutableName Fixture.exe -Silent
    if ($LASTEXITCODE -ne 0) { throw 'An idle target must allow installation' }
    $app = Start-Process -FilePath $fixture -PassThru
    $owned.Add($app)
    Start-Sleep -Milliseconds 700
    $canonical = ConvertTo-InstalledPath $fixture
    if (-not (Test-InstalledRunning $canonical)) { throw 'Running target was not detected' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HelperSource -InstallDirectory $targetDirectory -ExecutableName Fixture.exe -Silent
    if ($LASTEXITCODE -ne 2 -or $app.HasExited) { throw 'Unattended installation must leave running apps intact' }
    Request-InstalledClose $canonical
    if (-not $app.WaitForExit(5000)) { throw 'Graceful close failed' }
    $other = Start-Process -FilePath (Join-Path $otherDirectory 'Fixture.exe') -PassThru
    $blocked = Start-Process -FilePath $fixture -ArgumentList block -PassThru
    $owned.Add($other);$owned.Add($blocked)
    Start-Sleep -Milliseconds 700
    Request-InstalledClose $canonical
    Start-Sleep -Milliseconds 500
    if ($blocked.HasExited) { throw 'The blocking fixture should reject normal close' }
    $tree = @(Get-InstalledProcesses $canonical)
    try { if ($tree.Count -lt 2) { throw 'Expected an application child process' } } finally { foreach ($item in $tree) { $item.Dispose() } }
    Stop-InstalledProcesses $canonical
    if (-not $blocked.WaitForExit(5000)) { throw 'Forced close did not exit the target' }
    if (Test-InstalledRunning $canonical) { throw 'A child process was left running' }
    if ($other.HasExited) { throw 'An unrelated same-name executable was killed' }
    New-Item -ItemType Junction -Path (Join-Path $WorkDirectory 'alias') -Target $targetDirectory | Out-Null
    if ((ConvertTo-InstalledPath (Join-Path $WorkDirectory 'alias\Fixture.exe')) -ne $canonical) { throw 'Directory aliases must resolve to the same target' }
    Write-Output 'INSTALLER_PROCESS_TESTS_PASSED'
} finally {
    if ($canonical) { try { Stop-InstalledProcesses $canonical } catch {} }
    foreach ($item in $owned) {
        try { if (-not $item.HasExited) { $item.Kill();$item.WaitForExit() } } finally { $item.Dispose() }
    }
}
