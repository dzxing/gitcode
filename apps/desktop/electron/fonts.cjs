'use strict'
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { getPlatform } = require('./platform.cjs')
const run = promisify(execFile)
// eslint-disable-next-line no-control-regex -- Font family names must exclude C0 controls.
const CONTROL_CHARACTERS = /[\x00-\x1f]/
function normalizeFamilies(values) {
  if (!Array.isArray(values)) throw Error('无法读取系统字体列表。')
  return [
    ...new Set(
      values
        .filter(
          (value) =>
            typeof value === 'string' &&
            value.length <= 120 &&
            !value.startsWith('@') &&
            !CONTROL_CHARACTERS.test(value),
        )
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b))
}
async function installedFonts(platform = process.platform, execute = run, env = process.env) {
  const options = {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    env,
  }
  return normalizeFamilies(await getPlatform(platform).fonts.read(execute, options))
}
module.exports = { installedFonts, normalizeFamilies }
