'use strict'
const path = require('node:path').posix
const os = require('node:os')

function gitCandidates({ env }) {
  return [
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/opt/local/bin/git',
    '/usr/local/git/bin/git',
    ...(typeof env.DEVELOPER_DIR === 'string' &&
    path.isAbsolute(env.DEVELOPER_DIR) &&
    !env.DEVELOPER_DIR.includes('\0')
      ? [
          path.join(env.DEVELOPER_DIR, 'usr/bin/git'),
          path.join(env.DEVELOPER_DIR, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/git'),
        ]
      : []),
    '/Library/Developer/CommandLineTools/usr/bin/git',
    '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/git',
    'git',
    '/usr/bin/git',
  ].map((location) => ({ path: location, source: 'system' }))
}
async function resolveGit(execute, options) {
  try {
    const result = await execute('/usr/bin/xcrun', ['--find', 'git'], { ...options, timeout: 5000 })
    const location = (result.stdout || '').trim()
    if (result.code === 0 && path.isAbsolute(location) && !/[\r\n\0]/.test(location))
      return { candidates: [{ path: location, source: 'system' }], diagnostics: [] }
    return {
      candidates: [],
      diagnostics: [`xcrun: ${(result.stderr || result.stdout || '未返回有效的 Git 路径').trim()}`],
    }
  } catch (error) {
    return { candidates: [], diagnostics: [`xcrun: ${error.code || error.message}`] }
  }
}
async function readFonts(execute, options) {
  const result = await execute(
    '/usr/bin/osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies))',
    ],
    options,
  )
  return JSON.parse(result.stdout)
}
module.exports = Object.freeze({
  id: 'macos',
  git: Object.freeze({
    candidates: gitCandidates,
    probeOptions: () => ({ cwd: os.homedir() }),
    defer: (candidate) => candidate.path === 'git' || candidate.path === '/usr/bin/git',
    resolve: resolveGit,
    environment: (env) => env,
  }),
  fonts: Object.freeze({ read: readFonts }),
})
