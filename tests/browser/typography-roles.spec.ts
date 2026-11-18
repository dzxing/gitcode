import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'

for (const size of [11, 16])
  test(`界面 ${size}px 与编辑器 20px 在比较、提交弹窗及变基中独立生效`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((size) => {
      localStorage.setItem(
        'gitcode.fonts',
        JSON.stringify({
          ui: { enabled: true, family: 'Roboto', fallback: 'Noto Sans SC', size },
          code: {
            enabled: true,
            family: 'JetBrains Mono',
            fallback: 'Noto Sans SC',
            size: 20,
            lineHeight: 1.75,
          },
        }),
      )
    }, size)
    await openFixtureRepository(page)
    for (const selector of [
      '[data-top-menu="file"]',
      '.branch-main .branch-name',
      '.toolbar-actions > button',
      '.staging-zone-title',
    ])
      await expect(page.locator(selector).first()).toHaveCSS('font-size', `${size}px`)
    await expect(page.locator('.section-count')).toHaveCount(0)
    // Populate read-only plans through the same stores as the UI; no Git writes are allowed.
    await page.evaluate(`(async () => {
      const useRepositoryStore=()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('repository');
      const useCommitActionsStore=()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('commit-actions');
      const repo=useRepositoryStore(), action=useCommitActionsStore(), c=repo.repo.commits[0];
      window.gitk.commitOperationRead=async()=>({id:'font-plan',head:repo.repo.head,branch:repo.repo.branch,commits:[{sha:c.hash,message:'提交说明 commit message'}]});
      await action.open('reword',[c]);
    })()`)
    const dialog = page.getByRole('dialog', { name: '编辑提交说明', exact: true })
    await expect(dialog).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    await expect(dialog.locator('h2')).toHaveCSS('font-size', `${size}px`)
    await expect(dialog.getByLabel('提交说明', { exact: true })).toHaveCSS('font-size', '20px')
    await expect(dialog.getByLabel('提交说明', { exact: true })).toHaveCSS(
      'font-family',
      /JetBrains Mono/,
    )
    await page.screenshot({ path: `.tmp/typography-dialog-${size}.png` })
    await openFixtureRepository(page)
    await page.evaluate(`(async()=>{
      const useRepositoryStore=()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('repository');
      const useNavigationStore=()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('navigation');
      const repo=useRepositoryStore(), nav=useNavigationStore();
      window.gitk.navigationRead=async()=>({fullRef:'refs/heads/main',referenceOid:repo.repo.head,oid:repo.repo.head,head:repo.repo.head,branch:repo.repo.branch,canFastForward:false,alreadyMerged:true,related:true,files:[{path:'README.md',status:'M'}],diff:{diff:'+ comparison code',truncated:false}});
      await nav.open('compare-head',repo.repo.branches[0]);
      nav.file='README.md';
    })()`)
    const compare = page.locator('.navigation-compare-diff pre')
    await expect(compare).toBeVisible()
    await expect(compare).toHaveCSS('font-size', '20px')
    await expect(compare).toHaveCSS('font-family', /JetBrains Mono/)
    await expect(compare.locator('code').first()).toHaveCSS('font-family', /JetBrains Mono/)
    await openFixtureRepository(page)
    await page.evaluate(`(async()=>{
      const useRepositoryStore=()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('repository');
      const useRebaseStore=()=>document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('rebase');
      const repo=useRepositoryStore(), rebase=useRebaseStore(),c=repo.repo.commits[0];
      rebase.target=repo.repo.branches[0];rebase.steps=[{sha:c.hash,parents:c.parents,subject:'原始说明',message:'修改后的说明',type:'reword'}];
      rebase.plan={signature:'font-plan',steps:rebase.steps,canInteractive:true,reason:'',dirty:false};repo.rebasePlanning=true;
    })()`)
    const rebase = page.getByRole('region', { name: '交互式变基', exact: true })
    await expect(rebase.locator('textarea')).toBeVisible()
    for (const selector of ['textarea', '.rebase-commit > span']) {
      await expect(rebase.locator(selector)).toHaveCSS('font-size', '20px')
      await expect(rebase.locator(selector)).toHaveCSS('font-family', /JetBrains Mono/)
    }
    await expect(rebase.locator('select')).toHaveCSS('font-size', `${size}px`)
    await page.screenshot({ path: `.tmp/typography-rebase-${size}.png` })
    expect(errors).toEqual([])
  })
