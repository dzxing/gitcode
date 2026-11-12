// Only for browser acceptance fixtures. Exercise the same explicit user consent
// as the application; never grant trust through an internal API or test flag.
export async function confirmFixtureTrust(page) {
  const trust = page.getByRole('dialog', { name: '信任此仓库？', exact: true })
  const open = page.getByRole('dialog', { name: '打开本地仓库', exact: true })
  const requested = await Promise.race([
    trust.waitFor({ state: 'visible' }).then(() => true),
    open.waitFor({ state: 'hidden' }).then(() => false),
  ])
  if (requested) {
    await trust.getByRole('button', { name: '信任并打开', exact: true }).click()
    await trust.waitFor({ state: 'hidden' })
  }
}
