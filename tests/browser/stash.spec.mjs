import { test } from '@playwright/test'
import { verifyStash } from '../../scripts/verify-stash-ui.mjs'
test('inline stash creation, graph selection, shared diffs and direct recovery preserve drafts; only deletion confirms', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90000)
  await verifyStash(page, { url: baseURL })
})

import { verifyStashRepositoryScope } from '../../scripts/verify-stash-scope-ui.mjs'
test('repository stashes survive branch filters and restore to another branch without changing their base', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60000)
  await verifyStashRepositoryScope(page, { url: baseURL })
})
