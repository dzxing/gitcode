'use strict'
async function readFonts(execute, options) {
  const result = await execute('fc-list', ['-f', '%{family}\n'], options)
  return result.stdout.split(/[\n,]/)
}
module.exports = Object.freeze({
  id: 'linux',
  git: Object.freeze({
    candidates: () => [{ path: 'git', source: 'system' }],
    probeOptions: () => ({}),
    defer: () => false,
    environment: (env) => env,
  }),
  fonts: Object.freeze({ read: readFonts }),
})
