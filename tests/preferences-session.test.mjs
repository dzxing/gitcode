import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
const server = await createServer({ configFile: false, server: { middlewareMode: true } })
after(() => server.close())
const { commitPreferences } = await server.ssrLoadModule('/src/preferencesSession.ts')
function memory(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}
test('apply persists the complete changed set', () => {
  const storage = memory({ theme: 'dark' })
  commitPreferences(storage, { theme: 'light', fonts: 'new' }, { theme: 'dark', fonts: null })
  assert.deepEqual(Object.fromEntries(storage.values), { theme: 'light', fonts: 'new' })
})
test('partial save failure restores replaced and previously absent preferences', () => {
  const storage = memory({ theme: 'dark' })
  const write = storage.setItem
  storage.setItem = (key, value) => {
    if (key === 'fonts') throw Error('quota')
    write(key, value)
  }
  assert.throws(
    () =>
      commitPreferences(
        storage,
        { theme: 'light', graph: 'new', fonts: 'new' },
        { theme: 'dark', graph: null, fonts: null },
      ),
    /已恢复原有保存值/,
  )
  assert.deepEqual(Object.fromEntries(storage.values), { theme: 'dark' })
})
test('concurrent preference changes are rejected before any writes', () => {
  const storage = memory({ theme: 'external' })
  assert.throws(
    () =>
      commitPreferences(storage, { fonts: 'new', theme: 'light' }, { fonts: null, theme: 'dark' }),
    /其他窗口更新/,
  )
  assert.deepEqual(Object.fromEntries(storage.values), { theme: 'external' })
})
test('rollback failure explicitly reports that persistence may be partial', () => {
  const storage = memory({ theme: 'dark' })
  storage.setItem = (key, value) => {
    if (key === 'theme' && value === 'light') storage.values.set(key, value)
    else throw Error('storage unavailable')
  }
  assert.throws(
    () =>
      commitPreferences(storage, { theme: 'light', fonts: 'new' }, { theme: 'dark', fonts: null }),
    /部分设置可能已经保存/,
  )
})
