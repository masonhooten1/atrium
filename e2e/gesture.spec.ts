import { expect, test, type Page } from '@playwright/test'
import { TILE_HH, TILE_HW } from '../src/components/world/renderer'

// These tests share the server and the street — with Playwright's default
// workers they would race each other. Serial keeps the whole spec in one
// worker, in order, like the rooms spec.
test.describe.configure({ mode: 'serial' })

// Pages ride fixtures so the contexts close even when a test fails — a
// leaked connection would keep its avatar on the street and pollute every
// later spec with a ghost peer.
const gestureTest = test.extend<{ alpha: Page; bravo: Page }>({
  alpha: async ({ browser }, use) => {
    const ctx = await browser.newContext()
    await use(await ctx.newPage())
    await ctx.close()
  },
  bravo: async ({ browser }, use) => {
    const ctx = await browser.newContext()
    await use(await ctx.newPage())
    await ctx.close()
  },
})

// The grab gesture's acceptance criteria, run against the production build
// with Chromium fake media devices (playwright.config): accept spawns a
// two-seat pod and teleports both avatars inside; decline and 30 s expiry
// leave the street with nothing materialized.

async function joinStreet(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await page.getByTestId('name-input').fill(name)
  await page.getByTestId('enter').click()
  await expect(page.getByTestId(`peer-${name}`)).toBeVisible()
}

// Screen offset of a world-space delta from the camera (which rests on the
// self avatar): the same iso projection the renderer uses.
function screenOffset(dx: number, dy: number): { x: number; y: number } {
  return { x: (dx - dy) * TILE_HW, y: (dx + dy) * TILE_HH }
}

gestureTest('accepting a pod invite spawns a pod and teleports both inside', async ({ alpha, bravo }) => {
  // Avatar names are unique across the suite (presence uses Alpha/Bravo,
  // rooms uses Nova/Orion/Piper): spec files run in parallel workers on one
  // shared street, and duplicate names collide in the roster testids.
  await joinStreet(alpha, 'Juno')
  await joinStreet(bravo, 'Milo')

  // Milo steps a couple of tiles south-east so the teleport is observable
  // and the invite stays inside street range — clear of every door pad,
  // including the boardroom's beside the spawn.
  await bravo.keyboard.down('ArrowDown')
  await bravo.waitForTimeout(1_000)
  await bravo.keyboard.up('ArrowDown')

  // Juno clicks Milo's avatar on the canvas: the roster's server positions
  // give the world delta, the projection gives the screen offset.
  const miloRow = alpha.getByTestId('peer-Milo')
  const junoRow = alpha.getByTestId('peer-Juno')
  const mx = Number(await miloRow.getAttribute('data-x'))
  const my = Number(await miloRow.getAttribute('data-y'))
  const jx = Number(await junoRow.getAttribute('data-x'))
  const jy = Number(await junoRow.getAttribute('data-y'))
  const vp = alpha.viewportSize() ?? { width: 1280, height: 720 }
  const off = screenOffset(mx - jx, my - jy)
  await alpha.getByTestId('world-canvas').click({ position: { x: vp.width / 2 + off.x, y: vp.height / 2 + off.y } })

  await expect(alpha.getByTestId('pod-pending')).toBeVisible()
  await expect(bravo.getByTestId('pod-incoming')).toBeVisible()
  await bravo.getByTestId('pod-accept').click()

  // Both land inside the spawned pod — the same room surface a door opens,
  // with both tiles live.
  await expect(alpha.getByTestId('room-view')).toBeVisible()
  await expect(bravo.getByTestId('room-view')).toBeVisible()
  await expect(alpha.getByTestId('tile-Milo')).toBeVisible()
  await expect(bravo.getByTestId('tile-Juno')).toBeVisible()

  // The pod materializes on the street, full at its two seats.
  const podDoor = alpha.locator('[data-testid^="door-pod-spawn-"]')
  await expect(podDoor).toHaveCount(1)
  await expect(podDoor).toContainText('full 2/2', { ignoreCase: true })

  // The teleport is a server-authoritative presence move: both avatars end
  // at the pod's landing spot.
  await expect
    .poll(
      async () => {
        const px = Number(await miloRow.getAttribute('data-x'))
        const selfX = Number(await junoRow.getAttribute('data-x'))
        return Math.abs(px - selfX)
      },
      { timeout: 5_000 },
    )
    .toBeLessThan(0.05)
})

