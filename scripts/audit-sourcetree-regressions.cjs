'use strict'
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os')
const options = Object.fromEntries(
  process.argv.slice(2).map((v) => {
    const i = v.indexOf('=')
    return [v.slice(2, i), v.slice(i + 1)]
  }),
)
const project = path.resolve(options.project || path.join(__dirname, '..'))
const { GitService } = require(path.join(project, 'electron', 'git.cjs'))
const output = path.resolve(options.output || path.join(project, 'design', 'sourcetree-review'))
const records = []
let root,
  number = 0,
  globalFile,
  globalText
async function fixture(work) {
  const directory = path.join(root, String(number++)),
    repo = path.join(directory, 'app'),
    g = new GitService()
  await fs.mkdir(repo, { recursive: true })
  const cmd = (...args) => g.git(repo, args),
    write = (file, text) => fs.writeFile(path.join(repo, file), text)
  const commit = async (text) => {
    await cmd('add', '.')
    await cmd('commit', '-m', text)
    return g.head(repo)
  }
  const act = async (action, extra = {}) => {
    const snapshot = await g.snapshot(repo)
    return g.action(repo, {
      action,
      expectedHead: snapshot.head,
      expectedBranch: snapshot.branch,
      signature: snapshot.gitflow.signature,
      ...extra,
    })
  }
  try {
    await cmd('init', '-b', 'qa/base')
    for (const [k, v] of [
      ['user.name', 'Sourcetree QA'],
      ['user.email', 'qa@example.test'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
      ['core.hooksPath', '.git/no-hooks'],
    ])
      await cmd('config', k, v)
    await write('base.txt', 'base\n')
    const base = await commit('base')
    return await work({ directory, repo, g, cmd, write, commit, act, base })
  } finally {
    await g.shutdown()
  }
}
async function check(id, work) {
  try {
    records.push({ id, ...(await fixture(work)) })
  } catch (error) {
    records.push({ id, status: 'inconclusive', error: error.message })
  }
  console.log(records.at(-1).status + ': ' + id)
}
const command = (...args) =>
  args.map((v) => "'" + v.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'").join(' ')
async function marker(f, name) {
  const helper = path.join(f.repo, '.git', 'marker.cjs'),
    file = path.join(f.repo, '.git', name)
  await fs.writeFile(
    helper,
    "require('fs').writeFileSync(process.argv[2],'QA executed');process.stdin.pipe(process.stdout)\n",
  )
  return { file, command: command(process.execPath, helper, file) }
}
async function main() {
  await fs.mkdir(output, { recursive: true })
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-st-review-'))
  const previous = process.env.GIT_CONFIG_GLOBAL
  globalFile = path.join(root, 'global-config')
  globalText =
    '[probe]\n\tvalue = preserve\n[user]\n\tname = SourceTree QA\n\temail = qa@example.test\n'
  await fs.writeFile(globalFile, globalText)
  process.env.GIT_CONFIG_GLOBAL = globalFile
  try {
    await check('push-and-pull-use-tracking-remote', async (f) => {
      const origin = path.join(f.directory, 'origin.git'),
        upstream = path.join(f.directory, 'upstream.git')
      for (const [name, remote] of [
        ['origin', origin],
        ['upstream', upstream],
      ]) {
        await f.cmd('init', '--bare', remote)
        await f.cmd('remote', 'add', name, remote)
      }
      await f.cmd('push', 'origin', 'qa/base')
      await f.cmd('push', 'upstream', 'HEAD:refs/heads/team/target')
      await f.cmd('config', 'branch.qa/base.remote', 'upstream')
      await f.cmd('config', 'branch.qa/base.merge', 'refs/heads/team/target')
      await f.write('local.txt', 'local\n')
      const tip = await f.commit('local')
      const push = await f.g.syncPlan(f.repo, 'push', {
        expectedHead: tip,
        expectedBranch: 'qa/base',
      })
      const pushed = await f.act('push', { planId: push.id })
      const tree = (await f.cmd('rev-parse', 'HEAD^{tree}')).trim()
      const remoteTip = (
        await f.cmd('--git-dir=' + upstream, 'commit-tree', tree, '-p', tip, '-m', 'remote update')
      ).trim()
      await f.cmd('--git-dir=' + upstream, 'update-ref', 'refs/heads/team/target', remoteTip)
      const pull = await f.g.syncPlan(f.repo, 'pull', {
        expectedHead: tip,
        expectedBranch: 'qa/base',
      })
      const pulled = await f.act('pull', { planId: pull.id })
      const originUnchanged =
        (await f.cmd('--git-dir=' + origin, 'rev-parse', 'refs/heads/qa/base')).trim() === f.base
      return {
        status:
          push.remotes[0].name === 'upstream' &&
          pull.remotes[0].name === 'upstream' &&
          pushed.outcome === 'succeeded' &&
          pulled.outcome === 'succeeded' &&
          (await f.g.head(f.repo)) === remoteTip &&
          originUnchanged
            ? 'guard-verified'
            : 'confirmed',
        pushRemote: push.remotes[0].name,
        pullRemote: pull.remotes[0].name,
        destination: push.destinationRef,
        pushOutcome: pushed.outcome,
        pullOutcome: pulled.outcome,
        originUnchanged,
      }
    })
    await check('intent-to-add-remains-visible', async (f) => {
      await f.write('intent.txt', 'intent content\n')
      await f.cmd('add', '-N', 'intent.txt')
      const state = await f.g.status(f.repo),
        diff = await f.g.diff(f.repo, 'intent.txt', false)
      const staged = await f.act('stage', { paths: ['intent.txt'] })
      return {
        status:
          state.unstaged.some((x) => x.path === 'intent.txt') &&
          diff.diff.includes('+intent content') &&
          staged.outcome === 'succeeded'
            ? 'guard-verified'
            : 'confirmed',
        unstaged: state.unstaged,
        diffHasContent: diff.diff.includes('+intent content'),
        stageOutcome: staged.outcome,
      }
    })
    for (const type of ['release', 'hotfix'])
      await check('gitflow-' + type + '-literal-name', async (f) => {
        for (const [k, v] of [
          ['gitflow.branch.master', 'qa/base'],
          ['gitflow.branch.develop', 'qa/develop'],
          ['gitflow.prefix.feature', 'feature/'],
          ['gitflow.prefix.release', 'release/'],
          ['gitflow.prefix.hotfix', 'hotfix/'],
          ['gitflow.prefix.versiontag', 'v'],
        ])
          await f.cmd('config', k, v)
        await f.cmd('branch', 'qa/develop')
        const suffix = '1.0$(printf)',
          branch = type + '/' + suffix
        const started = await f.act('gitflow-start', {
          type,
          name: suffix,
          switchAfter: true,
          sourceOid: f.base,
        })
        const literal = (await f.g.currentBranch(f.repo)) === branch
        await f.write(type + '.txt', type + '\n')
        const tip = await f.commit('flow work')
        const snapshot = await f.g.snapshot(f.repo),
          tagName = 'v' + suffix
        const finished = await f.act('gitflow-finish', {
          branch,
          sourceOid: tip,
          targetOids: Object.fromEntries(
            snapshot.branches.filter((b) => b.kind === 'local').map((b) => [b.name, b.hash]),
          ),
          deleteBranch: true,
          createTag: true,
          tagName,
          tagMessage: 'QA version',
        })
        const actualTags = (await f.cmd('for-each-ref', '--format=%(refname)', 'refs/tags'))
          .trim()
          .split('\n')
        return {
          status:
            started.outcome === 'succeeded' &&
            literal &&
            finished.outcome === 'succeeded' &&
            actualTags.includes('refs/tags/' + tagName)
              ? 'guard-verified'
              : 'confirmed',
          branch,
          literalBeforeFinish: literal,
          startOutcome: started.outcome,
          finishOutcome: finished.outcome,
          actualTags,
          error: finished.error,
        }
      })
    await check('configured-external-diff-not-run-by-preview', async (f) => {
      const probe = await marker(f, 'external-diff-ran')
      await f.cmd('config', 'diff.external', probe.command)
      await f.write('base.txt', 'modified\n')
      const diff = await f.g.diff(f.repo, 'base.txt', false)
      const executed = !!(await fs.stat(probe.file).catch(() => null))
      return {
        status: !executed && diff.diff.includes('+modified') ? 'guard-verified' : 'confirmed',
        executed,
        diffReturned: diff.diff.includes('+modified'),
      }
    })
    await check('configured-fsmonitor-not-run-by-snapshot', async (f) => {
      const probe = await marker(f, 'fsmonitor-ran')
      await f.cmd('config', 'core.fsmonitor', probe.command)
      await f.g.snapshot(f.repo)
      const executed = !!(await fs.stat(probe.file).catch(() => null))
      return { status: executed ? 'confirmed' : 'guard-verified', executed }
    })
    await check('repository-clean-filter-runs-during-read', async (f) => {
      const probe = await marker(f, 'clean-filter-ran')
      await f.cmd('config', 'filter.localprobe.clean', probe.command)
      await fs.writeFile(
        path.join(f.repo, '.git', 'info', 'attributes'),
        'base.txt filter=localprobe\n',
      )
      await f.write('base.txt', 'BASE\n')
      await f.g.snapshot(f.repo)
      const snapshotExecuted = !!(await fs.stat(probe.file).catch(() => null))
      await f.g.diff(f.repo, 'base.txt', false)
      const executed = !!(await fs.stat(probe.file).catch(() => null))
      await fs.rm(probe.file, { force: true })
      await f.cmd('config', '--unset', 'filter.localprobe.clean')
      const included = path.join(f.repo, '.git', 'included-config')
      await f.cmd('config', '--file', included, 'filter.localprobe.clean', probe.command)
      await f.cmd('config', 'include.path', included)
      await f.g.snapshot(f.repo)
      const viaInclude = !!(await fs.stat(probe.file).catch(() => null))
      return {
        status: executed ? 'confirmed-risk' : 'not-reproduced',
        viaInclude,
        snapshotExecuted,
        executed,
        trigger: snapshotExecuted
          ? 'snapshot of same-size modified tracked file'
          : 'read-only diff preview',
        sideEffect: 'benign marker file inside disposable .git directory only',
      }
    })
    const preserved = (await fs.readFile(globalFile, 'utf8')) === globalText
    records.push({
      id: 'global-config-preserved-during-probes',
      status: preserved ? 'guard-verified' : 'confirmed',
      preserved,
    })
    await fs.writeFile(
      path.join(output, 'core.json'),
      JSON.stringify(
        {
          finished: true,
          platform: process.platform,
          records,
          businessRepositoriesModified: false,
          globalConfigIsolated: true,
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previous
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
