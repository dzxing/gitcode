const test = require('node:test')
const assert = require('node:assert/strict')
const { WindowRecovery } = require('../electron/window-recovery.cjs')

function fixture(responses = [2]) {
  const calls = [],
    messages = []
  const recovery = new WindowRecovery({
    window: {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
    },
    dialog: {
      showMessageBox: async (_window, options) => {
        messages.push(options)
        return { response: responses.shift() ?? 2 }
      },
    },
    reload: async () => {
      calls.push('reload')
    },
    openLogs: async () => {
      calls.push('logs')
      return ''
    },
    isClosing: () => false,
    report: () => {},
  })
  return { recovery, calls, messages }
}

test('renderer failures offer native recovery with a safe default and no automatic reload', async () => {
  for (const kind of ['load', 'crash', 'unresponsive']) {
    const { recovery, calls, messages } = fixture()
    await recovery.recover(kind, 'test diagnostic')
    assert.deepEqual(calls, ['restore', 'show'])
    assert.equal(messages[0].defaultId, 2)
    assert.equal(messages[0].cancelId, 2)
    assert.match(messages[0].detail, /不会重试原来的 Git 操作/)
    assert.match(messages[0].detail, /后台任务可能仍在运行/)
    assert.match(messages[0].detail, /test diagnostic/)
  }
})

test('concurrent load rejection and crash events share a single native prompt', async () => {
  const { recovery, messages, calls } = fixture()
  let resolve
  recovery.dialog.showMessageBox = (_window, options) => {
    messages.push(options)
    return new Promise((done) => {
      resolve = done
    })
  }
  const first = recovery.recover('load')
  const second = recovery.recover('crash')
  assert.equal(first, second)
  assert.equal(messages.length, 1)
  resolve({ response: 0 })
  await first
  assert.equal(calls.filter((c) => c === 'reload').length, 1)
  assert.equal(recovery.pending, null)
})

test('failed reload keeps recovery available; opening logs does not execute Git operations', async () => {
  const { recovery, calls, messages } = fixture([0, 1, 0])
  let attempts = 0
  recovery.reload = async () => {
    calls.push('reload')
    if (++attempts === 1) throw new Error('missing renderer file')
  }
  await recovery.recover('load')
  assert.equal(messages.length, 3)
  assert.match(messages[1].detail, /重新加载失败/)
  assert.equal(calls.filter((c) => c === 'reload').length, 2)
  assert.equal(calls.filter((c) => c === 'logs').length, 1)
})

test('log-directory errors remain visible and user can cancel recovery', async () => {
  const { recovery, messages } = fixture([1, 2])
  recovery.openLogs = async () => 'Access denied'
  await recovery.recover('crash')
  assert.equal(messages.length, 2)
  assert.match(messages[1].detail, /无法打开日志目录/)
})

test('destroyed and closing windows do not prompt or reload, including after a pending choice', async () => {
  for (const state of ['destroyed', 'closing']) {
    const { recovery, messages, calls } = fixture([0])
    if (state === 'destroyed') recovery.window.isDestroyed = () => true
    else recovery.isClosing = () => true
    await recovery.recover('crash')
    assert.equal(messages.length, 0)
    assert.equal(calls.length, 0)
  }
  const { recovery, calls } = fixture()
  recovery.dialog.showMessageBox = async () => {
    recovery.isClosing = () => true
    return { response: 0 }
  }
  await recovery.recover('crash')
  assert.ok(!calls.includes('reload'))
})

test('native dialog errors settle recovery without an unhandled rejection', async () => {
  const { recovery } = fixture()
  recovery.dialog.showMessageBox = async () => {
    throw new Error('window closed')
  }
  await recovery.recover('load')
  assert.equal(recovery.pending, null)
})

test('diagnostic recording failures never prevent native recovery', async () => {
  const { recovery, messages } = fixture()
  recovery.record = () => {
    throw new Error('disk unavailable')
  }
  await recovery.recover('crash', 'diagnostic')
  assert.equal(messages.length, 1)
})
