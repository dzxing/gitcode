import { expect, test } from '@playwright/test'
import { repositoryFixture } from '../fixtures/repository'
import { openFixtureRepository } from './repository-fixture'

async function planFixture(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    window.gitk!.commitOperationRead = async (_path, request) => {
      document.documentElement.dataset.commitRequest = JSON.stringify(request)
      const repo = await window.gitk!.snapshot(_path)
      const commits = request.oids.map((sha) => {
        const c = repo.commits.find((c) => c.hash === sha)!
        return { sha, parents: c.parents, subject: c.subject, message: c.subject }
      })
      return {
        id: 'commit-plan',
        head: request.expectedHead,
        branch: request.expectedBranch,
        commits,
        dirty: true,
        files: [{ path: 'README.md', status: 'M' }],
        rebase: {
          signature: 'inclusive-plan',
          fromHere: true,
          canInteractive: true,
          reason: '',
          dirty: false,
          steps: commits.map((c) => ({
            ...c,
            author: '',
            email: '',
            date: '',
            type: 'pick' as const,
          })),
        },
      }
    }
    window.gitk!.action = async (path, request) => {
      document.documentElement.dataset.commitWrite = JSON.stringify(request)
      return { snapshot: await window.gitk!.snapshot(path), output: '', outcome: 'succeeded' }
    }
  })
}
const commitRow = (page: import('@playwright/test').Page, i: number) =>
  page.locator(`[data-commit-hash="${repositoryFixture.commits[i]!.hash}"]`)

test('正式 reset 表单默认 Mixed、Hard 明确确认，提交绑定冻结计划', async ({ page }) => {
  await openFixtureRepository(page)
  await planFixture(page)
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '将当前分支重置到此处…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '将当前 HEAD 重置到此处', exact: true })
  await expect(dialog.getByRole('radio', { name: 'MIXED', exact: true })).toBeChecked()
  await dialog.getByRole('radio', { name: 'HARD', exact: true }).check()
  await expect(dialog.getByRole('button', { name: '重置 HEAD', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /确认丢弃更改/ }).check()
  await dialog.getByRole('button', { name: '重置 HEAD', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const request = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.commitWrite!),
  )
  expect(request).toMatchObject({
    action: 'commit-operation',
    planId: 'commit-plan',
    mode: 'hard',
    confirmHard: true,
    expectedHead: repositoryFixture.head,
  })
})

test('Ctrl 多选已有提交启用压缩；消息和完整选中集进入计划', async ({ page }) => {
  await openFixtureRepository(page)
  await planFixture(page)
  await commitRow(page, 2).locator('.commit-select').click()
  await commitRow(page, 3)
    .locator('.commit-select')
    .click({ modifiers: ['Control'] })
  await commitRow(page, 2).click({ button: 'right' })
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveCount(21)
  await expect(page.getByRole('menuitem', { name: '检出修订', exact: true })).toBeDisabled()
  await page.getByRole('menuitem', { name: '压缩提交…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '压缩提交', exact: true })
  await expect(dialog).toBeVisible()
  const request = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.commitRequest!),
  )
  expect(new Set(request.oids)).toEqual(
    new Set([repositoryFixture.commits[2]!.hash, repositoryFixture.commits[3]!.hash]),
  )
  await dialog.getByLabel('提交说明', { exact: true }).fill('combined message')
  await dialog.getByRole('button', { name: '压缩提交' }).click()
  expect(
    await page.evaluate(() => JSON.parse(document.documentElement.dataset.commitWrite!).message),
  ).toBe('combined message')
})

test('Fixup 显示选中文件与消息，交互式编排包含起点并支持 fixup', async ({ page }) => {
  await openFixtureRepository(page)
  await planFixture(page)
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Fixup…', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Fixup', exact: true })
  await expect(dialog.getByLabel('提交说明', { exact: true })).toHaveValue(
    `fixup! ${repositoryFixture.commits[2]!.subject}`,
  )
  await expect(dialog.getByRole('checkbox', { name: 'README.md', exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '从这里进行交互式变基…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '从这里进行交互式变基', exact: true })
  await expect(dialog.locator('.commit-operation-step')).toHaveCount(1)
  await expect(dialog.locator('.commit-operation-step code')).toHaveText(
    repositoryFixture.commits[2]!.hash.slice(0, 7),
  )
})

test('历史树和补丁使用只读桥接，文件内容可选择，保存补丁不写 Git', async ({ page }) => {
  await openFixtureRepository(page)
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在修订版中显示仓库', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '在修订版中显示仓库', exact: true })
  await dialog.getByRole('button', { name: 'README.md', exact: true }).click()
  await expect(dialog.locator('.commit-history-content')).toHaveText('# historical fixture')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '创建补丁…', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '创建补丁', exact: true })
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '保存补丁…', exact: true }).click()
  expect((await download).suggestedFilename()).toContain('.patch')
})

test('没有托管平台时给出明确说明；检出默认分离 HEAD 并说明本地更改保护', async ({ page }) => {
  await openFixtureRepository(page)
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在浏览器中查看', exact: true }).click()
  await expect(
    page.getByText('未识别出支持的托管平台地址；目前支持 GitHub、GitLab 和 Bitbucket。', {
      exact: true,
    }),
  ).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '检出修订', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '检出修订', exact: true })
  await expect(dialog.getByRole('combobox', { name: '检出目标', exact: true })).toHaveValue('')
  await expect(
    dialog.getByText(/未提交更改会先检查，需要保留的更改会自动贮藏并尝试恢复/),
  ).toBeVisible()
})

