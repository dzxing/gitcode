import { chromium, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const require = createRequire(import.meta.url)
const { GitService } = require('../electron/git.cjs')
const git = new GitService()
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitcode-chrome-commit-'))
const repo = path.join(root, 'repo')
await fs.mkdir(repo)
const cmd = (...args) => git.git(repo, args)
await cmd('init', '-b', 'feature/menu-verification')
await cmd('config', 'user.name', 'Chrome Verification')
await cmd('config', 'user.email', 'chrome@test.invalid')
await cmd('config', 'commit.gpgsign', 'false')
const commit = async (name, text, message) => {
  await fs.writeFile(path.join(repo, name), text)
  await cmd('add', name)
  await cmd('commit', '-m', message)
  return git.head(repo)
}
const initial = await commit('base.txt', 'base\n', 'initial')
const first = await commit('a.txt', 'first\n', 'first change')
await commit('b.txt', 'second\n', 'second change')
process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
process.env.no_proxy = process.env.NO_PROXY
const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 12000 })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
})
const page = await context.newPage()
const errors = [],
  checks = []
page.on('pageerror', (e) => errors.push(e.message))
const evidence = 'design/idea-commit-menu/implementation'
const menu = () => page.getByRole('menu')
async function openMenu(oid) {
  await page.locator(`[data-commit-hash="${oid}"]`).click({ button: 'right' })
}
async function choose(oid, name) {
  await openMenu(oid)
  await menu().getByRole('menuitem', { name, exact: true }).click()
}
try {
  await page.goto('http://localhost:43291/')
  await page
    .getByRole('main', { name: '新标签页', exact: true })
    .getByRole('button', { name: '打开仓库', exact: true })
    .click()
  const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  await open.getByLabel('仓库路径', { exact: true }).fill(repo)
  await open.getByRole('button', { name: '打开仓库', exact: true }).click()
  await page.getByRole('button', { name: '信任并打开', exact: true }).click()
  await expect(page.locator('.commit-row')).toHaveCount(3)
  checks.push('真实本机核心打开独立临时仓库；信任后加载三条提交')
  await openMenu(first)
  await expect(menu().getByRole('menuitem')).toHaveCount(21)
  await expect(menu().getByRole('separator')).toHaveCount(6)
  await page.screenshot({ path: `${evidence}/live-menu.png` })
  await page.keyboard.press('Escape')
  await choose(first, '在修订版中显示仓库')
  let dialog = page.getByRole('dialog', { name: '在修订版中显示仓库', exact: true })
  await dialog.getByRole('button', { name: 'a.txt', exact: true }).click()
  await expect(dialog.locator('.commit-history-content')).toHaveText('first')
  await page.screenshot({ path: `${evidence}/live-history-tree.png` })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  checks.push('21 项正式菜单、7 分组；历史树读取真实 SHA 文件，不切换工作区')
  await choose(first, '编辑提交消息…')
  dialog = page.getByRole('dialog', { name: '编辑提交消息', exact: true })
  await expect(dialog.getByLabel('提交消息', { exact: true })).toHaveValue('first change')
  await dialog.getByLabel('提交消息', { exact: true }).fill('first edited from Chrome')
  await dialog.getByRole('button', { name: '保存说明', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const log = await cmd('log', '-2', '--format=%s')
  expect(log.trim()).toBe('second change\nfirst edited from Chrome')
  checks.push('通过正式菜单编辑旧消息，选中提交与后继均已正确重写')
  await choose(initial, '从这里进行交互式变基…')
  dialog = page.getByRole('dialog', { name: '从这里进行交互式变基', exact: true })
  await expect(dialog.locator('.commit-operation-step')).toHaveCount(3)
  await expect(dialog.locator('.commit-operation-step code').first()).toHaveText(
    initial.slice(0, 7),
  )
  await page.screenshot({ path: `${evidence}/live-inclusive-rebase.png` })
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  checks.push('从根提交开始编排，计划确实包含选中提交；取消不写 Git')
  const head = await git.head(repo)
  await choose(head, '撤消提交…')
  dialog = page.getByRole('dialog', { name: '撤消提交', exact: true })
  await dialog.getByRole('button', { name: '撤销提交', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect((await cmd('log', '-1', '--format=%s')).trim()).toBe('first edited from Chrome')
  expect((await cmd('diff', '--cached', '--name-only')).trim()).toBe('b.txt')
  checks.push('通过正式菜单撤消 HEAD；真实 Git 确认更改保留在暂存区')
  expect(errors).toEqual([])
  checks.push('Chrome 无未处理页面异常；原 Chrome 标签和用户仓库未改动')
  await page.screenshot({ path: `${evidence}/live-undo-result.png` })
  await fs.writeFile(
    `${evidence}/live-chrome.json`,
    JSON.stringify(
      {
        transport: 'Chrome CDP localhost:9222',
        backend: 'real local Git core',
        isolatedBrowserContext: true,
        fixture: 'disposable temp repository',
        checks,
        pageErrors: errors,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(JSON.stringify({ passed: checks.length, pageErrors: errors }))
} finally {
  await context.close()
  await browser.close()
  await git.shutdown()
  await fs.rm(root, { recursive: true, force: true })
}
