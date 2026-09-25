import { expect, test, type Page } from '@playwright/test'
import { TILE_HH, TILE_HW } from '../src/components/world/renderer'
import { HALL_TARGET, ONBOARDING_KEY } from '../src/lib/onboarding'

// The first-five-minutes acceptance criterion (build spec, Verification):
// from cleared profile state, the first visit styles an avatar, completes the
// guided walk, and sets the completion flag; the second visit skips straight
// into the world. One browser context holds the storage across both visits —
// that continuity IS the returning-visitor behavior under test.

// Screen offset of a world-space delta from the camera (which rests on the
// self avatar): the same iso projection the gesture spec uses.
function screenOffset(dx: number, dy: number): { x: number; y: number } {
  return { x: (dx - dy) * TILE_HW, y: (dx + dy) * TILE_HH }
}

async function selfPos(page: Page): Promise<{ x: number; y: number }> {
  const row = page.getByTestId('peer-Pilot')
  return {
    x: Number(await row.getAttribute('data-x')),
    y: Number(await row.getAttribute('data-y')),
  }
}

test('first visit completes onboarding and sets the flag; second visit skips to the world', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/')

  // A fresh visitor styles the avatar BEFORE the world: the panel is up, no
  // street presence exists yet.
  await expect(page.getByTestId('join-panel')).toBeVisible()
  await page.getByTestId('name-input').fill('Pilot')
  await page.getByTestId('color-4').click()
  await page.getByTestId('hat-crown').click()
  await page.getByTestId('enter').click()
  await expect(page.getByTestId('peer-Pilot')).toBeVisible()

  // The guided walk opens with the arrow-key lesson: hold the key until the
  // hint flips to the click-to-move lesson (the first ring was reached).
  await expect(page.getByTestId('onboarding-hint')).toContainText('arrow keys', { ignoreCase: true })
  await page.keyboard.down('ArrowRight')
  try {
    await expect(page.getByTestId('onboarding-hint')).toContainText('click', { ignoreCase: true, timeout: 15_000 })
  } finally {
    await page.keyboard.up('ArrowRight')
  }

  // The camera eases toward the avatar; let it settle so the click's world
  // math is exact, then click the hall ring — click-to-move, the second lesson.
  await page.waitForTimeout(1_200)
  const at = await selfPos(page)
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  const off = screenOffset(HALL_TARGET.x - at.x, HALL_TARGET.y - at.y)
  await page.getByTestId('world-canvas').click({ position: { x: vp.width / 2 + off.x, y: vp.height / 2 + off.y } })

  // The completion moment is visible and named, and the record lands the
  // moment the hall is reached — before the banner is dismissed.
  await expect(page.getByTestId('onboarding-complete')).toBeVisible()
  await expect(page.getByTestId('onboarding-complete')).toContainText('Pilot')
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), ONBOARDING_KEY))
    .not.toBeNull()

  // Second visit, same storage: straight into the world — no styling step,
  // no walk, no completion banner, presence under the saved profile.
  await page.getByTestId('onboarding-done').click()
  await page.reload()
  await expect(page.getByTestId('join-panel')).toHaveCount(0)
  await expect(page.getByTestId('onboarding-hint')).toHaveCount(0)
  await expect(page.getByTestId('onboarding-complete')).toHaveCount(0)
  await expect(page.getByTestId('peer-Pilot')).toBeVisible()

  await ctx.close()
})
