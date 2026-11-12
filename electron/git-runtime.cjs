'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { getPlatform } = require('./platform.cjs')

function preference(value) {
  if (!value || !['auto', 'system', 'custom'].includes(value.mode))
    throw new Error('请选择内置优先、系统 Git 或自定义 Git。')
  if (value.mode !== 'custom') return { mode: value.mode }
  if (
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    value.path.includes('\0') ||
    value.path.length > 32768
  )
    throw new Error('请选择 Git 可执行文件的绝对路径。')
  return { mode: 'custom', path: value.path }
}

function readPreference(file) {
  try {
    return preference(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return { mode: 'auto' }
  }
}

function candidates({
  platform = process.platform,
  env = process.env,
  resourcesPath,
  selection = { mode: 'auto' },
} = {}) {
  const override = env.GITCODE_GIT_PATH || env.GITK_GIT_PATH
  if (override) return [{ path: override, source: 'environment' }]
  if (selection.mode === 'custom') return [{ path: selection.path, source: 'custom' }]
  const result = getPlatform(platform).git.candidates({ env, resourcesPath, selection })
  return result.filter((value, i) => result.findIndex((x) => x.path === value.path) === i)
}

async function discover(execute, options = {}) {
  const diagnostics = []
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const adapter = getPlatform(platform).git
  const probeOptions = { timeout: 10000, env, ...adapter.probeOptions() }
  const locations = candidates(options)
  const automatic =
    !env.GITCODE_GIT_PATH && !env.GITK_GIT_PATH && options.selection?.mode !== 'custom'
  const deferred = automatic ? locations.filter(adapter.defer) : []
  async function probe(candidate) {
    try {
      const result = await execute(candidate.path, ['--version'], probeOptions)
      const stdout = (result.stdout || '').replace(/^\uFEFF/, '').trim()
      const version = stdout.split(/\r?\n/).find((line) => /^git version /.test(line)) || ''
      const match = version.match(/^git version (\d+)\.(\d+)(?:\.|\s|$)/)
      if (
        result.code === 0 &&
        match &&
        (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 46))
      )
        return { path: candidate.path, source: candidate.source, version }
      const stderr = (result.stderr || '').trim()
      diagnostics.push(
        `${candidate.path}: ${
          result.code === 0 && match
            ? `${stdout}（需要 Git 2.46 或更高版本）`
            : stderr ||
              stdout ||
              `未返回版本信息（退出码 ${result.code ?? '未知'}${result.termination ? `，信号 ${result.termination}` : ''}）`
        }`,
      )
    } catch (error) {
      diagnostics.push(`${candidate.path}: ${error.code || error.message}`)
    }
    return null
  }
  for (const candidate of locations) {
    if (deferred.includes(candidate)) continue
    const found = await probe(candidate)
    if (found) return found
  }
  if (automatic && adapter.resolve) {
    const extra = await adapter.resolve(execute, probeOptions)
    diagnostics.push(...extra.diagnostics)
    for (const candidate of extra.candidates) {
      if (locations.some((known) => known.path === candidate.path)) continue
      const found = await probe(candidate)
      if (found) return found
    }
  }
  for (const candidate of deferred) {
    const found = await probe(candidate)
    if (found) return found
  }
  return {
    error: `未能检测到可运行的 Git（需要 2.46 或更高版本）。请在“设置 → Git → Git 运行环境”中检查检测详情或选择 Git 可执行文件。\n${diagnostics.join('\n')}`,
  }
}

function environmentForGit(env, executable, source, platform = process.platform) {
  return getPlatform(platform).git.environment(env, executable, source)
}

module.exports = { preference, readPreference, candidates, discover, environmentForGit }
