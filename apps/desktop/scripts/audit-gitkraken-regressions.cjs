'use strict'

// Investigation harness: mutations are confined to disposable repositories.
// A successful run records findings, rather than treating known bugs as passes.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const options = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const i = value.indexOf('=')
    return [value.slice(2, i), value.slice(i + 1)]
  }),
)
const project = path.resolve(options.project || path.join(__dirname, '..'))
const { GitService } = require(path.join(project, 'electron', 'git.cjs'))
const output = path.resolve(options.output || path.join(project, 'design', 'release-note-audit'))
const findings = []
let root,
  counter = 0
async function fixture(work) {
  const repo = path.join(root, `repo ${counter++} 中文`),
    git = new GitService()
  await fs.mkdir(repo)
  const cmd = (...args) => git.git(repo, args)
  const write = (file, text) => fs.writeFile(path.join(repo, file), text)
  const commit = async (message) => {
    await cmd('add', '.')
    await cmd('commit', '-m', message)
    return git.head(repo)
  }
  const context = async () => ({
    expectedHead: await git.head(repo),
    expectedBranch: (await git.currentBranch(repo)) || 'detached HEAD',
  })
  const act = async (action, extra = {}) =>
    git.action(repo, { ...(await context()), action, ...extra })
  try {
    await cmd('init', '-b', 'qa/base')
    for (const [key, value] of [
      ['user.name', 'Release Audit'],
      ['user.email', 'audit@example.test'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.no-hooks'],
    ])
      await cmd('config', key, value)
    await write('shared.txt', 'base\n')
    const base = await commit('baseline')
    return await work({ repo, git, cmd, write, commit, context, act, base })
  } finally {
    await git.shutdown()
  }
}
async function probe(id, release, work) {
  try {
    const value = await fixture(work)
    findings.push({ id, release, ...value })
  } catch (error) {
    findings.push({ id, release, status: 'inconclusive', error: String(error.message || error) })
  }
  console.log(`${findings.at(-1).status}: ${id}`)
  await save(false)
}
async function save(finished) {
  await fs.writeFile(
    path.join(output, 'findings.json'),
    JSON.stringify(
      {
        finished,
        platform: process.platform,
        temporaryRepositories: true,
        businessRepositoriesModified: false,
        findings,
      },
      null,
      2,
    ) + '\n',
  )
}
async function main() {
  await fs.mkdir(output, { recursive: true })
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-release-audit-'))
  try {
    await probe('file-to-directory-stage-selection', '12.6.0', async (f) => {
      await f.write('entry', 'old file\n')
      await f.commit('tracked file')
      await fs.rm(path.join(f.repo, 'entry'))
      await fs.mkdir(path.join(f.repo, 'entry'))
      await f.write('entry/child.txt', 'unselected new content\n')
      const result = await f.act('stage', { paths: ['entry'] })
      const paths = result.snapshot.staged.map((file) => file.path)
      return {
        status: paths.includes('entry/child.txt') ? 'confirmed' : 'not-reproduced',
        selected: ['entry'],
        actualStaged: paths,
        outcome: result.outcome,
        error: result.error,
      }
    })
    await probe('file-to-directory-unstage-selection', '12.6.0', async (f) => {
      await f.write('entry', 'old file\n')
      await f.commit('tracked file')
      await fs.rm(path.join(f.repo, 'entry'))
      await fs.mkdir(path.join(f.repo, 'entry'))
      await f.write('entry/child.txt', 'new content\n')
      await f.cmd('add', '--all')
      const before = await f.git.status(f.repo)
      const result = await f.act('unstage', { paths: ['entry'] })
      return {
        status:
          result.outcome === 'succeeded' &&
          !result.snapshot.staged.some((file) => file.path === 'entry/child.txt')
            ? 'confirmed'
            : 'not-reproduced',
        selected: ['entry'],
        beforeStaged: before.staged,
        afterStaged: result.snapshot.staged,
        outcome: result.outcome,
        error: result.error,
      }
    })
    await probe('directory-to-file-stage-all', '12.6.0', async (f) => {
      await fs.mkdir(path.join(f.repo, 'entry'))
      await f.write('entry/child.txt', 'old\n')
      await f.commit('tracked folder')
      await fs.rm(path.join(f.repo, 'entry'), { recursive: true })
      await f.write('entry', 'new file\n')
      const selected = (await f.git.status(f.repo)).unstaged.map((file) => file.path)
      const result = await f.act('stage', { paths: selected })
      return {
        status: result.outcome === 'failed' ? 'confirmed' : 'not-reproduced',
        selected,
        outcome: result.outcome,
        error: result.error,
        staged: result.snapshot.staged,
      }
    })
    await probe('branch-tag-name-ambiguity', '11.6.0', async (f) => {
      const remote = path.join(f.repo, '.git', 'remote.git')
      await f.cmd('init', '--bare', remote)
      await f.cmd('remote', 'add', 'origin', remote)
      await f.cmd('push', '-u', 'origin', 'qa/base')
      await f.cmd('tag', 'qa/base')
      const snapshot = await f.git.snapshot(f.repo)
      let planError = '',
        plan,
        pushed
      try {
        plan = await f.git.syncPlan(f.repo, 'push', {
          expectedHead: snapshot.head,
          expectedBranch: snapshot.branch,
        })
        pushed = await f.act('push', { planId: plan.id })
      } catch (error) {
        planError = error.message
      }
      return {
        status: snapshot.branch !== 'qa/base' ? 'confirmed' : 'not-reproduced',
        expectedBranch: 'qa/base',
        actualBranch: snapshot.branch,
        listedCurrentBranch: snapshot.branches.find((b) => b.current)?.name,
        pushPlanError: planError,
        plan: plan && {
          sourceRef: plan.sourceRef,
          destinationRef: plan.destinationRef,
          publish: plan.publish,
        },
        pushOutcome: pushed?.outcome,
        pushError: pushed?.error,
        actualRemoteBranches: (
          await f.cmd('--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')
        )
          .trim()
          .split('\n'),
      }
    })
    await probe('notes-enter-normal-history', '11.6.0', async (f) => {
      await f.cmd('notes', 'add', '-m', 'QA note')
      const note = (await f.cmd('rev-parse', 'refs/notes/commits')).trim(),
        snapshot = await f.git.snapshot(f.repo)
      return {
        status: snapshot.commits.some((c) => c.hash === note) ? 'confirmed' : 'not-reproduced',
        expectedNormalCommits: 1,
        actualCount: snapshot.total,
        notesCommitInGraph: snapshot.commits.some((c) => c.hash === note),
      }
    })
    await probe('prefetch-enters-normal-history', '11.6.0', async (f) => {
      const tree = (await f.cmd('rev-parse', 'HEAD^{tree}')).trim()
      const extra = (await f.cmd('commit-tree', tree, '-m', 'QA prefetch-only commit')).trim()
      await f.cmd('update-ref', 'refs/prefetch/remotes/origin/hidden', extra)
      const snapshot = await f.git.snapshot(f.repo)
      return {
        status: snapshot.commits.some((c) => c.hash === extra) ? 'confirmed' : 'not-reproduced',
        expectedNormalCommits: 1,
        actualCount: snapshot.total,
        prefetchCommitInGraph: snapshot.commits.some((c) => c.hash === extra),
      }
    })
    await probe('staged-rename-diff', '12.6.1', async (f) => {
      await f.cmd('mv', 'shared.txt', 'renamed.txt')
      const state = await f.git.status(f.repo)
      const staged = await f.git.diff(f.repo, 'renamed.txt', true)
      const working = await f.git.diff(f.repo, 'renamed.txt', 'working')
      return {
        status:
          staged.diff.includes('new file mode') && !staged.diff.includes('rename from')
            ? 'confirmed'
            : 'not-reproduced',
        file: state.staged[0],
        stagedDiff: staged.diff,
        combinedDiff: working.diff,
      }
    })
    await probe('rebase-reword-hash-message', '10.0.2', async (f) => {
      await f.cmd('switch', '-c', 'qa/target')
      await f.write('target.txt', 'target\n')
      const target = await f.commit('target change')
      await f.cmd('switch', '-c', 'qa/topic', f.base)
      await f.write('topic.txt', 'topic\n')
      await f.commit('topic change')
      const plan = await f.git.navigation.read(f.repo, {
        kind: 'rebase',
        fullRef: 'refs/heads/qa/target',
        expectedOid: target,
        ...(await f.context()),
      })
      const intended = '#literal header\n\nbody remains'
      const steps = plan.rebase.steps.map((step, i) => ({
        ...step,
        type: i === 0 ? 'reword' : step.type,
        message: i === 0 ? intended : step.message,
      }))
      const result = await f.act('rebase-start', {
        fullRef: plan.fullRef,
        expectedOid: plan.referenceOid,
        planSignature: plan.rebase.signature,
        steps,
      })
      const actual = (await f.cmd('log', '-1', '--format=%B')).trim()
      return {
        status:
          result.outcome === 'succeeded' && actual !== intended ? 'confirmed' : 'not-reproduced',
        outcome: result.outcome,
        intendedMessage: intended,
        actualMessage: actual,
        error: result.error,
      }
    })
    await probe('rebase-conflict-hash-message', '10.0.2', async (f) => {
      await f.cmd('switch', '-c', 'qa/target')
      await f.write('shared.txt', 'target\n')
      const target = await f.commit('target change')
      await f.cmd('switch', '-c', 'qa/topic', f.base)
      await f.write('shared.txt', 'topic\n')
      await f.commit('#literal header')
      const plan = await f.git.navigation.read(f.repo, {
        kind: 'rebase',
        fullRef: 'refs/heads/qa/target',
        expectedOid: target,
        ...(await f.context()),
      })
      const started = await f.act('rebase-start', {
        fullRef: plan.fullRef,
        expectedOid: plan.referenceOid,
        planSignature: plan.rebase.signature,
      })
      if (!started.snapshot?.merge?.rebase)
        return {
          status: 'inconclusive',
          reason: 'Expected rebase conflict was not reached',
          outcome: started.outcome,
          error: started.error,
        }
      await f.write('shared.txt', 'resolved\n')
      await f.cmd('add', 'shared.txt')
      const result = await f.act('rebase-continue', {
        mergeSignature: (await f.git.merge.state(f.repo)).signature,
      })
      const actual = (await f.cmd('log', '-1', '--format=%B')).trim()
      return {
        status:
          result.outcome !== 'succeeded' || actual !== '#literal header'
            ? 'confirmed'
            : 'not-reproduced',
        outcome: result.outcome,
        error: result.error,
        warning: result.warning,
        rebaseStillActive: !!result.snapshot?.merge?.rebase,
        actualMessage: actual,
      }
    })
    await probe('literal-pathspec-selection', '12.5.0', async (f) => {
      await f.write('[abc].txt', 'selected\n')
      await f.write('a.txt', 'unselected\n')
      const result = await f.act('stage', { paths: ['[abc].txt'] })
      const paths = result.snapshot.staged.map((file) => file.path)
      return {
        status: paths.length === 1 && paths[0] === '[abc].txt' ? 'guard-verified' : 'confirmed',
        actualStaged: paths,
      }
    })
    await probe('relative-hooks-in-linked-worktree', '9.12.0 / 10.6.0', async (f) => {
      const linked = path.join(root, 'linked ' + counter)
      await f.cmd('worktree', 'add', '-b', 'qa/linked', linked)
      await f.cmd('config', 'core.hooksPath', '.hooks')
      await fs.mkdir(path.join(linked, '.hooks'))
      await fs.writeFile(
        path.join(linked, '.hooks', 'pre-commit'),
        '#!/bin/sh\necho QA_LINKED_HOOK >&2\nexit 7\n',
        { mode: 0o755 },
      )
      await fs.writeFile(path.join(linked, 'shared.txt'), 'changed\n')
      await f.git.git(linked, ['add', 'shared.txt'])
      const result = await f.git.action(linked, {
        action: 'commit',
        message: 'must be rejected',
        expectedHead: await f.git.head(linked),
        expectedBranch: await f.git.currentBranch(linked),
      })
      return {
        status:
          result.outcome === 'failed' && result.error.includes('pre-commit')
            ? 'guard-verified'
            : 'confirmed',
        outcome: result.outcome,
        error: result.error,
      }
    })
    await probe('hook-added-removed-immediately', '12.6.0', async (f) => {
      const hooks = path.join(f.repo, '.git', 'audit-hooks')
      await fs.mkdir(hooks)
      await f.cmd('config', 'core.hooksPath', hooks)
      const outcomes = []
      for (const active of [true, false, true]) {
        const hook = path.join(hooks, 'pre-commit')
        if (active) await fs.writeFile(hook, '#!/bin/sh\nexit 7\n', { mode: 0o755 })
        else await fs.rm(hook)
        await f.write('shared.txt', String(active) + '\n')
        await f.cmd('add', 'shared.txt')
        outcomes.push((await f.act('commit', { message: 'check live hook' })).outcome)
      }
      return {
        status:
          JSON.stringify(outcomes) === JSON.stringify(['failed', 'succeeded', 'failed'])
            ? 'guard-verified'
            : 'confirmed',
        outcomes,
      }
    })
    await probe('remote-ancestor-merge-check', '12.6.0', async (f) => {
      await f.write('shared.txt', 'ahead\n')
      await f.commit('local ahead')
      await f.cmd('update-ref', 'refs/remotes/origin/old', f.base)
      const request = {
        fullRef: 'refs/remotes/origin/old',
        expectedOid: f.base,
        ...(await f.context()),
      }
      const info = await f.git.navigation.reference(f.repo, request)
      const result = await f.act('merge-branch', { ...request, confirm: true })
      return {
        status:
          info.alreadyMerged && !info.canFastForward && result.outcome === 'failed'
            ? 'guard-verified'
            : 'confirmed',
        alreadyMerged: info.alreadyMerged,
        canFastForward: info.canFastForward,
        outcome: result.outcome,
        error: result.error,
      }
    })
    await probe('diff-config-and-crlf', '12.1.0 / 12.4.1', async (f) => {
      await f.cmd('config', 'core.autocrlf', 'false')
      await f.write('crlf.txt', 'one\r\ntwo\r\nthree\r\n')
      await f.commit('physical CRLF')
      await f.write('crlf.txt', 'one\r\nTWO\r\nthree\r\n')
      await f.cmd('config', 'diff.noprefix', 'true')
      await f.cmd('config', 'color.ui', 'always')
      const diff = (await f.git.diff(f.repo, 'crlf.txt', false)).diff
      const adds = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      const removes = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
      return {
        status:
          adds.length === 1 && removes.length === 1 && !diff.includes('\u001b[')
            ? 'guard-verified'
            : 'confirmed',
        addedLines: adds.length,
        removedLines: removes.length,
        containsAnsi: diff.includes('\u001b['),
      }
    })
    await probe('linked-worktree-external-commit', '11.10.0', async (f) => {
      const linked = path.join(root, 'external linked ' + counter)
      await f.cmd('worktree', 'add', '-b', 'qa/watch', linked)
      const watcher = f.git.repositoryWatch,
        before = await watcher.status(linked)
      await fs.writeFile(path.join(linked, 'shared.txt'), 'external\n')
      await f.git.git(linked, ['add', 'shared.txt'])
      await f.git.git(linked, ['commit', '-m', 'external commit'])
      const until = Date.now() + 4000
      let after
      do {
        after = await watcher.status(linked)
        if (after.revision !== before.revision) break
        await new Promise((resolve) => setTimeout(resolve, 30))
      } while (Date.now() < until)
      const read = await watcher.read(linked, null),
        head = await f.git.head(linked)
      return {
        status:
          after.revision !== before.revision && read.snapshot?.head === head
            ? 'guard-verified'
            : 'confirmed',
        revisionChanged: after.revision !== before.revision,
        snapshotMatchesActualHead: read.snapshot?.head === head,
      }
    })
    await save(true)
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
