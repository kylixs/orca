/**
 * PS-1 acceptance journey: same file runs injected into the resident server
 * (POST /tabs/:id/execute {script:"example-journey.mjs"}) and standalone
 * (node example-journey.mjs). Body is identical in both modes.
 */
import { defineJourney, runIfMain } from './journey-runtime.mjs'

const journey = defineJourney({
  name: 'example-journey',
  tags: ['smoke', 'web'],
  async run({ ui, page, log, params }) {
    const role = params.role ?? 'zhangsan'
    await ui.login(role)
    await ui.navigateMenu('workbench')
    await ui.assertText('全部项目')

    const title = await page.title()
    const crumbs = await ui.text('#crumbs')
    const heading = await ui.text('#view-app h1')
    const navItems = await page.locator('.nav-item').allInnerTexts()
    log('workbench title', { title, crumbs, heading })
    await ui.screenshot('example-journey-workbench')
    return {
      role,
      docTitle: title,
      crumbs,
      heading,
      navItems: navItems.map((item) => item.trim())
    }
  }
})

await runIfMain(import.meta.url, journey)
export default journey
