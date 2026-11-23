const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const { GitService } = require('../electron/git.cjs')
const execute = promisify(execFile)

async function fixture(t, trust = false) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-terminal-中文 '))
  await execute('git', ['init', '-b', 'qa/terminal', repo])
  const git = new GitService({ enforceRepositoryTrust: trust })
  t.after(async () => {
    await git.shutdown()
    await fs.rm(repo, { recursive: true, force: true })
  })
  return { repo, git, terminal: git.terminal }
}
async function until(terminal, repo, id, pattern, cursor = 0) {
  let output = ''
  for (let i = 0; i < 150; i++) {
    const result = await terminal.request(repo, { action: 'read', id, cursor })
    cursor = result.cursor
    output += result.data
    if (pattern.test(output)) return { output, cursor }
    await delay(40)
  }
  throw Error('Terminal output did not match ' + pattern + ': ' + output.slice(-2000))
}
const posix = { skip: process.platform === 'win32' }

test(
  'real PTY has repository cwd, supports resize, separate Shells and Ctrl+C',
  posix,
  async (t) => {
    const { repo, terminal } = await fixture(t)
    const first = await terminal.request(repo, {
      action: 'create',
      tabId: 1,
      shell: 'bash',
      cols: 80,
      rows: 24,
    })
    const second = await terminal.request(repo, {
      action: 'create',
      tabId: 2,
      shell: 'bash',
      cols: 80,
      rows: 24,
    })
    await terminal.request(repo, { action: 'resize', id: first.id, cols: 92, rows: 31 })
    await terminal.request(repo, {
      action: 'write',
      id: first.id,
      data: "QA_TERMINAL=one; pwd; stty size; printf '__READY%s__\\n' 'FIRST'\r",
    })
    const result = await until(terminal, repo, first.id, /__READYFIRST__/)
    assert.ok(result.output.includes(repo))
    assert.match(result.output, /31 92/)
    await terminal.request(repo, {
      action: 'write',
      id: second.id,
      data: 'printf \'__ISOLATED%s__\\n\' "${QA_TERMINAL:-empty}"\r',
    })
    await until(terminal, repo, second.id, /__ISOLATEDempty__/)
    await terminal.request(repo, { action: 'write', id: first.id, data: 'sleep 30\r' })
    await delay(150)
    await terminal.request(repo, { action: 'write', id: first.id, data: '\x03' })
    await terminal.request(repo, {
      action: 'write',
      id: first.id,
      data: "printf '__AFTER%s__\\n' 'INTERRUPT'\r",
    })
    await until(terminal, repo, first.id, /__AFTERINTERRUPT__/, result.cursor)
    await terminal.request(repo, { action: 'close', id: first.id })
    await assert.rejects(
      terminal.request(repo, { action: 'read', id: first.id, cursor: 0 }),
      /关闭/,
    )
    assert.equal(
      (await terminal.request(repo, { action: 'read', id: second.id, cursor: 0 })).state,
      'running',
    )
  },
)

test('untrusted repositories cannot start a terminal; approval is rechecked', posix, async (t) => {
  const { repo, git, terminal } = await fixture(t, true)
  const request = { action: 'create', tabId: 1, cols: 80, rows: 24 }
  await assert.rejects(terminal.request(repo, request), /信任/)
  assert.equal(terminal.worker, null)
  const consent = await git.trust.inspect(repo)
  await git.trust.approve(repo, consent.token)
  const session = await terminal.request(repo, request)
  assert.ok(session.id)
})

test(
  'terminal validates session ownership, sizes, input limits and Shell identifiers',
  posix,
  async (t) => {
    const { repo, terminal } = await fixture(t)
    await assert.rejects(
      terminal.request(repo, { action: 'create', tabId: 1, cols: 0, rows: 24 }),
      /尺寸/,
    )
    await assert.rejects(
      terminal.request(repo, {
        action: 'create',
        tabId: 1,
        cols: 80,
        rows: 24,
        shell: '/bin/sh -c malicious',
      }),
      /Shell/,
    )
    assert.equal(terminal.worker, null)
    const session = await terminal.request(repo, { action: 'create', tabId: 1, cols: 80, rows: 24 })
    await assert.rejects(
      terminal.request(repo + '-other', { action: 'write', id: session.id, data: 'echo wrong\r' }),
      /不属于/,
    )
    await assert.rejects(
      terminal.request(repo, { action: 'write', id: session.id, data: 'a'.repeat(65537) }),
      /输入过大/,
    )
    await assert.rejects(
      terminal.request(repo, { action: 'read', id: session.id, cursor: -1 }),
      /读取位置/,
    )
  },
)

test(
  'flood output is bounded and reports dropped data without growing the host buffer',
  posix,
  async (t) => {
    const { repo, terminal } = await fixture(t)
    const session = await terminal.request(repo, { action: 'create', tabId: 1, cols: 80, rows: 24 })
    await terminal.request(repo, {
      action: 'write',
      id: session.id,
      data: "head -c 900000 /dev/zero | tr '\\0' x; printf '__FLOOD%s__\\n' 'DONE'\r",
    })
    for (
      let i = 0;
      i < 150 && !terminal.sessions.get(session.id).output.includes('__FLOODDONE__');
      i++
    )
      await delay(40)
    const stored = terminal.sessions.get(session.id)
    assert.ok(stored.output.length <= 512 * 1024)
    assert.ok(stored.cursor > 512 * 1024)
    const read = await terminal.request(repo, { action: 'read', id: session.id, cursor: 0 })
    assert.equal(read.dropped, true)
    assert.equal(read.more, true)
    assert.ok(read.data.length <= 64 * 1024)
  },
)

test(
  'host failure marks sessions exited and a new session can start another host',
  posix,
  async (t) => {
    const { repo, terminal } = await fixture(t)
    const first = await terminal.request(repo, { action: 'create', tabId: 1, cols: 80, rows: 24 })
    const previous = terminal.worker
    previous.kill('SIGTERM')
    await new Promise((resolve) => previous.once('exit', resolve))
    assert.equal(
      (await terminal.request(repo, { action: 'read', id: first.id, cursor: 0 })).state,
      'exited',
    )
    const second = await terminal.request(repo, { action: 'create', tabId: 1, cols: 80, rows: 24 })
    assert.ok(second.id)
    assert.notEqual(terminal.worker.pid, previous.pid)
    const current = terminal.worker
    await terminal.shutdown()
    assert.throws(() => process.kill(current.pid, 0), { code: 'ESRCH' })
  },
)

test('shutdown during repository validation never starts a late terminal', async () => {
  let release
  const repository = new Promise((resolve) => {
    release = resolve
  })
  const { TerminalService } = require('../electron/terminal.cjs')
  const service = new TerminalService({
    closing: false,
    job: (work) => work(),
    repository: () => repository,
  })
  const creating = service.request('/repo', { action: 'create', tabId: 1, cols: 80, rows: 24 })
  await service.shutdown()
  release('/repo')
  await assert.rejects(creating, /退出/)
  assert.equal(service.worker, null)
})
