import { expect, test, type Page } from '@playwright/test'

// These tests share names, the server, and the pod they join — with Playwright's
// default workers they would race each other on the same street. Serial keeps
// the whole spec in one worker, in order.
test.describe.configure({ mode: 'serial' })

// The load-bearing acceptance criteria for the meeting continuum, run against
// the production build with Chromium fake media devices (playwright.config):
// two peers join a pod and both render live camera tiles; a third is refused
// with reason:full; leaving frees the seat.

async function joinStreet(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await page.getByTestId('name-input').fill(name)
  await page.getByTestId('enter').click()
  await expect(page.getByTestId(`peer-${name}`)).toBeVisible()
}

async function videoWidth(page: Page, tile: string): Promise<number> {
  return page
    .locator(`[data-testid="${tile}"] video`)
    .evaluate((el) => (el as HTMLVideoElement).videoWidth)
}

test('two peers join a pod and both render live tiles', async ({ browser }) => {
  const alphaCtx = await browser.newContext()
  const bravoCtx = await browser.newContext()
  const alpha = await alphaCtx.newPage()
  const bravo = await bravoCtx.newPage()
  const meshConsole: string[] = []
  alpha.on('console', (m) => { if (m.text().includes('[mesh]')) meshConsole.push(`alpha: ${m.text()}`) })
  bravo.on('console', (m) => { if (m.text().includes('[mesh]')) meshConsole.push(`bravo: ${m.text()}`) })
  await joinStreet(alpha, 'Nova')
  await joinStreet(bravo, 'Orion')

  await alpha.getByTestId('door-pod-north').click()
  await expect(alpha.getByTestId('room-view')).toBeVisible()
  await expect(alpha.getByTestId('tile-self')).toBeVisible()

  await bravo.getByTestId('door-pod-north').click()
  await expect(bravo.getByTestId('room-view')).toBeVisible()

  // Both grids show both people once membership syncs.
  await expect(alpha.getByTestId('tile-Orion')).toBeVisible()
  await expect(bravo.getByTestId('tile-Nova')).toBeVisible()

  // Fake media really flows through the mesh: frames with real dimensions.
  await expect.poll(async () => videoWidth(alpha, 'tile-self'), { timeout: 10_000 }).toBeGreaterThan(0)
  await expect.poll(async () => videoWidth(bravo, 'tile-self'), { timeout: 10_000 }).toBeGreaterThan(0)
  await expect.poll(async () => videoWidth(alpha, 'tile-Orion'), { timeout: 10_000 }).toBeGreaterThan(0)
  await expect.poll(async () => videoWidth(bravo, 'tile-Nova'), { timeout: 10_000 }).toBeGreaterThan(0)

  await alphaCtx.close()
  await bravoCtx.close()
})

test('a third peer is refused a full pod with a toast', async ({ browser }) => {
  const ctxs = [await browser.newContext(), await browser.newContext(), await browser.newContext()]
  const [alpha, bravo, charlie] = await Promise.all(ctxs.map((c) => c.newPage()))
  await joinStreet(alpha, 'Nova')
  await joinStreet(bravo, 'Orion')
  await joinStreet(charlie, 'Piper')

  await alpha.getByTestId('door-pod-north').click()
  await expect(alpha.getByTestId('room-view')).toBeVisible()
  await bravo.getByTestId('door-pod-north').click()
  await expect(bravo.getByTestId('room-view')).toBeVisible()

  // The door flips to full for everyone still on the street.
  await expect(charlie.getByTestId('door-pod-north')).toContainText('full 2/2', { ignoreCase: true })

  await charlie.getByTestId('door-pod-north').click()
  await expect(charlie.getByTestId('door-toast')).toContainText('full')
  await expect(charlie.getByTestId('room-view')).toHaveCount(0)

  for (const c of ctxs) await c.close()
})

test('leaving frees the seat for the next person', async ({ browser }) => {
  const ctxs = [await browser.newContext(), await browser.newContext(), await browser.newContext()]
  const [alpha, bravo, charlie] = await Promise.all(ctxs.map((c) => c.newPage()))
  await joinStreet(alpha, 'Nova')
  await joinStreet(bravo, 'Orion')
  await joinStreet(charlie, 'Piper')

  await alpha.getByTestId('door-pod-north').click()
  await expect(alpha.getByTestId('room-view')).toBeVisible()
  await bravo.getByTestId('door-pod-north').click()
  await expect(bravo.getByTestId('room-view')).toBeVisible()
  await charlie.getByTestId('door-pod-north').click()
  await expect(charlie.getByTestId('door-toast')).toContainText('full')

  // Alpha leaves: the seat frees immediately and the door reads open 1/2.
  await alpha.getByTestId('leave-room').click()
  await expect(alpha.getByTestId('room-view')).toHaveCount(0)
  await expect(charlie.getByTestId('door-pod-north')).toContainText('open 1/2', { ignoreCase: true })

  // Charlie can now take the freed seat.
  await charlie.getByTestId('door-pod-north').click()
  await expect(charlie.getByTestId('room-view')).toBeVisible()
  await expect(charlie.getByTestId('tile-Orion')).toBeVisible()

  for (const c of ctxs) await c.close()
})
