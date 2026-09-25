import { expect, test } from '@playwright/test'

// The load-bearing acceptance criterion for this slice: two browser contexts
// agree on the same street — each sees the other join, move within 500 ms,
// and disappear on leave.
test('peers see each other move within 500 ms', async ({ browser }) => {
  const alphaCtx = await browser.newContext()
  const bravoCtx = await browser.newContext()
  const alpha = await alphaCtx.newPage()
  const bravo = await bravoCtx.newPage()

  // Both join the street.
  await alpha.goto('/')
  await alpha.getByTestId('name-input').fill('Alpha')
  await alpha.getByTestId('enter').click()
  await expect(alpha.getByTestId('peer-Alpha')).toBeVisible()

  await bravo.goto('/')
  await bravo.getByTestId('name-input').fill('Bravo')
  await bravo.getByTestId('enter').click()
  await expect(bravo.getByTestId('peer-Alpha')).toBeVisible()
  await expect(alpha.getByTestId('peer-Bravo')).toBeVisible()

  // Bravo walks east. Alpha's roster (server positions) must update within
  // 500 ms of the move being sent — the presence sync budget.
  const bravoRow = alpha.getByTestId('peer-Bravo')
  const before = await bravoRow.getAttribute('data-x')
  await bravo.keyboard.down('ArrowRight')
  try {
    await expect
      .poll(async () => bravoRow.getAttribute('data-x'), { timeout: 500, intervals: [25] })
      .not.toBe(before)
  } finally {
    await bravo.keyboard.up('ArrowRight')
  }

  // Leaving frees presence: closing Bravo's context removes them on Alpha.
  await bravoCtx.close()
  await expect(alpha.getByTestId('peer-Bravo')).toHaveCount(0)

  await alphaCtx.close()
})
