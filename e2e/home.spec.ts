import { expect, test } from '@playwright/test'

// Context smoke: a fresh browser context loads the world shell.
test('home page loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Atrium' })).toBeVisible()
})
