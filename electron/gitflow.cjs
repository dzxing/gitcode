'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const keys = {
  production: 'gitflow.branch.master',
  develop: 'gitflow.branch.develop',
  feature: 'gitflow.prefix.feature',
  release: 'gitflow.prefix.release',
  hotfix: 'gitflow.prefix.hotfix',
  versionTag: 'gitflow.prefix.versiontag',
}
const types = ['feature', 'release', 'hotfix']
function entries(raw) {
  const result = new Map()
  for (const record of raw.split('\0').filter(Boolean)) {
    const offset = record.indexOf('\n'),
      original = offset < 0 ? record : record.slice(0, offset)
    const first = original.indexOf('.'),
      last = original.lastIndexOf('.')
    const key =
      first === last
        ? original.toLowerCase()
        : original.slice(0, first).toLowerCase() +
          original.slice(first, last + 1) +
          original.slice(last + 1).toLowerCase()
    const value = offset < 0 ? '' : record.slice(offset + 1)
    result.set(key, [...(result.get(key) || []), value])
  }
  return result
}
function classify(config, name) {
  if (name === config.production) return 'production'
  if (name === config.develop) return 'develop'
  return (
    types.find((type) => name.startsWith(config[type]) && name.length > config[type].length) || null
  )
}
function matchRef(pattern, ref) {
  if (!pattern.includes('*')) return pattern === ref ? '' : null
  if ((pattern.match(/\*/g) || []).length !== 1) return null
  const [prefix, suffix] = pattern.split('*')
  return ref.startsWith(prefix) &&
    ref.endsWith(suffix) &&
    ref.length >= prefix.length + suffix.length
    ? ref.slice(prefix.length, suffix ? -suffix.length : undefined)
    : null
}

