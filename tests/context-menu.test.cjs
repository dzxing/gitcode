const test = require('node:test')
const assert = require('node:assert/strict')
const { ContextMenus, sanitizeRequest } = require('../electron/context-menu.cjs')
const item = { id: 'checkout', label: '切换分支', enabled: true }
const request = (requestId = 1, items = [item]) => ({ requestId, items })
function fixture() {
  const menus = []
  const controller = new ContextMenus({
    buildFromTemplate(template) {
      const menu = {
        template,
        closed: false,
        popup(options) {
          this.options = options
        },
        closePopup() {
          this.closed = true
          this.options.callback()
        },
      }
      menus.push(menu)
      return menu
    },
  })
  const window = { isDestroyed: () => false }
  return { controller, window, menus }
}
test('native context menus accept only display data and compact separators', () => {
  const result = sanitizeRequest(
    request(1, [
      { type: 'separator' },
      { ...item, role: 'reload', accelerator: 'Ctrl+R', click: 'arbitrary' },
      { type: 'separator' },
      { type: 'separator' },
      { id: 'directory-grouping', label: '按目录分组', enabled: true, checked: true },
      { type: 'separator' },
    ]),
  )
  assert.deepEqual(result.items, [
    item,
    { type: 'separator' },
    {
      id: 'directory-grouping',
      label: '按目录分组',
      enabled: true,
      type: 'checkbox',
      checked: true,
    },
  ])
  for (const invalid of [
    request(0),
    request(1, []),
    request(1, [item, item]),
    request(1, [{ ...item, label: 'bad\nlabel' }]),
    request(1, [{ ...item, enabled: 'yes' }]),
    request(1, [{ ...item, checked: 'yes' }]),
  ])
    assert.throws(() => sanitizeRequest(invalid))
})
test('selection returns one enabled ID and literal ampersands are preserved', async () => {
  const { controller, window, menus } = fixture()
  const pending = controller.popup(window, request(1, [{ ...item, label: 'feature/a&b' }]))
  assert.equal(menus[0].template[0].label, 'feature/a&&b')
  menus[0].options.callback()
  menus[0].template[0].click()
  assert.equal(await pending, 'checkout')
  menus[0].template[0].click()
  assert.equal(controller.active, null)
})
test('disabled clicks do nothing and dismissal cancels without a selected command', async () => {
  const { controller, window, menus } = fixture()
  const pending = controller.popup(window, request(1, [{ ...item, enabled: false }]))
  menus[0].template[0].click()
  assert.equal(controller.active.id, 1)
  menus[0].options.callback()
  assert.equal(await pending, null)
})
test('replaced menus, stale callbacks and stale cancellation cannot act on a newer menu', async () => {
  const { controller, window, menus } = fixture()
  const first = controller.popup(window, request(1))
  const second = controller.popup(window, request(2))
  assert.equal(await first, null)
  assert.equal(menus[0].closed, true)
  controller.close(1)
  menus[0].template[0].click()
  assert.equal(controller.active.id, 2)
  menus[1].template[0].click()
  assert.equal(await second, 'checkout')
})
test('shutdown cancels the current menu and popup failures leave no dangling request', async () => {
  const { controller, window, menus } = fixture()
  const pending = controller.popup(window, request())
  controller.close()
  assert.equal(await pending, null)
  assert.equal(menus[0].closed, true)
  assert.equal(await controller.popup({ isDestroyed: () => true }, request(2)), null)
  const broken = new ContextMenus({
    buildFromTemplate() {
      throw new Error('native unavailable')
    },
  })
  await assert.rejects(broken.popup(window, request()), /native unavailable/)
  assert.equal(broken.active, null)
})
