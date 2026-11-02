const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isCommand,
  editCommands,
  sanitizeState,
  buildMenuTemplate,
} = require('../electron/menus.cjs')
const { CloseCoordinator } = require('../electron/close-coordinator.cjs')

test('application menu accepts only named commands and uses text editing roles', () => {
  assert.equal(isCommand('file.closeTab'), true)
  assert.equal(isCommand('file.recent.5'), true)
  assert.equal(isCommand('file.recent.6'), false)
  assert.equal(isCommand('git.reset'), false)
  assert.equal(editCommands.has('reset'), false)
  assert.throws(() => sanitizeState({ enabled: ['shell.execute'], recent: [] }))
  const state = sanitizeState({
    enabled: ['file.closeTab', 'edit.undo', 'view.sha'],
    recent: ['repo'],
    sha: true,
  })
  const calls = []
  const template = buildMenuTemplate(state, (id) => calls.push(id), 'darwin')
  const flat = template.flatMap((group) => group.submenu)
  const close = flat.find((item) => item.id === 'file.closeTab')
  assert.equal(close.role, undefined)
  assert.equal(close.accelerator, 'CmdOrCtrl+W')
  close.click()
  assert.deepEqual(calls, ['file.closeTab'])
  assert.equal(flat.find((item) => item.id === 'edit.undo').role, 'undo')
  assert.equal(flat.find((item) => item.id === 'view.sha').checked, true)
  assert.equal(
    flat.some((item) =>
      ['reload', 'forceReload', 'toggleDevTools', 'viewMenu', 'quit'].includes(item.role),
    ),
    false,
  )
})

test('close requests are coalesced, token checked and finish exactly once', async () => {
  const sent = []
  let finished = 0
  const coordinator = new CloseCoordinator({
    send: (id) => sent.push(id),
    fallback: async () => false,
    finish: async () => {
      finished++
    },
    timeout: 100,
  })
  coordinator.request()
  coordinator.request()
  assert.deepEqual(sent, [1])
  coordinator.acknowledge(1)
  assert.equal(coordinator.approve(99), false)
  coordinator.cancel(99)
  assert.equal(coordinator.pending.id, 1)
  coordinator.cancel(1)
  coordinator.request()
  coordinator.acknowledge(2)
  assert.deepEqual(sent, [1, 2])
  assert.equal(coordinator.approve(1), false)
  assert.equal(coordinator.approve(2), true)
  assert.equal(coordinator.approve(2), false)
  coordinator.request()
  await Promise.resolve()
  assert.equal(finished, 1)
  assert.deepEqual(sent, [1, 2])
})

test('acknowledged renderer owns close confirmation; unavailable renderer uses bounded fallback', async () => {
  let fallback = 0,
    finished = 0
  const coordinator = new CloseCoordinator({
    send: () => {},
    fallback: async () => {
      fallback++
      return true
    },
    finish: async () => {
      finished++
    },
    timeout: 15,
  })
  coordinator.request()
  coordinator.acknowledge(1)
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(fallback, 0)
  assert.equal(finished, 0)
  coordinator.cancel(1)
  coordinator.request()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(fallback, 1)
  assert.equal(finished, 1)
})

test('renderer crash clears stale close tokens without silently quitting', async () => {
  let finished = 0
  const coordinator = new CloseCoordinator({
    send: () => {},
    fallback: async () => false,
    finish: async () => {
      finished++
    },
    timeout: 100,
  })
  coordinator.request()
  coordinator.acknowledge(1)
  coordinator.rendererGone()
  assert.equal(coordinator.approve(1), false)
  coordinator.request()
  coordinator.acknowledge(2)
  coordinator.cancel(2)
  assert.equal(finished, 0)
})