// Resolve tracking refs through fetch refspecs, rather than guessing at slashes
// in remote names. Exclude symbolic refs and ambiguous/negative mappings.
function remoteBases(values, branches) {
  const result = []
  const mappings = [...values].filter(
    ([key]) => key.startsWith('remote.') && key.endsWith('.fetch'),
  )
  for (const branch of branches) {
    if (branch.kind !== 'remote' || branch.symbolicTarget) continue
    const fullRef = branch.fullRef || `refs/remotes/${branch.name}`
    if (!fullRef.startsWith('refs/remotes/')) continue
    const matches = new Map()
    for (const [key, specs] of mappings) {
      const remote = key.slice(7, -6)
      for (const spec of specs) {
        if (typeof spec !== 'string' || spec.startsWith('^')) continue
        const [from, to, extra] = spec.replace(/^\+/, '').split(':')
        if (
          extra !== undefined ||
          !from?.startsWith('refs/heads/') ||
          !to?.startsWith('refs/remotes/')
        )
          continue
        const middle = matchRef(to, fullRef)
        if (
          middle === null ||
          from.includes('*') !== to.includes('*') ||
          (from.match(/\*/g) || []).length > 1
        )
          continue
        const remoteRef = from.replace('*', middle)
        if (specs.some((s) => s.startsWith('^') && matchRef(s.slice(1), remoteRef) !== null))
          continue
        matches.set(`${remote}\0${remoteRef}`, {
          fullRef,
          oid: branch.hash,
          name: branch.name,
          remote,
          remoteRef,
        })
      }
    }
    if (matches.size === 1) result.push([...matches.values()][0])
  }
  return result
}
class GitFlowOperations {
  constructor(git) {
    this.git = git
    this.plans = new Map()
    this.validatedStateConfigs = new Set()
  }
  async configuration(repo, signal, locations) {
    const common = locations?.has('config')
      ? null
      : (await this.git.git(repo, ['rev-parse', '--git-common-dir'], { signal })).trim()
    const file = locations?.get('config') || path.resolve(repo, common, 'config')
    const bytes = await fs.readFile(file)
    const raw = await this.git.git(repo, ['config', '--null', '--list', '--includes'], { signal })
    const local = await this.git.git(
      repo,
      ['config', '--local', '--no-includes', '--null', '--list'],
      { signal },
    )
    const values = entries(raw),
      localValues = entries(local)
    const signature = createHash('sha256').update(bytes).update('\0').update(raw).digest('hex')
    const worktreeConfig =
      values.has('extensions.worktreeconfig') &&
      (
        await this.git.git(repo, ['config', '--bool', '--get', 'extensions.worktreeConfig'], {
          signal,
        })
      ).trim() === 'true'
    if (worktreeConfig) {
      // Worktree scalar overrides legitimately appear after the common config.
      // Keep duplicate detection within the effective worktree scope, rather
      // than treating normal inherited overrides as conflicting multi-values.
      const worktreeFile =
        locations?.get('config.worktree') ||
        path.resolve(
          repo,
          (
            await this.git.git(repo, ['rev-parse', '--git-path', 'config.worktree'], { signal })
          ).trim(),
        )
      const exists = await fs.stat(worktreeFile).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      const worktreeValues = exists
        ? entries(
            await this.git.git(repo, ['config', '--worktree', '--null', '--list', '--includes'], {
              signal,
            }),
          )
        : new Map()
      for (const key of Object.values(keys))
        if (worktreeValues.has(key)) values.set(key, worktreeValues.get(key))
    }
    const config = Object.fromEntries(
      Object.entries(keys).map(([name, key]) => [name, values.get(key)?.at(-1)]),
    )
    const complete = Object.values(keys).every((key) => values.has(key))
    let writeError = ''
    if (worktreeConfig)
      writeError = '此仓库启用了独立 worktree 配置，暂不支持在应用中修改 GitFlow 配置。'
    if (
      !worktreeConfig &&
      Object.values(keys).some(
        (key) =>
          JSON.stringify(values.get(key) || []) !== JSON.stringify(localValues.get(key) || []),
      )
    )
      writeError = 'GitFlow 配置来自全局或 include 文件，请先将这些规则整理到仓库本地配置后再修改。'
    if ((await fs.lstat(file)).isSymbolicLink())
      writeError = '仓库配置是符号链接，请先通过 Git 修改配置。'
    return { file, bytes, values, signature, config, complete, writeError }
  }
  async validate(repo, input, signal) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('请填写 GitFlow 配置。')
    const config = {}
    for (const name of Object.keys(keys)) {
      const value = input[name]
      if (
        typeof value !== 'string' ||
        value.length > 200 ||
        /[\s\0]/.test(value) ||
        (name !== 'versionTag' && !value)
      )
        throw new Error('分支名和前缀不能为空或包含空白，标签前缀可以留空。')
      config[name] = value
    }
    for (const name of ['production', 'develop']) {
      await this.git.branchName(repo, config[name], signal)
      await this.git.git(repo, ['check-ref-format', `refs/heads/${config[name]}`], { signal })
    }
    if (
      config.production === config.develop ||
      config.production.startsWith(config.develop + '/') ||
      config.develop.startsWith(config.production + '/')
    )
      throw new Error('生产分支和开发分支必须不同，且不能形成目录冲突。')
    for (const type of types) {
      if (!config[type].endsWith('/')) throw new Error('分支前缀必须以 / 结尾，例如 feature/。')
      await this.git.branchName(repo, config[type] + 'gitcode-check', signal)
      if (
        [config.production, config.develop].some(
          (name) => name.startsWith(config[type]) || config[type].startsWith(name + '/'),
        )
      )
        throw new Error('基础分支不能与工作流前缀重叠。')
    }
    if (
      types.some((a, i) =>
        types
          .slice(i + 1)
          .some((b) => config[a].startsWith(config[b]) || config[b].startsWith(config[a])),
      )
    )
      throw new Error('Feature、Release 和 Hotfix 前缀不能互相重叠。')
    if (config.versionTag)
      await this.git.git(
        repo,
        ['check-ref-format', `refs/tags/${config.versionTag}gitcode-check`],
        { signal },
      )
    return config
  }
  async state(repo, branches, signal, locations) {
    const data = await this.configuration(repo, signal, locations)
    const defaults = {
      production:
        branches.some((b) => b.kind === 'local' && b.name === 'master') &&
        !branches.some((b) => b.kind === 'local' && b.name === 'main')
          ? 'master'
          : 'main',
      develop: 'develop',
      feature: 'feature/',
      release: 'release/',
      hotfix: 'hotfix/',
      versionTag: '',
    }
    const config = Object.fromEntries(
      Object.keys(keys).map((name) => [name, data.config[name] ?? defaults[name]]),
    )
    let error = ''
    try {
      if (Object.values(keys).some((key) => (data.values.get(key) || []).length > 1))
        throw new Error('GitFlow 规则存在重复值，请整理仓库配置后刷新。')
      const validationKey = JSON.stringify([repo, this.git.gitPath, this.git.gitVersion, config])
      if (!this.validatedStateConfigs.has(validationKey)) {
        await this.validate(repo, config, signal)
        if (this.validatedStateConfigs.size >= 32)
          this.validatedStateConfigs.delete(this.validatedStateConfigs.values().next().value)
        this.validatedStateConfigs.add(validationKey)
      }
    } catch (failure) {
      error = failure.message
    }
    const missing = [config.production, config.develop].filter(
      (name) => !branches.some((b) => b.kind === 'local' && b.name === name),
    )
    let operationError = ''
    try {
      await this.git.noInProgress(repo, signal, locations)
    } catch (failure) {
      if (signal?.aborted) throw failure
      operationError = failure.message
    }
    return {
      finish: await this.git.flowFinish.state(repo, signal, locations),
      finishSupported: true,
      config,
      signature: data.signature,
      configured: data.complete,
      ready: data.complete && !error && !missing.length,
      missing,
      remoteBases: remoteBases(data.values, branches),
      error,
      writeError: data.writeError,
      operationError,
    }
  }
  async guarded(repo, request, signal) {
    if (typeof request.expectedHead !== 'string' || typeof request.expectedBranch !== 'string')
      throw new Error('缺少仓库上下文，请刷新。')
    await this.git.checkContext(repo, request, signal)
    const data = await this.configuration(repo, signal)
    if (request.signature !== data.signature)
      throw new Error('仓库配置已变化，请刷新后重新核对 GitFlow 规则。')
    return data
  }
  async plan(repo, request, signal) {
    const data = await this.guarded(repo, request, signal)
    if (data.writeError) throw new Error(data.writeError)
    await this.git.noInProgress(repo, signal)
    const config = await this.validate(repo, request.config, signal)
    if (!(await this.git.head(repo, signal)))
      throw new Error('仓库尚无提交，请先创建首次提交，再初始化 GitFlow。')
    const refs = (
      await this.git.git(
        repo,
        [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(symref)',
          'refs/heads',
          'refs/remotes',
        ],
        { signal },
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\0'))
    const existing = new Map(
        refs.filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, oid]) => [ref, oid]),
      ),
      checks = new Map(),
      creates = []
    const remoteSources = remoteBases(
      data.values,
      refs
        .filter(([ref]) => ref.startsWith('refs/remotes/'))
        .map(([fullRef, hash, symbolicTarget]) => ({
          kind: 'remote',
          fullRef,
          hash,
          symbolicTarget,
          name: fullRef.slice('refs/remotes/'.length),
        })),
    )
    for (const name of [config.production, config.develop]) {
      const ref = `refs/heads/${name}`
      if (existing.has(ref)) {
        checks.set(ref, existing.get(ref))
        continue
      }
      if (
        [...existing.keys()].some(
          (other) => ref.startsWith(other + '/') || other.startsWith(ref + '/'),
        )
      )
        throw new Error(`基础分支 ${name} 与现有分支形成目录冲突，请修改规则。`)
      const sourceRef = request.sources?.[name]
      const tracking = remoteSources.find(
        (item) => item.fullRef === sourceRef && item.remoteRef === `refs/heads/${name}`,
      )
      if (typeof sourceRef !== 'string' || (!existing.has(sourceRef) && !tracking))
        throw new Error(`请为缺失的 ${name} 明确选择现有本地起点，或可唯一定位的远端同名分支。`)
      if (tracking) await this.verifyRemote(repo, tracking, signal)
      const oid = tracking?.oid || existing.get(sourceRef)
      checks.set(sourceRef, oid)
      creates.push({ name, sourceRef, oid, ...(tracking ? { tracking } : {}) })
    }
    const id = randomUUID(),
      expiresAt = Date.now() + 300000
    for (const [key, value] of this.plans) if (value.expiresAt < Date.now()) this.plans.delete(key)
    if (this.plans.size >= 64) this.plans.delete(this.plans.keys().next().value)
    this.plans.set(id, {
      repo,
      config,
      creates,
      checks: [...checks],
      signature: data.signature,
      expectedHead: request.expectedHead,
      expectedBranch: request.expectedBranch,
      expiresAt,
    })
    return {
      id,
      config,
      creates,
      retained: [config.production, config.develop].filter(
        (name) => !creates.some((c) => c.name === name),
      ),
      references: [...checks].map(([fullRef, oid]) => ({ fullRef, oid })),
      expiresAt,
    }
  }
  async verifyRemote(repo, source, signal) {
    await this.git.git(repo, ['check-ref-format', source.remoteRef], { signal })
    const raw = await this.git.git(
      repo,
      ['ls-remote', '--exit-code', '--refs', '--', source.remote, source.remoteRef],
      { signal, timeout: 30000, allowedCodes: [0, 2] },
    )
    const advertised = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter(([, ref]) => ref === source.remoteRef)
    if (!advertised.length)
      throw new Error(
        `远端 ${source.remote} 已不存在 ${source.remoteRef.slice('refs/heads/'.length)}，未创建本地分支。请选择本地起点重新预览，或先清理过期的远端跟踪引用。`,
      )
    if (advertised.length !== 1 || advertised[0][0] !== source.oid)
      throw new Error(`远端 ${source.remote} 的基础分支已更新，请先获取远端分支后重新预览。`)
  }
  // Lock the common config using Git's own lock-file convention. Build the full
  // replacement before touching refs; preserve unrelated settings and file mode.
  async save(repo, data, config, beforeCommit, signal, tracking = []) {
    if (data.writeError) throw new Error(data.writeError)
    const lock = data.file + '.lock'
    let owned = false
    try {
      const mode = (await fs.stat(data.file)).mode & 0o777
      const handle = await fs.open(lock, 'wx', mode)
      owned = true
      try {
        await handle.writeFile(data.bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if ((await this.configuration(repo, signal)).signature !== data.signature)
        throw new Error('仓库配置已变化，请刷新后重试。')
      for (const [name, key] of Object.entries(keys))
        await this.git.git(
          repo,
          ['config', '--file', lock, '--no-includes', '--replace-all', key, config[name]],
          { signal },
        )
      for (const item of tracking) {
        await this.git.git(
          repo,
          [
            'config',
            '--file',
            lock,
            '--no-includes',
            '--replace-all',
            `branch.${item.name}.remote`,
            item.tracking.remote,
          ],
          { signal },
        )
        await this.git.git(
          repo,
          [
            'config',
            '--file',
            lock,
            '--no-includes',
            '--replace-all',
            `branch.${item.name}.merge`,
            item.tracking.remoteRef,
          ],
          { signal },
        )
      }
      if (signal?.aborted) throw new Error('操作已取消，尚未保存配置。')
      // Update-ref is transactional, but refs and config are separate resources.
      // If the final rename fails, the caller reports the created refs explicitly.
      if (beforeCommit) await beforeCommit()
      if ((await fs.readFile(data.file)).compare(data.bytes))
        throw new Error('配置文件在执行期间发生变化，请检查已创建的分支并刷新。')
      await fs.rename(lock, data.file)
      owned = false
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error('仓库配置正被其他 Git 操作使用，请稍后刷新重试。')
      throw error
    } finally {
      if (owned) await fs.rm(lock, { force: true })
    }
  }
  async execute(repo, request, signal) {
    if (request.action === 'gitflow-init') {
      const plan = this.plans.get(request.planId)
      this.plans.delete(request.planId)
      if (!plan || plan.repo !== repo || plan.expiresAt < Date.now())
        throw new Error('初始化预览已失效，请重新预览。')
      const data = await this.guarded(repo, { ...plan }, signal)
      await this.git.noInProgress(repo, signal)
      for (const item of plan.creates)
        if (item.tracking) await this.verifyRemote(repo, item.tracking, signal)
      let touched = false
      try {
        await this.save(
          repo,
          data,
          plan.config,
          async () => {
            await this.git.checkContext(repo, plan, signal)
            const commands = [
              'start',
              ...plan.checks.map(([ref, oid]) => `verify ${ref} ${oid}`),
              ...plan.creates.map((item) => `create refs/heads/${item.name} ${item.oid}`),
              'prepare',
              'commit',
              '',
            ].join('\n')
            // A killed process may have committed already. Treat any ambiguous
            // transaction failure as uncertain; snapshot is always reread outside.
            touched = plan.creates.length > 0
            await this.git.git(
              repo,
              ['update-ref', '--no-deref', '--stdin', '-m', 'GitCode: initialize GitFlow'],
              { input: commands, signal },
            )
          },
          signal,
          plan.creates.filter((item) => item.tracking),
        )
      } catch (error) {
        if (touched)
          return {
            outcome: 'partial',
            output: '',
            error: error.message,
            warning: '初始化未完整结束，分支可能已创建。请刷新检查分支和配置，不要直接重复执行。',
          }
        throw error
      }
      return {
        outcome: 'succeeded',
        output: `GitFlow 已初始化；${plan.creates.some((item) => item.tracking) ? '已从所选远端恢复并关联本地分支；' : ''}已有分支保持原位置，未切换或推送。`,
      }
    }
    const data = await this.guarded(repo, request, signal)
    if (request.action === 'gitflow-save') {
      const config = await this.validate(repo, request.config, signal)
      await this.save(repo, data, config, null, signal)
      return { outcome: 'succeeded', output: '已保存仓库 GitFlow 规则；已有分支不会改名或移动。' }
    }
    if (request.action !== 'gitflow-start' || !types.includes(request.type))
      throw new Error('不支持的 GitFlow 操作。')
    if (
      !data.complete ||
      Object.values(keys).some((key) => (data.values.get(key) || []).length !== 1)
    )
      throw new Error('请先完成 GitFlow 配置与初始化。')
    const config = await this.validate(repo, data.config, signal)
    for (const name of [config.production, config.develop]) {
      const oid = (
        await this.git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
          allowedCodes: [0, 1],
          signal,
        })
      ).trim()
      if (!oid) throw new Error(`缺少基础分支 ${name}，请先初始化。`)
    }
    await this.git.noInProgress(repo, signal)
    if (
      typeof request.name !== 'string' ||
      !request.name ||
      /\s/.test(request.name) ||
      request.name.startsWith('-') ||
      request.name.length > 200
    )
      throw new Error('请填写有效的分支名称后缀，本应用不接受空白字符。')
    if (typeof request.switchAfter !== 'boolean') throw new Error('请选择是否创建后切换。')
    const name = await this.git.branchName(repo, config[request.type] + request.name, signal)
    await this.git.git(repo, ['check-ref-format', `refs/heads/${name}`], { signal })
    const source = `refs/heads/${request.type === 'hotfix' ? config.production : config.develop}`
    await this.git.checkReference(repo, source, request.sourceOid, signal)
    if (
      (
        await this.git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
          allowedCodes: [0, 1],
          signal,
        })
      ).trim()
    )
      throw new Error('同名本地分支已存在，请刷新检查。')
    return this.git.autoStash.run(
      repo,
      'GitFlow Start',
      signal,
      async () => {
        await this.guarded(repo, request, signal)
        await this.git.checkReference(repo, source, request.sourceOid, signal)
        try {
          await this.git.git(repo, ['branch', '--no-track', '--', name, request.sourceOid], {
            signal,
          })
        } catch (error) {
          try {
            const actual = (
              await this.git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
                allowedCodes: [0, 1],
                signal: AbortSignal.timeout(5000),
              })
            ).trim()
            if (actual)
              return {
                outcome: 'partial',
                output: '',
                error: error.message,
                warning: `已检测到分支 ${name}，创建命令未正常返回。请刷新核对实际状态，不要重复创建。`,
              }
          } catch {
            return {
              outcome: 'partial',
              output: '',
              error: error.message,
              warning: '无法核实分支是否已创建，请刷新检查，不要重复执行。',
            }
          }
          throw error
        }
        if (request.switchAfter) {
          try {
            await this.git.checkContext(repo, request, signal)
            await this.git.checkReference(repo, source, request.sourceOid, signal)
            await this.git.checkReference(repo, `refs/heads/${name}`, request.sourceOid, signal)
            await this.git.git(
              repo,
              [
                '-c',
                'submodule.recurse=false',
                'switch',
                '--no-overwrite-ignore',
                '--no-guess',
                name,
              ],
              { signal },
            )
          } catch (error) {
            return {
              outcome: 'partial',
              output: '',
              warning: `${name} 已创建，但切换未完成：${error.message}。请刷新检查，不要重复创建。`,
            }
          }
        }
        return {
          outcome: 'succeeded',
          output: `已创建 ${name}${request.switchAfter ? ' 并切换' : ''}；仅保存在本地，尚未推送。`,
        }
      },
      request.switchAfter ? name : await this.git.currentBranch(repo, signal),
    )
  }
}
module.exports = { GitFlowOperations, classify }