gestureTest('declining leaves both on the street with nothing spawned', async ({ alpha, bravo }) => {
  await joinStreet(alpha, 'Delta')
  await joinStreet(bravo, 'Echo')

  // The guided walk moved both avatars to the street's west end. The roster
  // shows the server position, but the click picks from the eased render —
  // wait for both to converge before the center click.
  await expect
    .poll(async () => Number(await alpha.getByTestId('peer-Echo').getAttribute('data-x')))
    .toBeLessThan(3)
  await alpha.waitForTimeout(800)

  // Both stand at the onboarding start: a center click hits the peer, not
  // the street.
  const vp = alpha.viewportSize() ?? { width: 1280, height: 720 }
  await alpha.getByTestId('world-canvas').click({ position: { x: vp.width / 2, y: vp.height / 2 } })
  await expect(alpha.getByTestId('pod-pending')).toBeVisible()
  await expect(bravo.getByTestId('pod-incoming')).toBeVisible()

  await bravo.getByTestId('pod-decline').click()

  // The no names itself and spawns nothing: no room view, no pod door.
  await expect(alpha.getByTestId('door-toast')).toContainText('declined')
  await expect(alpha.getByTestId('pod-pending')).toHaveCount(0)
  await expect(bravo.getByTestId('pod-incoming')).toHaveCount(0)
  await expect(alpha.getByTestId('room-view')).toHaveCount(0)
  await expect(bravo.getByTestId('room-view')).toHaveCount(0)
  await expect(alpha.locator('[data-testid^="door-pod-spawn-"]')).toHaveCount(0)
  await expect(bravo.locator('[data-testid^="door-pod-spawn-"]')).toHaveCount(0)
})

gestureTest('an unanswered invite expires after 30 s with nothing spawned', async ({ alpha, bravo }) => {
  test.setTimeout(60_000)
  await joinStreet(alpha, 'Foxtrot')
  await joinStreet(bravo, 'Golf')

  // Same converge-then-click as the decline test: the guided walk moved both
  // avatars west, and the pick runs on the eased render.
  await expect
    .poll(async () => Number(await alpha.getByTestId('peer-Golf').getAttribute('data-x')))
    .toBeLessThan(3)
  await alpha.waitForTimeout(800)

  const vp = alpha.viewportSize() ?? { width: 1280, height: 720 }
  await alpha.getByTestId('world-canvas').click({ position: { x: vp.width / 2, y: vp.height / 2 } })
  // The sender's side confirms the click actually opened an invite before we
  // judge the receiver — otherwise a cold-boot click that misses the peer
  // reads as an expiry bug.
  await expect(alpha.getByTestId('pod-pending')).toBeVisible()
  await expect(bravo.getByTestId('pod-incoming')).toBeVisible()

  // Nobody answers: the invite expires, the prompt resolves itself on both
  // sides, and no pod ever materializes.
  await expect(bravo.getByTestId('pod-incoming')).toHaveCount(0, { timeout: 40_000 })
  await expect(alpha.getByTestId('door-toast')).toContainText('expired')
  await expect(alpha.getByTestId('pod-pending')).toHaveCount(0)
  await expect(alpha.getByTestId('room-view')).toHaveCount(0)
  await expect(bravo.getByTestId('room-view')).toHaveCount(0)
  await expect(alpha.locator('[data-testid^="door-pod-spawn-"]')).toHaveCount(0)
  await expect(bravo.locator('[data-testid^="door-pod-spawn-"]')).toHaveCount(0)
})
