import { expect, test } from '@playwright/test'

test('dark directory browser navigates and selects a repository without a native dialog', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const home = '/home/test'
    Object.assign(window, {
      gitcode: {
        runtime: async () => ({
          platform: 'linux',
          gitAvailable: true,
          gitVersion: 'git test',
          gitPath: '/usr/bin/git',
          gitError: '',
        }),
        listDirectory: async (initial?: string) => ({
          path: initial || home,
          parent: '/',
          root: '/',
          home,
          folders: [
            {
              name: 'project',
              path: `${home}/project`,
              isGit: true,
              hidden: false,
              symlink: false,
            },
          ],
          truncated: false,
        }),
        chooseDirectory: async () => {
          throw new Error('The native picker must not be invoked')
        },
      },
    })
  })
  await page.goto('/')
  await page.keyboard.press('Control+o')
  await page
    .getByRole('dialog', { name: '打开本地仓库', exact: true })
    .locator('summary', { hasText: '更多选项' })
    .click()
  await page.getByRole('button', { name: '使用内置目录浏览器…', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '选择 Git 仓库', exact: true })
  await expect(picker).toBeVisible()
  await expect(picker.getByText('Git 仓库', { exact: true })).toBeVisible()
  await picker.getByRole('button', { name: 'project Git 仓库', exact: true }).click()
  await picker.getByRole('button', { name: '选择仓库目录', exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(page.getByRole('textbox', { name: '仓库路径', exact: true })).toHaveValue(
    '/home/test/project',
  )
})
