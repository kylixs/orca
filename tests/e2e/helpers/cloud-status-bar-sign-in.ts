import { expect, type Page } from '@stablyai/playwright-test'

/**
 * W11 sign-in flow: the native shell keeps the cloud entry as an in-flow status
 * bar segment; clicking it opens the sign-in dialog (address prefilled from the
 * login context) and the segment flips to the account + sign-out row on success.
 * Specs driving a real platform sign-in (golden journey A2, first-paint M107-1)
 * share this driver so the user path stays one implementation.
 */

const LOGIN_SEGMENT = '[data-status-bar] [data-cloud-login-entry]'
const DIALOG = '[data-slot="dialog-content"]'
const DIALOG_SUBMIT = `${DIALOG} button[type="submit"]`

async function clickLoginSegment(page: Page, timeoutMs: number): Promise<void> {
  const segment = page.locator(LOGIN_SEGMENT)
  await expect(segment, 'the status bar must expose the cloud sign-in segment').toBeVisible({
    timeout: timeoutMs
  })
  await segment.click()
}

/**
 * Opens the dialog through the status bar segment and returns the platform
 * address it shows, so a spec can assert the prefill from the runtime env.
 */
export async function openCloudLoginDialog(page: Page, timeoutMs = 60_000): Promise<string> {
  await clickLoginSegment(page, timeoutMs)
  const username = page.locator(`${DIALOG} #cloud-username`)
  await expect(username, 'the segment must open the sign-in dialog').toBeVisible({
    timeout: 15_000
  })
  return page.inputValue('#cloud-platform-address')
}

/**
 * Fills the account fields and resolves once the form is submittable. The shell
 * can remount the dialog while the session restore settles, so a vanished or
 * emptied form is reopened and refilled instead of failing the run.
 */
export async function fillCloudLoginDialog(
  page: Page,
  credentials: { username: string; password: string }
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const dialog = page.locator(DIALOG)
    if (
      !(await dialog
        .locator('#cloud-username')
        .isVisible()
        .catch(() => false))
    ) {
      await clickLoginSegment(page, 15_000)
    }
    try {
      await dialog.locator('#cloud-username').fill(credentials.username, { timeout: 5_000 })
      await dialog.locator('#cloud-password').fill(credentials.password, { timeout: 5_000 })
    } catch {
      // The dialog remounted under the cursor; the next attempt refills it.
      continue
    }
    if (
      await dialog
        .locator('button[type="submit"]')
        .isEnabled()
        .catch(() => false)
    ) {
      return
    }
  }
  throw new Error('the cloud sign-in dialog never became submittable')
}

/**
 * Submits and waits for the user-visible sign-in boundary: the segment row now
 * carries the account and the way out, and the sign-in entry is gone.
 */
export async function submitCloudLoginDialog(
  page: Page,
  options: { displayName: string; timeoutMs?: number }
): Promise<void> {
  const { displayName, timeoutMs = 120_000 } = options
  await page.locator(DIALOG_SUBMIT).click()
  const statusBar = page.locator('[data-status-bar]')
  await expect
    .poll(
      async () => {
        // An inline rejection names itself: fail with the copy instead of the timeout.
        const alert = await page
          .locator(`${DIALOG} [role="alert"]`)
          .textContent()
          .catch(() => null)
        if (alert) {
          throw new Error(`sign-in rejected: ${alert.trim()}`)
        }
        const text = await statusBar.innerText().catch(() => '')
        return !text.includes(displayName)
          ? false
          : (await page.locator(LOGIN_SEGMENT).count()) === 0
      },
      {
        timeout: timeoutMs,
        message: `the status bar never flipped to the signed-in segment (${displayName})`
      }
    )
    .toBe(true)
}
