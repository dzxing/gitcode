import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkSourceBoundaries, checkSourceNames } from '../scripts/check-source-boundaries.mjs'

async function fixture(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitcode-source-boundaries-'))
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, source)
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('feature assembly accepts shared contracts and type-only backreferences without a runtime cycle', async () => {
  await fixture(
    {
      'App.vue': '<script setup lang="ts">import "./features/history/view"</script>',
      'features/history/view.ts':
        'import { type Row } from "../../shared/contracts"; import type { Peer } from "./peer"',
      'features/history/peer.ts': 'export type { Peer } from "./view"',
      'shared/contracts/index.ts': 'export interface Row { hash: string }',
    },
    async (root) => assert.deepEqual(await checkSourceBoundaries(root), []),
  )
})

test('shared and infrastructure cannot depend on feature implementation, even through types', async () => {
  await fixture(
    {
      'features/repository/store.ts': 'export interface State {}',
      'shared/lib/format.ts': 'import type { State } from "../../features/repository/store"',
      'infrastructure/bridge.ts': 'export type { State } from "../features/repository/store"',
    },
    async (root) => {
      const failures = await checkSourceBoundaries(root)
      assert.equal(failures.length, 2)
      assert.ok(failures.every((item) => item.includes('forbidden dependency')))
    },
  )
})

test('Vue script, re-exports and dynamic imports participate in runtime cycle detection', async () => {
  await fixture(
    {
      'features/gitflow/GitFlowView.vue':
        '<script setup lang="ts">import { finish } from "./finish"</script>',
      'features/gitflow/finish.ts': 'export { finish } from "./receipt"',
      'features/gitflow/receipt.ts': 'export const finish = () => import("./GitFlowView.vue")',
    },
    async (root) => {
      const failures = await checkSourceBoundaries(root)
      assert.equal(failures.length, 1)
      assert.match(failures[0], /^Runtime cycle:/)
      assert.ok(failures[0].includes('finish.ts'))
      assert.ok(failures[0].includes('GitFlowView.vue'))
    },
  )
})

test('source naming rejects ambiguous casing while allowing conventional entry and declaration files', async () => {
  await fixture(
    {
      'App.vue': '<template><div /></template>',
      'main.ts': '',
      'vue-shim.d.ts': '',
      'shared/contracts/env.d.ts': '',
      'features/BadDirectory/commitGraph.ts': '',
      'features/history/history-filter.ts': '',
      'features/history/commitPanel.vue': '<template><div /></template>',
      'features/history/ValidPanel.vue': '<template><div /></template>',
    },
    async (root) => {
      const failures = await checkSourceBoundaries(root)
      assert.equal(failures.length, 3)
      assert.ok(failures.some((message) => message.includes('directory names')))
      assert.ok(failures.some((message) => message.includes('TypeScript filenames')))
      assert.ok(failures.some((message) => message.includes('Vue component filenames')))
    },
  )
})

test('case-insensitive path collisions are caught without relying on the host filesystem', () => {
  const failures = checkSourceNames([
    { name: 'features/history/query.ts', directory: false },
    { name: 'features/history/Query.ts', directory: false },
  ])
  assert.ok(failures.some((message) => message.includes('Case-insensitive path collision')))
})
