'use strict'

const { createHash, randomUUID } = require('node:crypto')

class CheckoutOperations {
  constructor(git) {
    this.git = git
    this.plans = new Map()
    this.remotePlans = new Map()
  }

  async remote(repo, request, signal) {
    const git = this.git
    if (!request.fullRef?.startsWith('refs/remotes/')) throw new Error('请选择明确的远程分支。')
    await git.checkReference(repo, request.fullRef, request.expectedOid, signal)
    if (
      (
        await git.git(repo, ['symbolic-ref', '-q', request.fullRef], {
          signal,
          allowedCodes: [0, 1],
        })
      ).trim()
    )
      throw new Error('请选择远程实际分支，不能检出远程 HEAD 符号引用。')
    const remotes = (await git.git(repo, ['remote'], { signal })).trim().split('\n').filter(Boolean)
    const matches = remotes.filter((r) => request.fullRef.startsWith(`refs/remotes/${r}/`))
    if (matches.length !== 1) throw new Error('远程命名空间不明确，请先检查远程配置。')
    const name = request.fullRef.slice(`refs/remotes/${matches[0]}/`.length)
    await git.branchName(repo, name, signal)
    const local = (
      await git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
        signal,
        allowedCodes: [0, 1],
      })
    ).trim()
    if (!local) return this.remoteSwitch(repo, { ...request, name }, false, signal)
    if (local === request.expectedOid) return this.switch(repo, { ...request, name }, signal)
    await git.checkWorktree(repo, `refs/heads/${name}`, false, signal)
    const upstream = (
      await git.git(repo, ['for-each-ref', '--format=%(upstream)', `refs/heads/${name}`], {
        signal,
      })
    ).trim()
    const base = (
      await git.git(repo, ['merge-base', local, request.expectedOid], {
        signal,
        allowedCodes: [0, 1],
      })
    ).trim()
    if (upstream === request.fullRef && base === local)
      return this.remoteSwitch(repo, { ...request, name, localOid: local }, true, signal)
    const id = randomUUID()
    const now = Date.now()
    for (const [key, p] of this.remotePlans) if (p.expires <= now) this.remotePlans.delete(key)
    while (this.remotePlans.size >= 32)
      this.remotePlans.delete(this.remotePlans.keys().next().value)
    this.remotePlans.set(id, {
      ...request,
      repo,
      name,
      localOid: local,
      signature: (await this.fingerprint(repo, signal)).signature,
      expires: now + 300000,
    })
    return {
      outcome: 'failed',
      output: '',
      remoteCheckoutProtection: {
        id,
        branch: name,
        remote: request.fullRef.replace('refs/remotes/', ''),
        localOid: local,
        remoteOid: request.expectedOid,
      },
      error: '同名本地分支与远程分支不同，请选择创建其他本地分支，或明确重置同名分支。',
    }
  }

  async confirmRemote(repo, request, signal) {
    const p = this.remotePlans.get(request.planId)
    if (!p || p.repo !== repo || p.expires <= Date.now())
      throw new Error('远程检出确认已过期，请重新操作。')
    await this.git.checkContext(repo, p, signal)
    if ((await this.fingerprint(repo, signal)).signature !== p.signature)
      throw new Error('文件、暂存区或配置已变化，请重新确认远程检出。')
    await this.git.checkReference(repo, p.fullRef, p.expectedOid, signal)
    await this.git.checkReference(repo, `refs/heads/${p.name}`, p.localOid, signal)
    if (!['create', 'reset'].includes(request.choice)) throw new Error('请选择新建或重置分支。')
    const name =
      request.choice === 'create' ? await this.git.branchName(repo, request.name, signal) : p.name
    this.remotePlans.delete(request.planId)
    return this.remoteSwitch(
      repo,
      { ...p, name, ...(request.choice === 'create' ? { localOid: undefined } : {}) },
      request.choice === 'reset',
      signal,
    )
  }

  async remoteSwitch(repo, p, reset, signal) {
    const git = this.git
    await git.checkReference(repo, p.fullRef, p.expectedOid, signal)
    await git.checkWorktree(repo, `refs/heads/${p.name}`, false, signal)
    await git.merge.checkIgnoredPaths(repo, p.expectedOid, signal)
    if (reset) await git.checkReference(repo, `refs/heads/${p.name}`, p.localOid, signal)
    else if (
      (
        await git.git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${p.name}`], {
          signal,
          allowedCodes: [0, 1],
        })
      ).trim()
    )
      throw new Error('同名本地分支已存在，请选择其他名称。')
    return git.autoStash.run(
      repo,
      'checkout',
      signal,
      async () => {
        await git.checkReference(repo, p.fullRef, p.expectedOid, signal)
        if (reset) await git.checkReference(repo, `refs/heads/${p.name}`, p.localOid, signal)
        // -c creates transactionally; -C is used only for a proven fast-forward
        // or an explicitly confirmed reset, with ignored-file protection intact.
        const output = await git.git(
          repo,
          [
            '-c',
            'submodule.recurse=false',
            'switch',
            '--no-overwrite-ignore',
            '--no-guess',
            reset ? '-C' : '-c',
            p.name,
            p.expectedOid,
          ],
          { signal },
        )
        await git.git(repo, ['branch', `--set-upstream-to=${p.fullRef}`, '--', p.name], { signal })
        return { outcome: 'succeeded', output }
      },
      p.name,
    )
  }

  async fingerprint(repo, signal) {
    const status = await this.git.status(repo, signal)
    const paths = [
      ...new Set(
        [...status.staged, ...status.unstaged].flatMap((f) => [
          f.path,
          ...(f.oldPath ? [f.oldPath] : []),
        ]),
      ),
    ].sort()
    const content = await this.git.selectedCommit.fingerprint(repo, paths, signal)
    const index = await this.git.indexFingerprint(repo, signal)
    const head = await this.git.head(repo, signal),
      branch = await this.git.currentBranch(repo, signal)
    const config = await this.git.git(repo, ['config', '--null', '--list', '--includes'], {
      signal,
    })
    return {
      status,
      paths,
      signature: createHash('sha256')
        .update(JSON.stringify({ status, content, index, head, branch, config }))
        .digest('hex'),
    }
  }

  async target(repo, name, expectedOid, signal) {
    await this.git.branchName(repo, name, signal)
    if (!expectedOid) throw new Error('缺少目标分支提交，请刷新后重新切换。')
    await this.git.checkReference(repo, `refs/heads/${name}`, expectedOid, signal)
    await this.git.checkWorktree(repo, `refs/heads/${name}`, false, signal)
    // Ignored files are not included in a stash. Never let checkout overwrite them.
    await this.git.merge.checkIgnoredPaths(repo, expectedOid, signal)
  }

  async switch(repo, request, signal) {
    await this.target(repo, request.name, request.expectedOid, signal)
    let before
    try {
      before = await this.fingerprint(repo, signal)
    } catch (error) {
      if (signal?.aborted) throw error
    }
    try {
      return {
        output: await this.git.git(
          repo,
          [
            '-c',
            'submodule.recurse=false',
            'switch',
            '--no-overwrite-ignore',
            '--no-guess',
            request.name,
          ],
          { signal, locale: 'C' },
        ),
        outcome: 'succeeded',
      }
    } catch (error) {
      if (
        signal?.aborted ||
        !before?.paths.length ||
        !/would be overwritten by (?:checkout|merge)|Please commit your changes or stash them before you switch branches/.test(
          error.message,
        )
      )
        throw error
      await this.git.checkContext(repo, request, signal)
      await this.target(repo, request.name, request.expectedOid, signal)
      if ((await this.fingerprint(repo, signal)).signature !== before.signature) throw error
      const now = Date.now()
      for (const [id, plan] of this.plans) if (plan.expires <= now) this.plans.delete(id)
      while (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value)
      const id = randomUUID()
      this.plans.set(id, {
        repo,
        name: request.name,
        oid: request.expectedOid,
        signature: before.signature,
        expectedHead: request.expectedHead,
        expectedBranch: request.expectedBranch,
        expires: now + 300000,
      })
      return {
        outcome: 'failed',
        output: '',
        error: '本地修改会被覆盖，已阻止切换；修改保持不变。',
        checkoutProtection: { id, branch: request.name, paths: before.paths },
      }
    }
  }

  async stashAndSwitch(repo, request, signal) {
    const plan = this.plans.get(request.planId)
    if (
      !plan ||
      plan.repo !== repo ||
      plan.expires <= Date.now() ||
      plan.expectedHead !== request.expectedHead ||
      plan.expectedBranch !== request.expectedBranch
    )
      throw new Error('切换确认已过期或仓库已变化，请关闭后重新切换。')
    await this.git.noInProgress(repo, signal)
    await this.target(repo, plan.name, plan.oid, signal)
    if ((await this.fingerprint(repo, signal)).signature !== plan.signature)
      throw new Error('文件、暂存区或配置已变化；尚未贮藏，请关闭后重新切换。')
    this.plans.delete(request.planId)
    const list = await this.git.stash.list(repo, signal)
    const saved = await this.git.stash.execute(
      repo,
      {
        ...request,
        action: 'stash-create',
        stashSignature: list.signature,
        includeUntracked: true,
        message: `GitCode · 切换 ${plan.expectedBranch} → ${plan.name}`,
      },
      signal,
    )
    if (saved.outcome !== 'succeeded')
      return {
        ...saved,
        warning: '贮藏未完整完成，尚未切换。请检查工作区与贮藏列表，不要重复执行。',
      }
    try {
      await this.git.checkContext(repo, request, signal)
      await this.target(repo, plan.name, plan.oid, signal)
      const state = await this.git.status(repo, signal)
      if (state.staged.length || state.unstaged.length) throw new Error('贮藏后工作区又有修改。')
      const output = await this.git.git(
        repo,
        [
          '-c',
          'submodule.recurse=false',
          'switch',
          '--no-overwrite-ignore',
          '--no-guess',
          plan.name,
        ],
        { signal },
      )
      return { outcome: 'succeeded', output }
    } catch (error) {
      return {
        outcome: signal?.aborted ? 'cancelled' : 'partial',
        output: '',
        error: this.git.safeError(error),
        warning: '贮藏已创建并保留，但切换未正常完成。请核对当前分支；未自动恢复或删除贮藏。',
      }
    }
  }
}

module.exports = { CheckoutOperations }
