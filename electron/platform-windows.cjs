'use strict'
const path = require('node:path').win32

function gitCandidates({ env, resourcesPath, selection }) {
  const result = []
  if (selection.mode === 'auto' && resourcesPath)
    result.push({ path: path.join(resourcesPath, 'git/cmd/git.exe'), source: 'bundled' })
  result.push({ path: 'git.exe', source: 'system' })
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'])
    if (env[key])
      for (const suffix of [['Git'], ['Programs', 'Git']])
        result.push({ path: path.join(env[key], ...suffix, 'cmd/git.exe'), source: 'system' })
  return result
}
function gitEnvironment(env, executable, source) {
  if (source !== 'bundled') return env
  const result = { ...env },
    root = path.dirname(path.dirname(executable))
  const current = Object.keys(result).find((key) => key.toLowerCase() === 'path')
  const previous = current ? result[current] : ''
  for (const key of Object.keys(result))
    if (key.toLowerCase() === 'path' || key.toUpperCase() === 'GIT_EXEC_PATH') delete result[key]
  result.Path = [
    path.join(root, 'cmd'),
    path.join(root, 'ucrt64/bin'),
    path.join(root, 'mingw64/bin'),
    path.join(root, 'clangarm64/bin'),
    path.join(root, 'usr/bin'),
    previous,
  ]
    .filter(Boolean)
    .join(';')
  return result
}
async function readFonts(execute, options) {
  const result = await execute(
    path.join(
      options.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Drawing; $f=New-Object System.Drawing.Text.InstalledFontCollection; try { ConvertTo-Json -InputObject @($f.Families | ForEach-Object { $_.Name }) -Compress } finally { $f.Dispose() }',
    ],
    options,
  )
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
}
module.exports = Object.freeze({
  id: 'windows',
  git: Object.freeze({
    candidates: gitCandidates,
    probeOptions: () => ({}),
    defer: () => false,
    environment: gitEnvironment,
  }),
  fonts: Object.freeze({ read: readFonts }),
})
