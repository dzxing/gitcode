'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const list = (raw) => raw.split('\0').filter(Boolean)
const hash = (value) => createHash('sha256').update(value).digest('hex')

class FetchSettings {
  constructor(git) {
    this.git = git
  }
  async inspect(repo, signal) {
    const git = this.git
    const configPath = (await git.gitPaths(repo, ['config'], signal)).get('config')
    const regularConfig = (await fs.lstat(configPath)).isFile()
    const original = await fs.readFile(configPath)
    const raw = await git.git(repo, ['config', '--null', '--list', '--includes'], { signal })
    const names = (await git.git(repo, ['remote'], { signal })).trim().split('\n').filter(Boolean)
    const remotes = []
    for (const name of names) {
      const key = `remote.${name}.fetch`
      const mappings = list(
        await git.git(repo, ['config', '--null', '--get-all', key], { signal, optional: true }),
      )
      const local = list(
        await git.git(repo, ['config', '--local', '--no-includes', '--null', '--get-all', key], {
          signal,
          optional: true,
        }),
      )
      const all = `refs/heads/*:refs/remotes/${name}/*`
      const branches = []
      let mode =
        mappings.length === 1 && mappings[0].replace(/^\+/, '') === all ? 'all' : 'selected'
      for (const mapping of mappings) {
        const parts = mapping.replace(/^\+/, '').split(':')
        const [source, destination] = parts
        const branch = source?.slice('refs/heads/'.length)
        if (
          parts.length !== 2 ||
          !source?.startsWith('refs/heads/') ||
          !branch ||
          branch.includes('*') ||
          destination !== `refs/remotes/${name}/${branch}`
        ) {
          if (mode !== 'all') mode = 'custom'
        } else branches.push(branch)
      }
      const overlap = names.some(
        (other) => other !== name && (other.startsWith(name + '/') || name.startsWith(other + '/')),
      )
      const editable =
        mappings.length > 0 &&
        mode !== 'custom' &&
        JSON.stringify(local) === JSON.stringify(mappings) &&
        regularConfig &&
        !overlap
      const skipped = (
        await git.git(repo, ['config', '--type=bool', '--get', `remote.${name}.skipFetchAll`], {
          signal,
          optional: true,
        })
      ).trim()
      remotes.push({
        name,
        mode,
        branches,
        mappings,
        editable,
        skipped: /^(true|yes|on|1)$/i.test(skipped),
        reason: editable
          ? ''
          : '包含自定义、继承、链接文件或重叠的获取规则，请通过 Git 配置调整；此处不会覆盖。',
      })
    }
    const shallow =
      (await git.git(repo, ['rev-parse', '--is-shallow-repository'], { signal })).trim() === 'true'
    return {
      configPath,
      original,
      value: {
        path: repo,
        shallow,
        remotes,
        signature: hash(raw + '\0' + hash(original) + '\0' + shallow),
      },
    }
  }
  async read(repo, signal) {
    return (await this.inspect(repo, signal)).value
  }
  async execute(repo, request, signal) {
    const git = this.git
    if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
      throw Error('缺少仓库上下文，请重新打开获取设置。')
    await git.checkContext(repo, request, signal)
    const state = await this.inspect(repo, signal)
    if (request.signature !== state.value.signature)
      throw Error('仓库获取配置已变化，请重新读取设置后再操作。')
    const remote = state.value.remotes.find((remote) => remote.name === request.remote)
    if (!remote) throw Error('远端已不存在，请重新读取设置。')
    if (request.action === 'unshallow') {
      if (!state.value.shallow) throw Error('当前仓库已不是浅仓库，无需补全历史。')
      // Reuse the sync validator so no configured mapping can overwrite local branches or tags.
      const plan = await git.sync.configuration(repo, 'fetch', request, signal)
      const entry = plan.entries.find((entry) => entry.remote === remote.name)
      if (!entry) throw Error('该远端配置为跳过获取，请先调整 Git 配置。')
      const output = await git.git(
        repo,
        [
          'fetch',
          '--unshallow',
          '--no-tags',
          '--no-prune',
          '--no-prune-tags',
          '--no-recurse-submodules',
          '--no-write-fetch-head',
          '--refmap=',
          '--',
          entry.remote,
          ...entry.mappings,
        ],
        { signal, timeout: 300000 },
      )
      const shallow =
        (await git.git(repo, ['rev-parse', '--is-shallow-repository'], { signal })).trim() ===
        'true'
      return {
        outcome: 'succeeded',
        output,
        ...(shallow
          ? { warning: '获取已完成，但仓库仍有浅历史边界；远端本身可能也是浅仓库。' }
          : {}),
      }
    }
    if (request.action !== 'set-fetch-scope' || !remote.editable)
      throw Error(remote.reason || '不支持此获取设置操作。')
    if (!['all', 'selected'].includes(request.mode)) throw Error('请选择全部分支或指定分支。')
    let branches = []
    if (request.mode === 'selected') {
      if (
        !Array.isArray(request.branches) ||
        !request.branches.length ||
        request.branches.length > 100
      )
        throw Error('请填写 1～100 个分支名。')
      branches = [...new Set(request.branches)]
      for (const branch of branches) {
        if (
          typeof branch !== 'string' ||
          branch.length > 1024 ||
          branch.startsWith('-') ||
          /[\s\0*]/.test(branch)
        )
          throw Error('分支名无效，请填写不带 refs/heads/ 前缀的完整分支名。')
        await git.git(repo, ['check-ref-format', `refs/heads/${branch}`], { signal })
      }
    }
    const mappings =
      request.mode === 'all'
        ? [`+refs/heads/*:refs/remotes/${remote.name}/*`]
        : branches.map((branch) => `+refs/heads/${branch}:refs/remotes/${remote.name}/${branch}`)
    const confirmTrust = git.runtimeOptions.enforceRepositoryTrust
      ? await git.trust.approvedFetchChange(repo, remote.name, mappings, signal)
      : null
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-fetch-config-'))
    const file = path.join(temporary, 'config'),
      lock = state.configPath + '.lock'
    let handle,
      ownsLock = false
    try {
      await fs.writeFile(file, state.original, { mode: 0o600 })
      await git.git(
        repo,
        ['config', '--file', file, '--replace-all', `remote.${remote.name}.fetch`, mappings[0]],
        { signal },
      )
      for (const mapping of mappings.slice(1))
        await git.git(
          repo,
          ['config', '--file', file, '--add', `remote.${remote.name}.fetch`, mapping],
          { signal },
        )
      const replacement = await fs.readFile(file)
      handle = await fs.open(lock, 'wx', (await fs.stat(state.configPath)).mode)
      ownsLock = true
      const latest = (await this.inspect(repo, signal)).value
      if (
        hash(await fs.readFile(state.configPath)) !== hash(state.original) ||
        latest.signature !== request.signature ||
        !latest.remotes.find((item) => item.name === remote.name)?.editable
      )
        throw Error('仓库配置已变化，未覆盖其他工具的修改，请重新读取。')
      await git.checkContext(repo, request, signal)
      await handle.writeFile(replacement)
      await handle.sync()
      await handle.close()
      handle = null
      signal?.throwIfAborted()
      await fs.rename(lock, state.configPath)
      ownsLock = false
      await confirmTrust?.()
      return {
        outcome: 'succeeded',
        output: '获取范围已保存；历史深度未改变。点击获取后更新分支列表。',
      }
    } catch (error) {
      if (error.code === 'EEXIST') throw Error('Git 配置正被其他操作占用，请稍后重试。')
      throw error
    } finally {
      await handle?.close().catch(() => {})
      if (ownsLock) await fs.unlink(lock).catch(() => {})
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }
}
module.exports = { FetchSettings }
