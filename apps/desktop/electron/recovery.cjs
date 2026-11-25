'use strict'
const { randomUUID } = require('node:crypto')
const PREFIX = 'refs/gitcode/recovery/'

// Recovery refs keep commit objects reachable without polluting the normal graph.
// Ref transactions protect the exact old tip and the symbolic HEAD being edited.
class RecoveryOperations {
  constructor(git) {
    this.git = git
    this.plans = new Map()
  }
  reference(kind, branch) {
    return `${PREFIX}${kind}/${Date.now()}-${randomUUID()}/${branch}`
  }
  async checkpoint(repo, name, oid, signal) {
    const ref = this.reference('deleted', name)
    await this.git.git(repo, ['update-ref', '--stdin'], {
      signal,
      input: `start\nverify refs/heads/${name} ${oid}\ncreate ${ref} ${oid}\nprepare\ncommit\n`,
    })
    return ref
  }
  async deleteBranch(repo, request, signal) {
    const git = this.git,
      name = request.name,
      ref = `refs/heads/${name}`,
      backup = this.reference('deleted', name)
    const merged = async (readSignal) => {
      if (request.force === true) return
      const upstream = (
        await git.git(repo, ['for-each-ref', '--format=%(upstream)', ref], { signal: readSignal })
      ).trim()
      const upstreamOid = upstream
        ? (
            await git.git(repo, ['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`], {
              signal: readSignal,
              allowedCodes: [0, 1],
            })
          ).trim()
        : ''
      // Match git branch -d: use a resolvable upstream, otherwise HEAD.
      const reference = upstreamOid || (await git.head(repo, readSignal))
      const result = reference
        ? await git.git(repo, ['merge-base', '--is-ancestor', request.expectedOid, reference], {
            signal: readSignal,
            allowedCodes: [0, 1],
            returnCode: true,
          })
        : null
      if (!result || result.code !== 0)
        throw Object.assign(
          new Error(
            '该分支未通过 Git 的合并检查。请确认是否删除未合并分支，再以强制删除方式重试。',
          ),
          {
            code: 'BRANCH_UNMERGED',
          },
        )
    }
    try {
      await merged(signal)
      // Never dereference a symbolic local branch while deleting its name.
      if (
        (await git.git(repo, ['symbolic-ref', '-q', ref], { signal, allowedCodes: [0, 1] })).trim()
      )
        throw Error('该本地引用是符号引用，请先通过 Git 核对其目标。')
      await git.git(repo, ['update-ref', '--stdin'], {
        signal,
        input: `start\noption no-deref\ncreate ${backup} ${request.expectedOid}\noption no-deref\ndelete ${ref} ${request.expectedOid}\nprepare\n`,
        onPrepared: async (validationSignal) => {
          await git.checkContext(repo, request, validationSignal)
          await git.checkWorktree(repo, ref, true, validationSignal)
          await git.noInProgress(repo, validationSignal)
          await merged(validationSignal)
        },
      })
    } catch (error) {
      if (error.code === 'BRANCH_UNMERGED')
        return {
          output: '',
          outcome: 'failed',
          branchDeleteBlocked: 'unmerged',
          error: error.message,
        }
      throw error
    }
    const output = `本地分支 ${name} 已删除，原提交已保留为恢复点。`
    try {
      const recreated = (
        await git.git(repo, ['rev-parse', '--verify', '--quiet', ref], {
          signal,
          allowedCodes: [0, 1],
        })
      ).trim()
      if (recreated)
        return {
          outcome: 'partial',
          output,
          warning: '同名分支已被其他操作重新创建，已保留其配置，请刷新核对。',
        }
      const pattern = '^branch\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.'
      const settings = await git.git(
        repo,
        ['config', '--local', '--no-includes', '--name-only', '--get-regexp', pattern],
        {
          signal,
          allowedCodes: [0, 1],
        },
      )
      if (settings.trim())
        await git.git(repo, ['config', '--local', '--remove-section', `branch.${name}`], { signal })
      return { outcome: 'succeeded', output }
    } catch (error) {
      return {
        outcome: 'partial',
        output,
        warning: `分支已删除，但其本地配置未能清理：${git.safeError(error)}`,
      }
    }
  }
  async read(repo, signal) {
    const head = await this.git.head(repo, signal)
    const branch = await this.git.currentBranch(repo, signal)
    let parent = '',
      subject = '',
      blocked = ''
    if (!head) blocked = '当前仓库还没有提交。'
    else if (!branch) blocked = '游离 HEAD 状态下不能撤回分支提交。'
    else {
      const raw = (await this.git.git(repo, ['show', '-s', '--format=%P%n%s', head], { signal }))
        .trimEnd()
        .split('\n')
      const parents = raw[0].split(' ').filter(Boolean)
      subject = raw.slice(1).join('\n')
      parent = parents.length === 1 ? parents[0] : ''
      if (!parent)
        blocked = parents.length ? '合并提交请使用专门的反向提交流程。' : '首次提交暂不支持撤回。'
    }
    const published = head
      ? (
          await this.git.git(
            repo,
            ['for-each-ref', '--format=%(refname:short)', `--contains=${head}`, 'refs/remotes'],
            { signal },
          )
        )
          .trim()
          .split('\n')
          .filter(Boolean)
      : []
    if (published.length) blocked = '已有本地远程引用包含此提交，请使用反向提交保留共享历史。'
    try {
      await this.git.noInProgress(repo, signal)
      if (await this.git.flowFinish.state(repo, signal)) blocked = '请先完成或停止 GitFlow 流程。'
    } catch (error) {
      blocked = this.git.safeError(error)
    }
    const raw = await this.git.git(
      repo,
      ['for-each-ref', '--format=%(refname)%00%(objectname)', PREFIX],
      { signal },
    )
    const entries = raw
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const [ref, oid] = line.split('\0')
        const match =
          /^refs\/gitcode\/recovery\/(deleted|commit)\/(\d{13}-[0-9a-f-]{36})\/(.+)$/.exec(ref)
        return match
          ? [
              {
                id: match[2],
                ref,
                oid,
                kind: match[1],
                branch: match[3],
                createdAt: Number(match[2].slice(0, 13)),
              },
            ]
          : []
      })
      .sort((a, b) => b.createdAt - a.createdAt)
    const plan = {
      id: randomUUID(),
      repo,
      head,
      branch,
      parent,
      subject,
      blocked,
      published,
      entries,
      expires: Date.now() + 600000,
    }
    for (const [id, value] of this.plans) if (value.expires < Date.now()) this.plans.delete(id)
    while (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value)
    this.plans.set(plan.id, plan)
    return plan
  }
  async execute(repo, request, signal) {
    const plan = this.plans.get(request.planId)
    this.plans.delete(request.planId)
    if (!plan || plan.repo !== repo || plan.expires < Date.now())
      throw Error('恢复预览已失效，请重新读取。')
    await this.git.noInProgress(repo, signal)
    if (await this.git.flowFinish.state(repo, signal)) throw Error('请先完成或停止 GitFlow 流程。')
    if (request.action === 'recovery-undo') {
      if (request.confirmUnpublished !== true) throw Error('请先确认该提交尚未共享。')
      const current = await this.read(repo, signal)
      this.plans.delete(current.id)
      if (
        current.head !== plan.head ||
        current.branch !== plan.branch ||
        current.parent !== plan.parent
      )
        throw Error('分支或提交已变化，请重新读取。')
      if (current.blocked) throw Error(current.blocked)
      const backup = this.reference('commit', plan.branch)
      await this.git.git(
        repo,
        ['update-ref', '-m', 'GitCode: undo local commit, keep index and working tree', '--stdin'],
        {
          signal,
          input: `start\nupdate HEAD ${plan.parent} ${plan.head}\ncreate ${backup} ${plan.head}\nprepare\n`,
          // Git owns the HEAD/ref locks after prepare. Verify the symbolic branch
          // under those locks; a checkout to another branch at the same OID must
          // abort, rather than rewriting the wrong branch. EOF/cancel aborts too.
          onPrepared: async (signal) => {
            await this.git.checkContext(
              repo,
              { expectedHead: plan.head, expectedBranch: plan.branch },
              signal,
            )
            await this.git.noInProgress(repo, signal)
            if (await this.git.flowFinish.state(repo, signal))
              throw Error('GitFlow 状态已变化，请重新读取。')
          },
        },
      )
      return {
        outcome: 'succeeded',
        output: '本地最近提交已撤回，暂存区和工作文件保持原样。原提交已保留为恢复点；未修改远端。',
      }
    }
    const entry = plan.entries.find((item) => item.id === request.entryId)
    if (!entry) throw Error('请选择有效的恢复点。')
    const name = await this.git.branchName(repo, request.name, signal)
    if (
      (
        await this.git.git(repo, ['symbolic-ref', '-q', `refs/heads/${name}`], {
          signal,
          allowedCodes: [0, 1],
        })
      ).trim()
    )
      throw Error('该名称已有符号引用，请使用新的分支名。')
    // Create-only: neither an existing local branch nor the current checkout is overwritten.
    await this.git.git(repo, ['update-ref', '-m', 'GitCode: restore recovery point', '--stdin'], {
      signal,
      input: `start\noption no-deref\ncreate refs/heads/${name} ${entry.oid}\noption no-deref\ndelete ${entry.ref} ${entry.oid}\nprepare\ncommit\n`,
    })
    return { outcome: 'succeeded', output: `本地分支 ${name} 已恢复，当前分支未切换，远端未修改。` }
  }
}
module.exports = { RecoveryOperations }