test('按提交推送计划固定源末端；分支源和原 HEAD 分开验证', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitk!.commitOperationRead = async (_path, request) => ({
      sources: [{ fullRef: 'refs/heads/main', oid: request.expectedHead }],
    })
    window.gitk!.syncPlan = async (_path, _kind, request) => {
      document.documentElement.dataset.pushCommit = JSON.stringify(request)
      return {
        id: 'push-commit-plan',
        kind: 'push',
        head: request.commitOid!,
        branch: 'main',
        worktreeBranch: 'main',
        sourceRef: 'refs/heads/main',
        destinationRef: 'refs/heads/main',
        expiresAt: Date.now() + 10000,
        remoteCheck: { state: 'forward', oid: 'a'.repeat(40), checkedAt: Date.now() },
        remotes: [{ name: 'origin', address: 'fixture' }],
      }
    }
  })
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '推送此前所有提交…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '推送此前所有提交', exact: true })
  await expect(dialog.getByLabel('源末端', { exact: true })).toHaveValue(
    repositoryFixture.commits[2]!.hash,
  )
  await expect(dialog.getByRole('button', { name: '推送', exact: true })).toBeEnabled()
  expect(
    await page.evaluate(() => JSON.parse(document.documentElement.dataset.pushCommit!)),
  ).toMatchObject({
    commitOid: repositoryFixture.commits[2]!.hash,
    expectedHead: repositoryFixture.head,
    sourceOid: repositoryFixture.head,
  })
})

test('历史目录能展开折叠；Ctrl 取消多选后不能压缩两条提交', async ({ page }) => {
  await openFixtureRepository(page)
  await page.evaluate(() => {
    window.gitk!.commitOperationRead = async () => ({
      entries: [
        { mode: '100644', type: 'blob', oid: 'a'.repeat(40), path: 'src/components/A.vue' },
      ],
    })
  })
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在修订版中显示仓库', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '在修订版中显示仓库', exact: true })
  await expect(dialog.getByRole('button', { name: 'A.vue', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'src', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'A.vue', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'src', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'A.vue', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await commitRow(page, 2).locator('.commit-select').click()
  await commitRow(page, 3)
    .locator('.commit-select')
    .click({ modifiers: ['Control'] })
  await commitRow(page, 3)
    .locator('.commit-select')
    .click({ modifiers: ['Control'] })
  await commitRow(page, 2).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '压缩提交…', exact: true })).toBeDisabled()
})

test('新建标记入口同时提供轻量和附注标签，附注模式要求消息', async ({ page }) => {
  await openFixtureRepository(page)
  await planFixture(page)
  await page.evaluate(() => {
    window.gitk!.navigationRead = async (_repo, request) => ({
      fullRef: request.fullRef,
      referenceOid: request.expectedOid,
      oid: request.expectedOid,
      head: request.expectedHead,
      branch: request.expectedBranch,
      canFastForward: false,
      alreadyMerged: true,
      related: true,
    })
  })
  await commitRow(page, 2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '新建标记…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '创建标签', exact: true })
  await dialog.getByLabel('标签名称', { exact: true }).fill('v2-test')
  await expect(dialog.getByRole('button', { name: '创建标签', exact: true })).toBeEnabled()
  await dialog.getByRole('checkbox', { name: '创建附注标签', exact: true }).check()
  await expect(dialog.getByRole('button', { name: '创建标签', exact: true })).toBeDisabled()
  await dialog.getByLabel('标签说明', { exact: true }).fill('annotated test')
  await dialog.getByRole('button', { name: '创建标签', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(
    await page.evaluate(() => JSON.parse(document.documentElement.dataset.commitWrite!)),
  ).toMatchObject({
    action: 'create-tag',
    annotated: true,
    message: 'annotated test',
    expectedOid: repositoryFixture.commits[2]!.hash,
  })
})

test('Shift 范围只选择当前可见提交，筛选后不会把隐藏提交加入写操作', async ({ page }) => {
  await openFixtureRepository(page)
  await planFixture(page)
  await commitRow(page, 2).locator('.commit-select').click()
  await commitRow(page, 3)
    .locator('.commit-select')
    .click({ modifiers: ['Control'] })
  await page
    .getByPlaceholder('搜索已加载提交；输入 SHA 后按 Enter 定位', { exact: true })
    .fill('feat(graph)')
  await expect(page.locator('.commit-row')).toHaveCount(2)
  await commitRow(page, 4)
    .locator('.commit-select')
    .click({ modifiers: ['Shift'] })
  await commitRow(page, 4).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '压缩提交…', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '压缩提交', exact: true })).toBeVisible()
  const request = await page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.commitRequest!),
  )
  expect(new Set(request.oids)).toEqual(
    new Set([repositoryFixture.commits[2]!.hash, repositoryFixture.commits[4]!.hash]),
  )
  expect(request.oids).not.toContain(repositoryFixture.commits[3]!.hash)
})
