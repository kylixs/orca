/**
 * PS-4 regression-mode example: login → open project → assertion chain.
 * Standalone `node example-regression.mjs` exits 1 on the first broken
 * assertion and prints `error.failedStep`, so it can gate CI. The same body is
 * also injectable into the resident server for a warm re-run.
 */
import { defineJourney, runIfMain } from './journey-runtime.mjs'

const journey = defineJourney({
  name: 'example-regression',
  tags: ['regression', 'web', 'ci'],
  async run({ ui, page, params, log }) {
    const role = params.role ?? 'admin'
    const checks = []

    await ui.login(role)
    checks.push('login')

    await ui.navigateMenu('workbench')
    await ui.assertText('全部项目')
    checks.push('workbench')

    const [table] = await ui.extractTable('#content table')
    if (!table) {
      throw new Error('workbench project table not found')
    }
    for (const column of ['项目', '仓库', '主机', '状态']) {
      if (!table.columns.includes(column)) {
        throw new Error(`project table missing column "${column}"; saw ${table.columns.join(', ')}`)
      }
    }
    if (table.rowCount < 1) {
      throw new Error('project table has no rows')
    }
    checks.push(`table:${table.rowCount}rows`)

    const projectId = await page.locator('[data-detail]').first().getAttribute('data-detail')
    if (!projectId) {
      throw new Error('no project detail button found for admin')
    }
    const detail = await ui.openDetail(projectId)
    for (const label of ['项目名称', '项目状态']) {
      if (!detail.kv.some((row) => row.label === label)) {
        throw new Error(
          `project detail missing "${label}"; saw ${detail.kv.map((row) => row.label).join(', ')}`
        )
      }
    }
    checks.push(`detail:${projectId}`)
    await page.keyboard.press('Escape')

    await ui.navigateMenu('projects')
    await ui.assertText('我的项目')
    checks.push('projects')

    log('regression checks', checks)
    return {
      mode: 'regression',
      role,
      projectId,
      detailTitle: detail.title,
      kv: detail.kv.map((row) => `${row.label}=${row.value}`),
      columns: table.columns,
      rowCount: table.rowCount,
      checks
    }
  }
})

await runIfMain(import.meta.url, journey)
export default journey
