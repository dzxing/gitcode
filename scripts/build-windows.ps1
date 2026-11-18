[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64',
    [switch]$SkipInstall,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previousLocation = Get-Location

function Invoke-BuildStep {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $Executable $($Arguments -join ' ')"
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Run this script on Windows, not inside WSL.'
    }
    if ($projectRoot.StartsWith('\\')) {
        throw 'Copy the project to a Windows local directory before building. Do not use a WSL UNC path.'
    }
    Set-Location -LiteralPath $projectRoot
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    $bun = Get-Command bun.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js was not found. Install Node.js 22.12+ and reopen PowerShell.' }
    if (-not $bun) { throw 'Bun was not found. Install Bun and reopen PowerShell.' }
    $nodeVersionText = & $node.Source --version
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read the Node.js version.' }
    $nodeVersion = [version]($nodeVersionText.Trim().TrimStart('v'))
    if ($nodeVersion.Major -lt 22 -or ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -lt 12)) {
        throw 'Node.js 22.12+ is required.'
    }
    Write-Host "Node.js $nodeVersion"
    Invoke-BuildStep $bun.Source @('--version')
    if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\curl.exe'))) {
        throw 'Windows curl.exe is required to download the verified WSL core runtime.'
    }
    if (-not (Get-Command tar.exe -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'Windows tar.exe is required to prepare the WSL core runtime.'
    }
    Write-Host "Project: $projectRoot"
    Write-Host "Target: Windows $Arch (system Git, bundled WSL core runtime)"
    if ($CheckOnly) {
        Write-Host 'Environment check passed. No dependencies installed and no build started.'
        exit 0
    }
    if (-not $SkipInstall) {
        Write-Host '[1/3] Installing locked dependencies...'
        Invoke-BuildStep $bun.Source @('install', '--frozen-lockfile')
        Invoke-BuildStep $bun.Source @('install', '--cwd', 'electron', '--frozen-lockfile')
    } else {
        Write-Host '[1/3] Reusing existing Windows dependencies.'
    }
    Write-Host '[2/3] Checking and building the frontend...'
    Invoke-BuildStep $bun.Source @('run', 'build')
    Write-Host '[3/3] Packaging Windows application and verified WSL core runtime...'
    Invoke-BuildStep $node.Source @('scripts/package-desktop.mjs', '--win', "--$Arch")
    $package = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
    $installer = Join-Path $projectRoot "release\$($package.version)\GitCode Setup $($package.version).exe"
    if (-not (Test-Path -LiteralPath $installer)) { throw "Installer was not generated: $installer" }
    Write-Host "Build complete: $installer"
} catch {
    [Console]::Error.WriteLine("Build failed: $($_.Exception.Message)")
    exit 1
} finally {
    Set-Location -LiteralPath $previousLocation
}
