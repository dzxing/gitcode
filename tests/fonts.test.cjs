const test = require('node:test')
const assert = require('node:assert/strict')
const { installedFonts, normalizeFamilies } = require('../electron/fonts.cjs')

test('system font names are sorted, deduplicated and exclude vertical/control entries', () => {
  assert.deepEqual(
    normalizeFamilies(['Consolas', '微软雅黑', 'Consolas', '@微软雅黑', '\ninvalid', '']),
    ['Consolas', '微软雅黑'].sort((a, b) => a.localeCompare(b)),
  )
  assert.throws(() => normalizeFamilies(null))
})
test('font enumeration uses fixed commands with UTF-8 on Windows and bounded subprocesses', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const fonts = await installedFonts(platform, async (command, args, options) => {
      assert.equal(options.timeout, 15000)
      assert.equal(options.windowsHide, true)
      if (platform === 'win32') {
        assert.match(command, /powershell.exe$/)
        assert.match(args.at(-1), /UTF8Encoding/)
      } else if (platform === 'darwin') assert.equal(command, '/usr/bin/osascript')
      else assert.deepEqual(args, ['-f', '%{family}\n'])
      return {
        stdout:
          platform === 'linux'
            ? 'Consolas,等距字体\nConsolas\n'
            : (platform === 'win32' ? '\uFEFF' : '') + JSON.stringify(['Consolas', '等距字体']),
      }
    })
    assert.equal(fonts.length, 2)
    assert.ok(fonts.includes('等距字体'))
  }
  await assert.rejects(
    installedFonts('linux', async () => {
      throw Error('fc-list unavailable')
    }),
    /fc-list unavailable/,
  )
})
