[CmdletBinding()]
param([string]$ProjectRoot)
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
$ErrorActionPreference = 'Stop'
$directory = Join-Path $ProjectRoot '.gitcode-local\installer'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$output = Join-Path $directory 'gitcode-installer-launcher.exe'
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
$manifest = Join-Path $directory 'installer.manifest'
[IO.File]::WriteAllText($manifest, @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="GitCode.Installer" version="1.0.0.0" processorArchitecture="*" />
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" /></dependentAssembly></dependency>
</assembly>
'@, (New-Object Text.UTF8Encoding($false)))
$compiler = New-Object CodeDom.Compiler.CompilerParameters
$compiler.CompilerOptions = '/target:winexe /win32icon:"' + (Join-Path $ProjectRoot 'assets\icon.ico') + '" /win32manifest:"' + $manifest + '"'
$compiler.GenerateExecutable = $true
$compiler.OutputAssembly = $output
$compiler.ReferencedAssemblies.AddRange(@('System.dll', 'System.Core.dll'))
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
    $result = $provider.CompileAssemblyFromFile($compiler, (Join-Path $ProjectRoot 'scripts\installer-launcher.cs'))
    if ($result.Errors.HasErrors) { throw ($result.Errors | Out-String) }
} finally { $provider.Dispose() }
if (-not (Test-Path -LiteralPath $output)) { throw 'Installer launcher compilation failed' }
Write-Output 'Console-free installer launcher prepared'
