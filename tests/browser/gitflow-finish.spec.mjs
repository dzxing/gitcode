import { test } from '@playwright/test'
import { verifyGitFlowFinish } from '../../scripts/verify-gitflow-finish-ui.mjs'
for (const type of ['feature', 'release', 'hotfix'])
  test(`GitFlow ${type} Finish automatically protects and restores uncommitted files`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(90000)
    await verifyGitFlowFinish(page, { url: baseURL, type, dirty: true })
  })
for (const type of ['feature', 'release', 'hotfix'])
  test(`GitFlow ${type} Start and Finish execute real local operations`, async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(90000)
    await verifyGitFlowFinish(page, { url: baseURL, type })
  })
for (const [name, options] of [
  ['release conflicts resume after reopen', { type: 'release', conflict: true }],
  ['stop keeps completed results', { type: 'release', conflict: true, stop: true }],
  ['keep feature source', { keep: true }],
  ['tag collision blocks before mutations', { type: 'release', collision: true }],
  ['changed target blocks before mutations', { stale: true }],
  ['tag collision can be corrected', { type: 'release', collision: true, recover: true }],
  ['changed targets require explicit reread', { stale: true, recover: true }],
])
  test('GitFlow ' + name, async ({ page, baseURL }) => {
    test.setTimeout(90000)
    await verifyGitFlowFinish(page, { url: baseURL, ...options })
  })
