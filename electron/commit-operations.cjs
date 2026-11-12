'use strict'
const { randomUUID, createHash } = require('node:crypto')
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const edits = new Set(['undo', 'reword', 'drop', 'squash', 'interactive', 'fixup', 'squash-into'])
const operations = new Set(['reset', 'cherry', 'revert', ...edits])
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

class CommitOperations {
  constructor(git) {
    this.git = git
    this.plans = new Map()
  }
  async commits(repo, request, signal) {
    if (
      !request ||
      typeof request.expectedHead !== 'string' ||
      typeof request.expectedBranch !== 'string'
    )
      throw Error('缺少提交操作上下文，请重新打开菜单。')
    await this.git.checkContext(repo, request, signal)
    if (
      !Array.isArray(request.oids) ||
      !request.oids.length ||
      request.oids.length > 200 ||
      new Set(request.oids).size !== request.oids.length ||
      request.oids.some((oid) => !oidPattern.test(oid))
    )
      throw Error('请选择 1 至 200 条不重复的提交。')
    const result = []
    for (const oid of request.oids) {
      const raw = await this.git.git(
        repo,
        ['show', '-s', '--no-notes', '--no-show-signature', '--format=%H%x00%P%x00%B', oid, '--'],
        { signal },
      )
      const [actual, parents, message] = raw.split('\0')
      if (actual !== oid) throw Error('选中的提交对象已失效。')
      result.push({
        sha: oid,
        parents: parents.split(' ').filter(Boolean),
        message: message.trimEnd(),
        subject: message.split('\n')[0],
      })
    }
    return result
  }
  async protected(repo, commits, signal) {
    // Explicit application policy; ordinary published branches are editable.
    // Users can configure repeated gitcode.protectedBranch values (short names).
    const configured = (
      await this.git.git(repo, ['config', '--get-all', 'gitcode.protectedBranch'], {
        signal,
        allowedCodes: [0, 1],
      })
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    const names = configured.length ? configured : ['main', 'master']
    const remotes = (await this.git.git(repo, ['remote'], { signal }))
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const commit of commits) {
      const refs = (
        await this.git.git(
          repo,
          ['for-each-ref', `--contains=${commit.sha}`, '--format=%(refname)', 'refs/remotes/'],
          { signal },
        )
      )
        .trim()
        .split('\n')
      if (
        refs.some((ref) =>
          remotes.some(
            (remote) =>
              names.includes(ref.slice(`refs/remotes/${remote}/`.length)) &&
              ref.startsWith(`refs/remotes/${remote}/`),
          ),
        )
      )
        return true
    }
    return false
  }
  async read(repo, request, signal) {
    const commits = await this.commits(repo, request, signal),
      git = this.git
    const first = commits[0]
    if (request.kind === 'push-sources') {
      const raw = await git.git(
        repo,
        [
          'for-each-ref',
          `--contains=${first.sha}`,
          '--format=%(refname)%00%(objectname)',
          'refs/heads/',
        ],
        { signal },
      )
      return {
        sources: raw
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [fullRef, oid] = line.split('\0')
            return { fullRef, oid }
          }),
      }
    }
    if (request.kind === 'relations') {
      const raw = await git.git(
        repo,
        ['rev-list', '--children', 'HEAD', '--branches', '--remotes', '--tags', '--'],
        { signal },
      )
      const children =
        raw
          .split('\n')
          .find((line) => line.startsWith(first.sha + ' '))
          ?.split(' ')
          .slice(1) || []
      return { parents: first.parents, children }
    }
    if (request.kind === 'browse') {
      const fields = (
        await git.git(repo, ['ls-tree', '-r', '-z', '--full-tree', first.sha], { signal })
      )
        .split('\0')
        .filter(Boolean)
      return {
        entries: fields.map((row) => {
          const [header, ...name] = row.split('\t')
          const [mode, type, oid] = header.split(' ')
          return { mode, type, oid, path: name.join('\t') }
        }),
      }
    }
    if (request.kind === 'blob') {
      git.navigation.validators.filePath(request.file)
      const raw = await git.git(
        repo,
        ['--literal-pathspecs', 'ls-tree', '-z', first.sha, '--', request.file],
        { signal },
      )
      const match = /^(100(?:644|755)) blob ([a-f0-9]+)\t/.exec(raw)
      if (!match) throw Error('该历史对象不是可查看的普通文件。')
      const size = Number((await git.git(repo, ['cat-file', '-s', match[2]], { signal })).trim())
      if (size > 256 * 1024) throw Error('历史文件超过 256 KB，请导出补丁或使用外部工具查看。')
      const version = await git.merge.blob(repo, { mode: match[1], oid: match[2] }, signal)
      if (version.binary || version.text === null)
        throw Error('该历史文件不是可显示的 UTF-8 文本。')
      return { content: version.text }
    }
    if (request.kind === 'patch') {
      if (commits.some((c) => c.parents.length > 1))
        throw Error('合并提交不能直接导出补丁；请先与指定父提交比较。')
      const order = await this.order(repo, commits, signal)
      return {
        content: await git.git(
          repo,
          [
            'format-patch',
            '--stdout',
            '--no-signature',
            '--binary',
            '--full-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-walk=unsorted',
            ...[...order].reverse().map((c) => c.sha),
            '--',
          ],
          { signal },
        ),
      }
    }
    if (request.kind === 'hosting') {
      const names = (await git.git(repo, ['remote'], { signal })).trim().split('\n').filter(Boolean)
      const urls = []
      for (const name of names) {
        const raw = (await git.git(repo, ['remote', 'get-url', name], { signal })).trim()
        const normalized = raw
          .replace(/^git@([^:]+):/, 'https://$1/')
          .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//, 'https://$1/')
        let url
        try {
          url = new URL(normalized)
        } catch {
          continue
        }
        if (!['http:', 'https:'].includes(url.protocol)) continue
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        url.pathname = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
        if (url.hostname === 'github.com' || url.hostname === 'bitbucket.org')
          url.pathname += `/commit${url.hostname === 'bitbucket.org' ? 's' : ''}/${first.sha}`
        else if (/gitlab/i.test(url.hostname)) url.pathname += `/-/commit/${first.sha}`
        else continue
        urls.push({ name, url: url.toString() })
      }
      return { urls }
    }
    if (request.kind !== 'plan' || !operations.has(request.operation))
      throw Error('不支持的提交操作。')
    const op = request.operation
    if (!['cherry', 'revert', 'drop', 'squash'].includes(op) && commits.length !== 1)
      throw Error('此操作只能选择一条提交。')
    if (op === 'squash' && commits.length < 2) throw Error('至少选择两条提交才能压缩。')
    await git.noInProgress(repo, signal)
    if (await git.flowFinish.state(repo, signal)) throw Error('请先结束 GitFlow 完成流程。')
    const head = await git.head(repo, signal),
      branch = await git.currentBranch(repo, signal)
    const working = await git.checkout.fingerprint(repo, signal)
    let resetBlockers = []
    if (op === 'reset') {
      const ignored = (
        await git.git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
          signal,
        })
      )
        .split('\0')
        .filter(Boolean)
      const targetPaths = (
        await git.git(repo, ['ls-tree', '-r', '-z', '--name-only', first.sha], { signal })
      )
        .split('\0')
        .filter(Boolean)
      resetBlockers = ignored.filter((file) =>
        targetPaths.some(
          (target) =>
            target === file || target.startsWith(file + '/') || file.startsWith(target + '/'),
        ),
      )
    }
    const blockerFingerprint = resetBlockers.length
      ? await git.selectedCommit.fingerprint(repo, resetBlockers, signal)
      : ''
    let rebase = null
    if (edits.has(op)) {
      if (!branch) throw Error('请先检出本地分支。')
      for (const commit of commits) {
        if (
          !(await git
            .git(repo, ['merge-base', '--is-ancestor', commit.sha, head], {
              signal,
              allowedCodes: [0, 1],
              returnCode: true,
            })
            .then((r) => r.code === 0))
        )
          throw Error('所选提交不属于当前 HEAD 历史。')
      }
      if (await this.protected(repo, commits, signal))
        throw Error('受保护远程分支已包含所选提交，不能重写。')
      if (commits.some((c) => c.parents.length > 1) && !(op === 'reword' && first.sha === head))
        throw Error('此操作不支持所选合并提交。')
      if (op === 'undo' && (first.sha !== head || first.parents.length !== 1))
        throw Error('只能撤销有一个父提交的当前 HEAD。')
      if (
        ['fixup', 'squash-into'].includes(op) &&
        !working.status.staged.length &&
        !working.status.unstaged.some((f) => f.status !== '?')
      )
        throw Error('没有可用于修正提交的已跟踪更改。')
      if (
        ['drop', 'squash', 'interactive'].includes(op) ||
        (op === 'reword' && first.sha !== head)
      ) {
        const ordered = await this.order(repo, commits, signal)
        const oldest = ordered[0]
        rebase = await git.rebase.plan(
          repo,
          {
            fullRef: oldest.sha,
            referenceOid: oldest.sha,
            oid: oldest.sha,
            head,
            branch,
            related: true,
            fromHere: true,
          },
          signal,
        )
        if (!rebase.canInteractive) throw Error(rebase.reason)
        // Non-contiguous squash needs a reorder decision; do not silently reorder.
        if (op === 'squash') {
          const positions = rebase.steps
            .map((s, i) => (commits.some((c) => c.sha === s.sha) ? i : -1))
            .filter((i) => i >= 0)
          if (positions.at(-1) - positions[0] + 1 !== positions.length)
            throw Error('压缩的提交必须连续；非连续选择请使用交互式变基明确调整顺序。')
        }
      }
    }
    if (['cherry', 'revert'].includes(op)) {
      if (!branch) throw Error('请先检出本地分支。')
      if (commits.some((c) => c.parents.length > 1))
        throw Error('合并提交需要指定主线，当前不提供直接优选或还原。')
      if (working.paths.length) throw Error('请先提交或贮藏当前更改，再优选或还原。')
      for (const commit of commits)
        await git.merge.checkIgnoredPaths(
          repo,
          op === 'revert' ? commit.parents[0] || commit.sha : commit.sha,
          signal,
        )
    }
    const plan = {
      id: randomUUID(),
      repo,
      operation: op,
      head,
      branch,
      commits: await this.order(repo, commits, signal),
      working: working.signature,
      rebase,
      expiresAt: Date.now() + 300000,
    }
    plan.signature = hash({
      head,
      branch,
      commits: plan.commits,
      working: working.signature,
      rebase,
      blockerFingerprint,
    })
    for (const [key, value] of this.plans) if (value.expiresAt < Date.now()) this.plans.delete(key)
    while (this.plans.size >= 64) this.plans.delete(this.plans.keys().next().value)
    this.plans.set(plan.id, plan)
    return {
      id: plan.id,
      operation: op,
      commits: plan.commits,
      rebase,
      dirty: working.paths.length > 0,
      files: [
        ...working.status.staged,
        ...working.status.unstaged,
        ...resetBlockers.map((path) => ({ path, status: '!' })),
      ],
      head,
      branch,
      expiresAt: plan.expiresAt,
    }
  }
  async order(repo, commits, signal) {
    const raw = await this.git.git(
      repo,
      ['rev-list', '--reverse', '--topo-order', ...commits.map((c) => c.sha), '--'],
      { signal },
    )
    const map = new Map(commits.map((c) => [c.sha, c]))
    return raw
      .trim()
      .split('\n')
      .filter((sha) => map.has(sha))
      .map((sha) => map.get(sha))
  }
  async execute(repo, request, signal) {
    const git = this.git
    if (request.action === 'checkout-revision') {
      const commits = await this.commits(repo, { ...request, oids: [request.oid] }, signal)
      await git.noInProgress(repo, signal)
      if (await git.flowFinish.state(repo, signal)) throw Error('请先结束 GitFlow 完成流程。')
      await git.merge.checkIgnoredPaths(repo, commits[0].sha, signal)
      return git.autoStash.run(
        repo,
        'checkout revision',
        signal,
        async () => {
          await git.checkContext(repo, request, signal)
          return {
            output: await git.git(
              repo,
              [
                '-c',
                'submodule.recurse=false',
                'switch',
                '--detach',
                '--no-overwrite-ignore',
                commits[0].sha,
              ],
              { signal, timeout: 300000 },
            ),
            outcome: 'succeeded',
          }
        },
        '',
      )
    }
    if (request.action === 'commit-sequence') return this.sequence(repo, request, signal)
    const plan = this.plans.get(request.planId)
    if (!plan || plan.repo !== repo || plan.expiresAt < Date.now())
      throw Error('提交操作预览已失效，请重新读取。')
    if (request.confirm !== true) throw Error('请先核对并确认操作计划。')
    const fresh = await this.read(
      repo,
      {
        kind: 'plan',
        operation: plan.operation,
        oids: plan.commits.map((c) => c.sha),
        expectedHead: request.expectedHead,
        expectedBranch: request.expectedBranch,
      },
      signal,
    )
    const current = this.plans.get(fresh.id)
    this.plans.delete(fresh.id)
    if (current.signature !== plan.signature)
      throw Error('仓库或工作区已变化，请重新读取操作计划。')
    const op = plan.operation,
      first = plan.commits[0]
    await git.checkContext(repo, request, signal)
    const message = ['reword', 'fixup', 'squash-into', 'squash'].includes(op)
      ? git.navigation.validators.string(request.message, '提交说明', { max: 20000 }).trim()
      : ''
    if (['reword', 'fixup', 'squash-into', 'squash'].includes(op) && !message)
      throw Error('提交说明不能为空。')
    if (op === 'reset' && !['soft', 'mixed', 'hard', 'keep'].includes(request.mode))
      throw Error('请选择明确的重置模式。')
    if (op === 'reset' && request.mode === 'hard' && request.confirmHard !== true)
      throw Error('Hard 重置会丢弃更改，请明确确认。')
    if (edits.has(op) || op === 'reset') {
      const ref = git.recovery.reference('commit', plan.branch || 'detached-HEAD')
      await git.git(repo, ['update-ref', ref, plan.head, '0'.repeat(plan.head.length)], { signal })
    }
    this.plans.delete(plan.id)
    if (
      ['interactive', 'drop', 'squash'].includes(op) ||
      (op === 'reword' && first.sha !== plan.head)
    ) {
      let steps = plan.rebase.steps.map((s) => ({ ...s }))
      const selected = new Set(plan.commits.map((c) => c.sha))
      if (op === 'interactive') steps = request.steps
      else if (op === 'drop')
        steps.forEach((s) => {
          if (selected.has(s.sha)) s.type = 'drop'
        })
      else if (op === 'reword') {
        const s = steps.find((s) => selected.has(s.sha))
        s.type = 'reword'
        s.message = message
      } else {
        let kept = false
        steps.forEach((s) => {
          if (selected.has(s.sha)) {
            s.type = kept ? 'fixup' : 'reword'
            if (!kept) s.message = message
            kept = true
          }
        })
      }
      return git.rebase.execute(
        repo,
        {
          action: 'rebase-start',
          fullRef: first.sha,
          expectedOid: first.sha,
          fromHere: true,
          expectedHead: plan.head,
          expectedBranch: plan.branch,
          planSignature: plan.rebase.signature,
          steps,
        },
        signal,
      )
    }
    if (op === 'reword')
      return {
        output: await git.git(repo, ['commit', '--amend', '--only', '-m', message], {
          signal,
          timeout: 300000,
          diagnose: true,
        }),
        outcome: 'succeeded',
      }
    if (['fixup', 'squash-into'].includes(op)) {
      if (!Array.isArray(request.paths) || !request.paths.length)
        throw Error('请选择要提交的文件。')
      const prefix = op === 'fixup' ? 'fixup! ' : 'squash! '
      if (!message.startsWith(prefix)) throw Error(`提交说明必须以 ${prefix} 开头。`)
      const selection = await git.selectedCommitPlan(
        repo,
        { expectedHead: plan.head, expectedBranch: plan.branch, paths: request.paths },
        signal,
      )
      return git.selectedCommit.execute(
        repo,
        {
          ...request,
          action: 'commit-selected',
          planId: selection.id,
          message,
          confirmPartial: request.confirmPartial === true,
        },
        signal,
      )
    }
    if (op === 'reset' || op === 'undo') {
      const target = op === 'undo' ? first.parents[0] : first.sha
      const output = await git.git(
        repo,
        [
          '-c',
          'submodule.recurse=false',
          'reset',
          `--${op === 'undo' ? 'soft' : request.mode}`,
          target,
          '--',
        ],
        { signal, timeout: 300000 },
      )
      return { output: output || '操作完成，原 HEAD 已保存为恢复点。', outcome: 'succeeded' }
    }
    const oids = plan.commits.map((c) => c.sha)
    if (op === 'revert') oids.reverse()
    return this.runSequence(repo, op === 'cherry' ? 'cherry-pick' : 'revert', oids, signal)
  }
  async runSequence(repo, kind, args, signal) {
    let output = '',
      failure
    try {
      output = await this.git.git(repo, [kind, ...args], {
        signal,
        timeout: 300000,
        diagnose: true,
        skipEditor: true,
      })
    } catch (e) {
      failure = e
    }
    const state = await this.git.merge.state(
      repo,
      signal?.aborted ? AbortSignal.timeout(15000) : signal,
    )
    if (state?.sequence)
      return {
        output,
        outcome: 'partial',
        warning: `${kind === 'cherry-pick' ? '优选' : '还原'}已暂停，请解决冲突后继续；若补丁为空，可确认后跳过。`,
      }
    if (failure) throw failure
    return { output, outcome: 'succeeded' }
  }
  async sequence(repo, request, signal) {
    const state = await this.git.merge.state(repo, signal)
    if (!state?.sequence || state.unsupported || request.mergeSignature !== state.signature)
      throw Error('优选或还原状态已变化，请刷新。')
    if (!['continue', 'abort', 'skip'].includes(request.command)) throw Error('不支持的后续操作。')
    if (request.command === 'continue' && state.files.length) throw Error('请先解决全部冲突文件。')
    if (['skip', 'abort'].includes(request.command) && request.confirm !== true)
      throw Error('此操作会丢弃当前处理结果，请明确确认。')
    return this.runSequence(repo, state.sequence, [`--${request.command}`], signal)
  }
}
module.exports = { CommitOperations }
