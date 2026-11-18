import { expect, test } from '@playwright/test'
import { openFixtureRepository } from './repository-fixture'
import type { SyncPlan } from '../../src/types'

async function notify(page: import('@playwright/test').Page, texts: string[]) {
  return page.evaluate(async (texts) => {
    const modulePath = '/src/stores/repository.ts'
    const store = (await import(modulePath)).useRepositoryStore()
    store.notices = []
    for (const text of texts) store.notify(text)
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const card = [...document.querySelectorAll<HTMLElement>('.toast')].find((e) =>
      e.textContent?.includes(texts.at(-1) || '\0'),
    )
    if (!card) return null
    const style = getComputedStyle(card)
    return {
      opacity: Number(style.opacity),
      translateX: new DOMMatrixReadOnly(style.transform).m41,
      duration: style.transitionDuration,
    }
  }, texts)
}

test('notifications enter from the right and retain their last position until exit finishes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openFixtureRepository(page)
  const entering = await notify(page, ['动画核对'])
  expect(entering).not.toBeNull()
  expect(entering!.duration).toBe('0.16s, 0.16s')
  expect(entering!.opacity).toBeLessThan(1)
  expect(entering!.translateX).toBeGreaterThan(0)
  expect(entering!.translateX).toBeLessThanOrEqual(8)
  const card = page.locator('.toast').filter({ hasText: '动画核对' })
  await expect(card).toHaveCSS('opacity', '1')
  const result = await card.evaluate(async (element) => {
    const old = element.getBoundingClientRect()
    ;(element.querySelector('button[aria-label="关闭提示"]') as HTMLButtonElement).click()
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const style = getComputedStyle(element)
    return {
      retained: element.isConnected,
      inert: (element as HTMLElement).inert,
      ariaHidden: element.getAttribute('aria-hidden'),
      leaving: element.classList.contains('notification-leave-active'),
      top: element.getBoundingClientRect().top,
      oldTop: old.top,
      width: element.getBoundingClientRect().width,
      oldWidth: old.width,
      duration: style.transitionDuration,
      pointerEvents: style.pointerEvents,
      stackHeight: element.parentElement!.getBoundingClientRect().height,
    }
  })
  expect(result.retained).toBe(true)
  expect(result.inert).toBe(true)
  expect(result.ariaHidden).toBe('true')
  expect(result.leaving).toBe(true)
  expect(result.duration).toBe('0.12s, 0.12s')
  expect(result.pointerEvents).toBe('none')
  expect(Math.abs(result.top - result.oldTop)).toBeLessThan(1)
  expect(result.width).toBe(result.oldWidth)
  expect(result.stackHeight).toBeGreaterThan(0)
  await expect(card).toHaveCount(0)
  await expect(page.locator('.toast-stack')).toHaveCSS('min-height', '0px')
})

test('newest results stay first and existing cards move into a dismissed slot', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openFixtureRepository(page)
  await notify(page, ['较早通知', '最新通知'])
  const older = page.locator('.toast').filter({ hasText: '较早通知' })
  await expect(older).toHaveCSS('opacity', '1')
  await expect(page.locator('.toast').first()).toContainText('最新通知')
  const oldTop = (await older.boundingBox())!.y
  await page
    .locator('.toast')
    .filter({ hasText: '最新通知' })
    .getByRole('button', { name: '关闭提示' })
    .click()
  await expect(page.locator('.toast')).toHaveCount(1)
  await expect.poll(async () => (await older.boundingBox())!.y).toBeLessThan(oldTop - 20)
  const stackTop = (await page.locator('.toast-stack').boundingBox())!.y
  await expect.poll(async () => Math.abs((await older.boundingBox())!.y - stackTop)).toBeLessThan(1)
})

test('reduced motion disables notification transitions and operation movement', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixtureRepository(page)
  await notify(page, ['减少动态效果'])
  const card = page.locator('.toast').filter({ hasText: '减少动态效果' })
  await expect(card).toBeVisible()
  const style = await card.evaluate((element) => {
    const sample = element.cloneNode(true) as HTMLElement
    sample.classList.add(
      'notification-enter-active',
      'notification-enter-from',
      'notification-move',
    )
    element.parentElement!.append(sample)
    const computed = getComputedStyle(sample)
    const result = {
      duration: computed.transitionDuration,
      transform: computed.transform,
      animation: computed.animationName,
    }
    sample.remove()
    return result
  })
  expect(style).toEqual({ duration: '0s', transform: 'none', animation: 'none' })
  await card.getByRole('button', { name: '关闭提示' }).click()
  await expect(card).toHaveCount(0)
})

test('a completed fetch replaces the progress position with its newest result', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openFixtureRepository(page)
  await notify(page, [])
  await expect(page.locator('.toast')).toHaveCount(0)
  await page.evaluate(() => {
    window.gitk!.syncPlan = async () => ({ id: 'motion-fetch' }) as SyncPlan
    window.gitk!.activity = async () => ({
      id: 'motion-fetch',
      operation: 'fetch',
      repo: '/test-fixtures/repository',
      phase: '接收对象',
      percent: 50,
      state: 'running',
    })
    window.gitk!.action = async () => {
      await new Promise<void>((resolve) => {
        ;(window as unknown as { finishMotionFetch: () => void }).finishMotionFetch = resolve
      })
      return {
        outcome: 'succeeded',
        output: '',
        snapshot: await window.gitk!.snapshot('/test-fixtures/repository'),
      }
    }
  })
  await page.locator('.toolbar-actions').getByRole('button', { name: '获取', exact: true }).click()
  const task = page.getByRole('status', { name: 'Git 操作进度', exact: true })
  await expect(task).toContainText('接收对象')
  await expect(task).toHaveCSS('opacity', '1')
  const top = (await task.boundingBox())!.y
  const frames = await page.evaluate(async () => {
    ;(window as unknown as { finishMotionFetch: () => void }).finishMotionFetch()
    const frames: { top: number; opacity: number }[] = []
    for (let i = 0; i < 18; i++) {
      await new Promise(requestAnimationFrame)
      const toast = [...document.querySelectorAll<HTMLElement>('.toast')].find((e) =>
        e.textContent?.includes('已获取'),
      )
      if (toast)
        frames.push({
          top: toast.getBoundingClientRect().top,
          opacity: Number(getComputedStyle(toast).opacity),
        })
    }
    return frames
  })
  await expect(task).not.toBeVisible()
  const toast = page.locator('.toast').filter({ hasText: '已获取' })
  await expect(toast).toHaveCSS('opacity', '1')
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames.filter((f) => f.opacity > 0))
    expect(Math.abs(frame.top - top)).toBeLessThan(2)
})
