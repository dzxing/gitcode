'use strict'
const { createHash, randomUUID } = require('node:crypto')

function parseConfig(raw) {
  if (raw && !raw.endsWith('\0')) throw new Error('Git 配置输出不完整。')
  const values = new Map()
  for (const record of raw.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\n')
    const key = separator < 0 ? record : record.slice(0, separator)
    const value = separator < 0 ? null : record.slice(separator + 1)
    if (!key) throw new Error('Git 配置格式无效。')
    values.set(key, [...(values.get(key) || []), value])
  }
  return { all: (key) => values.get(key) || [], get: (key) => values.get(key)?.at(-1) }
}
function boolean(value) {
  return value === null || ['true', 'yes', 'on', '1'].includes(String(value).toLowerCase())
}
function displayUrl(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value.replace(/\/\/[^/@]+@/, '//…@')
  }
}
const fetchFlags = [
  '--no-tags',
  '--no-prune',
  '--no-prune-tags',
  '--no-recurse-submodules',
  '--no-write-fetch-head',
  '--refmap=',
]

class SyncOperations {
  constructor(git, validRemote) {
    this.service = git
    this.validRemote = validRemote
    this.plans = new Map()
  }
  async configuration(repo, kind, expected, signal) {
    const git = this.service
    await git.checkContext(repo, expected, signal)
    const contextHead = await git.head(repo, signal),
      contextBranch = await git.currentBranch(repo, signal)
    let head = contextHead,
      branch = contextBranch
    let selection
    if (expected.sourceRef !== undefined || expected.sourceOid !== undefined) {
      if (
        !['push', 'pull'].includes(kind) ||
        typeof expected.sourceRef !== 'string' ||
        !expected.sourceRef.startsWith('refs/heads/')
      )
        throw new Error('同步目标必须是明确的本地分支。')
      await git.checkReference(repo, expected.sourceRef, expected.sourceOid, signal)
      branch = expected.sourceRef.slice('refs/heads/'.length)
      head = expected.sourceOid
      if (kind === 'pull' && branch !== contextBranch)
        throw new Error(`请先切换到 ${branch}，再拉取其远程上游。`)
      selection = { sourceRef: expected.sourceRef, sourceOid: head }
    }
    const raw = await git.git(repo, ['config', '--null', '--list', '--includes'], { signal })
    const config = parseConfig(raw)
    const remotes = (await git.git(repo, ['remote'], { signal })).trim().split('\n').filter(Boolean)
    if (!remotes.length) throw new Error('仓库尚未配置远程，请先通过 Git 配置远程。')
    const urls = async (remote, push = false) => {
      if (!remotes.includes(remote) || remote.startsWith('-'))
        throw new Error('当前仅支持已配置的命名远程；不能自动猜测远程地址。')
      const result = (
        await git.git(repo, ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', remote], {
          signal,
        })
      )
        .trim()
        .split('\n')
        .filter(Boolean)
      if (result.length !== 1)
        throw new Error(`远程 ${remote} 配置了多个地址，当前不支持自动同步。`)
      if (!this.validRemote(result[0])) throw new Error('当前不支持该远程传输协议。')
      if (result[0].startsWith('-') || /[\r\n\0]/.test(result[0]))
        throw new Error('无效的远程地址。')
      return result[0]
    }
    const entries = []
    let destinationRef = ''
    if (kind === 'fetch') {
      for (const remote of remotes.filter(
        (name) => !boolean(config.get(`remote.${name}.skipfetchall`)),
      )) {
        if (
          remotes.some(
            (other) =>
              other !== remote &&
              (remote.startsWith(other + '/') || other.startsWith(remote + '/')),
          )
        )
          throw new Error('远程名称存在前缀重叠，无法可靠隔离获取目标。')
        const mappings = config.all(`remote.${remote}.fetch`)
        if (!mappings.length) throw new Error(`远程 ${remote} 没有分支获取映射。`)
        for (const mapping of mappings) {
          const [source, destination, extra] = String(mapping).replace(/^\+/, '').split(':')
          if (
            extra !== undefined ||
            !source?.startsWith('refs/heads/') ||
            !destination?.startsWith(`refs/remotes/${remote}/`) ||
            (source.match(/\*/g) || []).length !== (destination.match(/\*/g) || []).length
          )
            throw new Error(`远程 ${remote} 的获取映射超出远程分支范围，当前不支持。`)
          for (const ref of [source, destination])
            await git.git(repo, ['check-ref-format', '--refspec-pattern', ref], { signal })
        }
        entries.push({ remote, url: await urls(remote), mappings })
      }
      if (!entries.length) throw new Error('没有可获取的远程，所有远程均配置为跳过。')
    } else {
      if (!head || !branch)
        throw new Error('同步需要已提交的本地分支，当前可能是空仓库或分离 HEAD。')
      const pullRemote = config.get(`branch.${branch}.remote`)
      const merge = config.all(`branch.${branch}.merge`)
      if (!pullRemote || merge.length !== 1 || !merge[0]?.startsWith('refs/heads/'))
        throw new Error(`分支 ${branch} 尚无明确上游，请先通过 Git 配置上游后重试。`)
      await git.git(repo, ['check-ref-format', merge[0]], { signal })
      const remote =
        kind === 'push'
          ? config.get(`branch.${branch}.pushremote`) ||
            config.get('remote.pushdefault') ||
            pullRemote
          : pullRemote
      destinationRef = kind === 'push' && remote !== pullRemote ? `refs/heads/${branch}` : merge[0]
      await git.git(repo, ['check-ref-format', destinationRef], { signal })
      if (kind === 'push') await git.noInProgress(repo, signal)
      if (
        kind === 'push' &&
        (boolean(config.get(`remote.${remote}.mirror`)) ||
          config.all(`remote.${remote}.push`).length)
      )
        throw new Error('该远程启用了镜像或自定义推送映射，当前不支持；不会回退到普通 git push。')
      let trackingRef = ''
      if (kind === 'pull') {
        await this.cleanForPull(repo, signal)
        trackingRef = (
          await git.git(repo, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`], {
            signal,
          })
        ).trim()
        if (!trackingRef.startsWith(`refs/remotes/${remote}/`))
          throw new Error('上游引用映射超出该远程命名空间，当前不支持。')
        if (
          remotes.some(
            (other) =>
              other !== remote &&
              (remote.startsWith(other + '/') || other.startsWith(remote + '/')),
          )
        )
          throw new Error('远程名称存在前缀重叠，无法可靠隔离获取目标。')
      }
      entries.push({ remote, url: await urls(remote, kind === 'push'), mappings: [], trackingRef })
    }
    const method = kind === 'pull' && expected.method === 'merge' ? 'merge' : 'ff-only'
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          raw,
          entries,
          head,
          branch,
          contextHead,
          contextBranch,
          kind,
          destinationRef,
          method,
        }),
      )
      .digest('hex')
    return {
      repo,
      kind,
      method,
      head,
      branch: branch || 'detached HEAD',
      contextHead,
      contextBranch: contextBranch || 'detached HEAD',
      selection,
      sourceRef: branch ? `refs/heads/${branch}` : '',
      destinationRef,
      entries,
      fingerprint,
    }
  }
  async plan(repo, kind, expected, signal) {
    if (!['fetch', 'pull', 'push'].includes(kind)) throw new Error('不支持的同步操作。')
    if (typeof expected?.expectedHead !== 'string' || typeof expected?.expectedBranch !== 'string')
      throw new Error('缺少同步上下文，请刷新。')
    const value = await this.configuration(repo, kind, expected, signal)
    const id = randomUUID(),
      expiresAt = Date.now() + 300000
    for (const [key, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(key)
    if (this.plans.size >= 64) this.plans.delete(this.plans.keys().next().value)
    this.plans.set(id, { ...value, expiresAt })
    return {
      id,
      kind,
      method: value.method,
      head: value.head,
      branch: value.branch,
      worktreeBranch: value.contextBranch,
      sourceRef: value.sourceRef,
      destinationRef: value.destinationRef,
      expiresAt,
      remotes: value.entries.map(({ remote, url }) => ({ name: remote, address: displayUrl(url) })),
    }
  }
  async verify(plan, signal) {
    const current = await this.configuration(
      plan.repo,
      plan.kind,
      {
        expectedHead: plan.contextHead,
        expectedBranch: plan.contextBranch,
        method: plan.method,
        ...plan.selection,
      },
      signal,
    )
    if (current.fingerprint !== plan.fingerprint)
      throw new Error('远程地址或 Git 配置已变化，请重新确认同步目标。')
  }
  async cleanForPull(repo, signal) {
    const git = this.service
    if (
      (await git.git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { signal }))
        .length
    )
      throw new Error('当前版本仅支持干净工作区拉取。请先提交，或通过外部 Git 将更改存入 stash。')
    await git.noInProgress(repo, signal)
  }
  async execute(repo, request, signal) {
    const plan = this.plans.get(request.planId)
    this.plans.delete(request.planId)
    if (!plan || plan.repo !== repo || plan.kind !== request.action || plan.expiresAt < Date.now())
      throw new Error('同步目标已失效，请重新确认。')
    const git = this.service,
      steps = []
    await this.verify(plan, signal)
    let temporary,
      temporaryOid,
      output = '',
      failure,
      cleanupError,
      mergeResult,
      syncProblem,
      details
    try {
      if (plan.kind === 'fetch') {
        for (const entry of plan.entries) {
          if (signal?.aborted) {
            failure = new Error('获取已取消，部分远程可能已经更新。')
            break
          }
          try {
            await this.verify(plan, signal)
            output += await git.git(
              repo,
              ['fetch', ...fetchFlags, '--', entry.remote, ...entry.mappings],
              { signal, timeout: 300000 },
            )
            steps.push({ remote: entry.remote, ok: true })
          } catch (error) {
            steps.push({ remote: entry.remote, ok: false, message: git.safeError(error) })
            failure = error
          }
        }
      } else if (plan.kind === 'push') {
        const entry = plan.entries[0]
        output = await git.git(
          repo,
          [
            '-c',
            `remote.${entry.remote}.mirror=false`,
            '-c',
            'push.followTags=false',
            '-c',
            'push.recurseSubmodules=no',
            'push',
            '--no-force',
            '--no-follow-tags',
            '--recurse-submodules=no',
            '--porcelain',
            '--',
            entry.remote,
            `${plan.head}:${plan.destinationRef}`,
          ],
          { signal, timeout: 300000 },
        )
        steps.push({ remote: entry.remote, ok: true })
      } else {
        temporary = `refs/gitcode/requests/${randomUUID()}`
        const entry = plan.entries[0]
        output = await git.git(
          repo,
          [
            'fetch',
            '--porcelain',
            ...fetchFlags,
            '--',
            entry.remote,
            `${plan.destinationRef}:${temporary}`,
            `+${plan.destinationRef}:${entry.trackingRef}`,
          ],
          { signal, timeout: 300000 },
        )
        const receipt = output
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .find((fields) => fields.at(-1) === temporary)
        temporaryOid = receipt?.[2]
        if (!temporaryOid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(temporaryOid))
          throw new Error('无法确认本次获取的提交，请检查状态。')
        const current = (
          await git.git(repo, ['rev-parse', '--verify', `${temporary}^{commit}`], { signal })
        ).trim()
        if (current !== temporaryOid) throw new Error('本次获取的引用已被外部修改，停止拉取。')
        steps.push({ remote: entry.remote, ok: true })
        await this.verify(plan, signal)
        await this.cleanForPull(repo, signal)
        if (plan.method === 'merge') mergeResult = await git.merge.start(repo, temporaryOid, signal)
        else {
          await git.merge.checkIgnoredPaths(repo, temporaryOid, signal)
          output += await git.git(
            repo,
            [
              '-c',
              'merge.autoStash=false',
              '-c',
              'submodule.recurse=false',
              'merge',
              '--ff-only',
              '--no-autostash',
              '--no-overwrite-ignore',
              '--no-edit',
              '--no-stat',
              temporaryOid,
            ],
            { signal, timeout: 300000 },
          )
        }
      }
    } catch (error) {
      failure = error
      if (
        !signal?.aborted &&
        plan.kind === 'pull' &&
        temporaryOid &&
        plan.method !== 'merge' &&
        /fast-forward|快进/i.test(git.safeError(error))
      ) {
        const counts = (
          await git
            .git(repo, ['rev-list', '--left-right', '--count', `${plan.head}...${temporaryOid}`], {
              signal,
            })
            .catch(() => '')
        )
          .trim()
          .split(/\s+/)
          .map(Number)
        if (counts.length === 2 && counts.every((value) => value > 0)) {
          details = git.safeError(error)
          syncProblem = 'diverged'
          failure = new Error(
            `本地有 ${counts[0]} 个、远端有 ${counts[1]} 个独有提交，无法快进。请选择“合并远端更新”继续。`,
          )
        }
      }
      if (
        !signal?.aborted &&
        plan.kind === 'push' &&
        /Updates were rejected|non-fast-forward|fetch first/i.test(git.safeError(error))
      ) {
        details = git.safeError(error)
        syncProblem = 'push-rejected'
        failure = new Error('远端拒绝了推送，可能包含尚未整合的提交。请先获取并检查更新。')
      }
    } finally {
      if (temporary) {
        const recovery = AbortSignal.timeout(10000)
        try {
          const oid =
            temporaryOid ||
            (
              await git.git(repo, ['rev-parse', '--verify', '--quiet', temporary], {
                signal: recovery,
                allowedCodes: [0, 1],
              })
            ).trim()
          if (oid) await git.git(repo, ['update-ref', '-d', temporary, oid], { signal: recovery })
        } catch (error) {
          cleanupError = git.safeError(error)
        }
      }
    }
    const outcome = failure
      ? signal?.aborted
        ? 'cancelled'
        : steps.some((step) => step.ok)
          ? 'partial'
          : 'failed'
      : mergeResult?.outcome || 'succeeded'
    if (mergeResult) output += mergeResult.output
    return {
      output,
      outcome,
      ...(syncProblem ? { syncProblem, details } : {}),
      ...(mergeResult?.warning ? { warning: mergeResult.warning } : {}),
      ...(failure && plan.kind === 'push'
        ? {
            warning:
              syncProblem === 'push-rejected'
                ? '请获取并核对目标分支，再重新确认同步操作。'
                : '推送未正常结束，远端结果可能无法确认。请获取并核对目标分支，不要直接重复执行。',
          }
        : {}),
      ...(failure ? { error: git.safeError(failure) } : {}),
      ...(cleanupError ? { cleanupError } : {}),
      steps,
    }
  }
}
module.exports = { SyncOperations, parseConfig, displayUrl }
