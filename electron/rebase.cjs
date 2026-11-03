'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const absent = (error) => {
  if (error.code === 'ENOENT') return null
  throw error
}
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
class RebaseOperations {
  constructor(git) {
    this.git = git
  }
  async location(repo, name, signal) {
    return path.resolve(
      repo,
      (await this.git.git(repo, ['rev-parse', '--git-path', name], { signal })).trim(),
    )
  }
  async metadata(repo, signal) {
    const file = await this.location(repo, 'gitcode-rebase.json', signal)
    const text = await fs.readFile(file, 'utf8').catch(absent)
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  async state(repo, signal) {
    let backend = 'merge',
      directory = await this.location(repo, 'rebase-merge', signal)
    if (!(await fs.stat(directory).catch(absent))) {
      backend = 'apply'
      directory = await this.location(repo, 'rebase-apply', signal)
      if (!(await fs.stat(directory).catch(absent))) return null
    }
    const read = async (name) =>
      (await fs.readFile(path.join(directory, name), 'utf8').catch(absent))?.trim() || ''
    // git am also uses rebase-apply, but is not a rebase operation.
    if (backend === 'apply' && (await fs.stat(path.join(directory, 'applying')).catch(absent)))
      return null
    const [headName, onto, original, stopped, step, total, todo, done, autostash, message] =
      await Promise.all(
        [
          'head-name',
          'onto',
          'orig-head',
          'stopped-sha',
          backend === 'merge' ? 'msgnum' : 'next',
          backend === 'merge' ? 'end' : 'last',
          'git-rebase-todo',
          'done',
          'autostash',
          'message',
        ].map(read),
      )
    const pausedOid =
      (
        await this.git.git(repo, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], {
          signal,
          allowedCodes: [0, 1],
        })
      ).trim() || stopped
    const metadata = await this.metadata(repo, signal)
    const owned =
      metadata?.originalHead === original &&
      metadata?.sourceRef === headName &&
      metadata?.targetOid === onto
    return {
      sourceBranch: headName.replace(/^refs\/heads\//, ''),
      targetOid: onto,
      originalHead: original,
      targetName: owned ? metadata.targetName : onto.slice(0, 7),
      pausedOid,
      step: Number(step) || 0,
      total: Number(total) || 0,
      backend,
      owned,
      message,
      signature: digest({
        headName,
        onto,
        original,
        pausedOid,
        step,
        total,
        todo,
        done,
        autostash,
        message,
      }),
    }
  }
  async plan(repo, info, signal) {
    await this.git.noInProgress(repo, signal)
    if (!info.head || !info.branch) throw new Error('请先检出一个已有提交的本地分支，再变基。')
    if (!info.related) throw new Error('未找到共同历史，不能变基。')
    if (info.head === info.oid) throw new Error('目标与当前分支提交相同。')
    const raw = await this.git.git(
      repo,
      [
        'log',
        '--reverse',
        '--topo-order',
        '-n',
        '201',
        '--format=%H%x00%P%x00%B%x00%an%x00%ae%x00%aI%x00',
        `${info.oid}..${info.head}`,
      ],
      { signal },
    )
    const values = raw.split('\0'),
      steps = []
    for (let i = 0; i + 5 < values.length; i += 6) {
      const sha = values[i].trim(),
        parents = values[i + 1].trim().split(' ').filter(Boolean),
        message = values[i + 2].trim()
      if (!oidPattern.test(sha)) throw new Error('无法读取待重放提交。')
      steps.push({
        sha,
        parents,
        message,
        subject: message.split('\n')[0],
        type: 'pick',
        author: values[i + 3],
        email: values[i + 4],
        date: values[i + 5],
      })
    }
    const working = await this.git.checkout.fingerprint(repo, signal)
    if ([...working.status.staged, ...working.status.unstaged].some((f) => f.status === 'U'))
      throw new Error('请先解决已有冲突，再开始变基。')
    const reason =
      steps.length > 200
        ? '交互式变基一次最多整理 200 条提交。'
        : steps.some((s) => s.parents.length !== 1)
          ? '待重放范围包含合并提交或根提交，不提供交互式变基。'
          : !steps.length
            ? '没有需要编排的提交。'
            : ''
    return {
      signature: digest({
        head: info.head,
        target: info.oid,
        ref: info.fullRef,
        working: working.signature,
        steps,
      }),
      steps: steps.slice(0, 200),
      canInteractive: !reason,
      reason,
      dirty: working.paths.length > 0,
    }
  }
  async editorOptions(repo, signal) {
    const current = await this.state(repo, signal)
    return {
      rebasePlan:
        current && !current.owned ? '' : await this.location(repo, 'gitcode-rebase.json', signal),
    }
  }
  args() {
    return [
      '-c',
      'rebase.updateRefs=false',
      '-c',
      'rebase.autoSquash=false',
      '-c',
      'core.commentChar=#',
      '-c',
      'commit.cleanup=strip',
      '-c',
      'submodule.recurse=false',
      'rebase',
    ]
  }
  async execute(repo, request, signal) {
    if (request.action === 'rebase-start') {
      const info = await this.git.navigation.reference(repo, request, signal),
        plan = await this.plan(repo, info, signal)
      if (plan.signature !== request.planSignature)
        throw new Error('分支或工作区已变化，请重新读取变基目标。')
      await this.git.checkWorktree(repo, `refs/heads/${info.branch}`, false, signal)
      await this.git.merge.checkIgnoredPaths(repo, info.oid, signal)
      let steps
      if (request.steps !== undefined) {
        if (
          !plan.canInteractive ||
          !Array.isArray(request.steps) ||
          request.steps.length !== plan.steps.length
        )
          throw new Error(plan.reason || '提交编排已失效，请重新打开。')
        const seen = new Set()
        let kept = false
        steps = request.steps.map((step) => {
          if (
            !step ||
            !['pick', 'reword', 'squash', 'drop'].includes(step.type) ||
            !plan.steps.some((s) => s.sha === step.sha) ||
            seen.has(step.sha)
          )
            throw new Error('提交编排包含无效或重复的提交。')
          seen.add(step.sha)
          if (step.type === 'squash' && !kept) throw new Error('最早保留的提交不能合并到前一条。')
          if (step.type !== 'drop') kept = true
          const original = plan.steps.find((s) => s.sha === step.sha)
          const message =
            step.type === 'reword'
              ? this.git.navigation.validators
                  .string(step.message, '提交说明', { max: 20000 })
                  .trim()
              : original.message
          if (step.type === 'reword' && !message) throw new Error('提交说明不能为空。')
          return { sha: step.sha, type: step.type, message }
        })
      }
      await this.git.checkContext(repo, request, signal)
      const latestInfo = await this.git.navigation.reference(repo, request, signal)
      if ((await this.plan(repo, latestInfo, signal)).signature !== plan.signature)
        throw new Error('执行前分支或工作区再次发生变化，请重新核对。')
      const metadataPath = await this.location(repo, 'gitcode-rebase.json', signal)
      const previous = await this.metadata(repo, signal)
      if (previous?.id && !(await this.state(repo, signal)))
        await fs.unlink(metadataPath).catch(absent)
      await fs.writeFile(
        metadataPath,
        JSON.stringify({
          id: randomUUID(),
          sourceRef: `refs/heads/${info.branch}`,
          originalHead: info.head,
          targetOid: info.oid,
          targetName: info.fullRef.startsWith('refs/')
            ? info.fullRef.replace(/^refs\/(heads|remotes|tags)\//, '')
            : info.oid.slice(0, 7),
          steps,
        }),
        { flag: 'wx' },
      )
      return this.run(
        repo,
        [
          ...this.args(),
          '--merge',
          '--no-update-refs',
          '--no-autosquash',
          '--no-fork-point',
          '--no-rebase-merges',
          '--autostash',
          ...(steps ? ['--interactive', '--reapply-cherry-picks', '--empty=stop'] : []),
          info.oid,
        ],
        signal,
      )
    }
    const state = await this.git.merge.state(repo, signal)
    if (!state?.rebase || state.signature !== request.mergeSignature)
      throw new Error('变基或文件状态已变化，请刷新后重新确认。')
    if (request.action === 'rebase-continue') {
      if (state.files.length) throw new Error('请先解决并保存所有冲突文件。')
      const status = await this.git.status(repo, signal)
      if (status.unstaged.some((f) => f.status !== '?'))
        throw new Error('仍有未暂存的修改，请先检查并暂存。')
    } else if (request.action === 'rebase-skip') {
      if (request.confirm !== true) throw new Error('跳过会丢弃当前提交的补丁，请明确确认。')
    } else if (request.action !== 'rebase-abort') throw new Error('不支持的变基操作。')
    return this.run(
      repo,
      [
        ...this.args(),
        request.action === 'rebase-continue'
          ? '--continue'
          : request.action === 'rebase-skip'
            ? '--skip'
            : '--abort',
      ],
      signal,
    )
  }
  async run(repo, args, signal) {
    let output = '',
      failure
    try {
      output = await this.git.git(repo, args, {
        signal,
        timeout: 300000,
        ...(await this.editorOptions(repo, signal)),
      })
    } catch (error) {
      failure = error
    }
    const recovery = signal?.aborted ? AbortSignal.timeout(15000) : signal
    const state = await this.state(repo, recovery)
    if (state) {
      const unresolved = (
        await this.git.git(repo, ['diff', '--name-only', '--diff-filter=U', '-z'], {
          signal: recovery,
        })
      )
        .split('\0')
        .filter(Boolean).length
      return {
        output,
        outcome: 'partial',
        warning:
          unresolved && (!failure || /conflict/i.test(failure.message))
            ? `变基已暂停，还有 ${unresolved} 个冲突文件。请在右侧处理后继续。`
            : failure
              ? /empty|no changes|nothing to commit/i.test(failure.message)
                ? '当前提交没有可重放的修改，请检查后跳过当前提交。'
                : `变基已暂停：${this.git.safeError(failure).slice(0, 600)}`
              : '变基尚未完成，请检查当前提交。',
      }
    }
    const metadataPath = await this.location(repo, 'gitcode-rebase.json', recovery)
    await fs.unlink(metadataPath).catch(absent)
    if (failure) throw failure
    const conflicts =
      (await this.git.git(repo, ['ls-files', '--unmerged', '-z'], { signal: recovery })).length > 0
    return {
      output,
      outcome: conflicts ? 'partial' : 'succeeded',
      ...(conflicts
        ? { warning: '变基操作已结束，但自动贮藏恢复发生冲突。修改与贮藏已保留，请处理恢复冲突。' }
        : {}),
    }
  }
}
module.exports = { RebaseOperations }
