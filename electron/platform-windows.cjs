'use strict'
const path = require('node:path').win32

function gitCandidates({ env }) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  const result = (env[pathKey] || '')
    .split(';')
    .slice(0, 64)
    .map((directory) => directory.replace(/^"|"$/g, ''))
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => ({ path: path.join(directory, 'git.exe'), source: 'system' }))
  result.push({ path: 'git.exe', source: 'system' })
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'])
    if (env[key])
      for (const suffix of [['Git'], ['Programs', 'Git']])
        result.push({ path: path.join(env[key], ...suffix, 'cmd/git.exe'), source: 'system' })
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
    environment: (env) => env,
  }),
  fonts: Object.freeze({ read: readFonts }),
})
