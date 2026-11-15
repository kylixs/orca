/**
 * PS-2 acceptance journey: extraction-first loop on the workbench.
 * extractText/extractState → assertions → openDetail → extractTable, plus
 * discover/extractLayout inventory. Same body runs injected and standalone.
 */
import { defineJourney, runIfMain } from './journey-runtime.mjs'

const journey = defineJourney({
  name: 'extension-demo',
  tags: ['smoke', 'web', 'ps2'],
  async run({ ui, page, log, params }) {
    const role = params.role ?? 'admin'
    await ui.login(role)
    await ui.navigateMenu('workbench')

    const workbench = await ui.extractText('#content')
    const state = await ui.extractState()
    await ui.assertText('全部项目')
    await ui.assertText('全部项目', '#content')

    const tableBefore = await ui.extractTable('#content table')
    if (!tableBefore.length || tableBefore[0].rowCount < 1) {
      throw new Error('workbench project table is missing rows')
    }

    const projectId = await page.locator('[data-open]').first().getAttribute('data-open')
    let detail = null
    if (role === 'admin' && projectId) {
      detail = await ui.openDetail(projectId)
      if (!detail.kv.some((row) => row.label === '项目名称')) {
        throw new Error('project detail dialog did not expose 项目名称 in its kv list')
      }
    }

    const tableAfter = await ui.extractTable('#content table')
    if (tableAfter[0].columns.length < 5) {
      throw new Error(`expected >=5 project columns, saw ${tableAfter[0].columns.length}`)
    }

    await page.keyboard.press('Escape')
    const layout = await ui.extractLayout()
    const inventory = await ui.discover()
    if (!inventory.controls.tables.length || !inventory.controls.buttons.length) {
      throw new Error('discover() did not inventory tables/buttons')
    }
    await ui.screenshot('extension-demo-workbench')

    const summary = {
      role,
      crumbs: layout.route,
      textChars: workbench.text.length,
      sections: workbench.sections.length,
      stateGroups: state.states.map((entry) => entry.group),
      stateStats: state.stats.map((entry) => `${entry.label}=${entry.value}`),
      columns: tableBefore[0].columns,
      rowCount: tableBefore[0].rowCount,
      detailTitle: detail?.title ?? null,
      detailKvLabels: detail?.kv.map((row) => row.label) ?? [],
      navItems: layout.nav.map((item) => item.label),
      buttons: inventory.controls.buttons.length,
      inputs: inventory.controls.inputs.length,
      inventoryTables: inventory.controls.tables.length
    }
    log('extension demo summary', summary)
    return summary
  }
})

await runIfMain(import.meta.url, journey)
export default journey
