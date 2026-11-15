/**
 * PS-4 exploration-mode example: discover → extractText/extractState → findings.
 * Exploration checks are recorded as findings instead of aborting the run; the
 * findings shape follows evidence/m116-exploratory-web/findings.json.
 * Same body runs injected (POST /tabs/:id/execute) and standalone (node file.mjs).
 */
import { defineJourney, runIfMain } from './journey-runtime.mjs'

const journey = defineJourney({
  name: 'example-explore',
  tags: ['explore', 'web', 'ps4'],
  async run({ ui, page, params, log }) {
    const role = params.role ?? 'admin'
    const route = params.page ?? 'workbench'
    const findings = []
    const consoleErrors = []
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(`console: ${message.text()}`)
      }
    })

    const record = ({ severity, area, title, steps, expected, actual, evidence, impact }) => {
      findings.push({
        id: `PS4-EXPLORE-${String(findings.length + 1).padStart(3, '0')}`,
        severity,
        page: area,
        title,
        steps,
        expected,
        actual,
        evidence,
        ...(impact ? { impact } : {})
      })
    }

    const steps = [`login:${role}`, `navigateMenu:${route}`]
    await ui.login(role)
    const crumbs = await ui.navigateMenu(route)
    const area = crumbs || route

    const inventory = await ui.discover()
    const text = await ui.extractText('#content')
    const state = await ui.extractState()
    const tables = await ui.extractTable('#content table')
    steps.push('discover', 'extractText:#content', 'extractState', 'extractTable')

    const actionButtons = inventory.controls.buttons.filter((button) => !button.disabled)
    if (actionButtons.length === 0) {
      record({
        severity: 'P1',
        area,
        title: '页面没有可操作按钮',
        steps: [...steps],
        expected: '页面提供至少一个可点击动作（打开/详情/新建等）',
        actual: `discover() 只看到 ${inventory.controls.buttons.length} 个按钮，且全部 disabled`,
        evidence: { route: inventory.route, buttons: inventory.controls.buttons.length }
      })
    }

    const table = tables[0]
    if (!table) {
      record({
        severity: 'P1',
        area,
        title: '未发现数据表格',
        steps: [...steps],
        expected: '工作台展示项目表格',
        actual: 'extractTable("#content table") 返回空数组',
        evidence: { route: inventory.route, textChars: text.text.length }
      })
    } else {
      if (!table.columns.includes('项目')) {
        record({
          severity: 'P1',
          area,
          title: '项目表缺少「项目」列',
          steps: [...steps],
          expected: '表头包含「项目」',
          actual: `表头为 ${table.columns.join(' / ')}`,
          evidence: { columns: table.columns }
        })
      }
      if (table.rowCount === 0) {
        record({
          severity: 'P1',
          area,
          title: '项目表为空',
          steps: [...steps],
          expected: '至少 1 行可访问项目',
          actual: 'rowCount=0（可能父账号无项目或 reseed 数据未就绪）',
          evidence: { columns: table.columns, rowCount: 0 }
        })
      }
    }

    if (state.stats.length === 0 && state.badges.length === 0) {
      record({
        severity: 'P2',
        area,
        title: '未提取到统计卡或状态徽标',
        steps: [...steps],
        expected: '工作台提供统计卡（.stat）或状态徽标',
        actual: 'extractState() 的 stats 与 badges 均为空',
        evidence: { stateGroups: state.states.map((entry) => entry.group) }
      })
    }

    const stalled = text.sections.filter((section) => section.text.includes('加载中'))
    if (stalled.length > 0) {
      record({
        severity: 'P1',
        area,
        title: '区域停留在「加载中」',
        steps: [...steps],
        expected: '内容加载完成后不再显示「加载中」',
        actual: `${stalled.length} 个区块仍含「加载中」`,
        evidence: { sections: stalled.map((section) => section.label) }
      })
    }

    if (consoleErrors.length > 0) {
      record({
        severity: 'P2',
        area,
        title: '页面产生控制台/运行时错误',
        steps: [...steps],
        expected: '无 console.error / pageerror',
        actual: consoleErrors.slice(0, 3).join(' | '),
        evidence: { count: consoleErrors.length }
      })
    }

    const shot = await ui.screenshot('explore-workbench', { fullPage: true })
    const summary = {
      route: inventory.route,
      controls: {
        buttons: inventory.controls.buttons.length,
        actionableButtons: actionButtons.length,
        inputs: inventory.controls.inputs.length,
        links: inventory.controls.links.length,
        tables: inventory.controls.tables.length,
        tabs: inventory.controls.tabs.length
      },
      textChars: text.text.length,
      textSections: text.sections.map((section) => ({ kind: section.kind, label: section.label })),
      stateGroups: state.states.map((entry) => `${entry.group}:${entry.count}`),
      stats: state.stats.map((entry) => `${entry.label}=${entry.value}`),
      columns: table?.columns ?? [],
      rowCount: table?.rowCount ?? 0,
      consoleErrors: consoleErrors.slice(0, 10),
      screenshot: shot
    }
    log('exploration findings', { total: findings.length, area })

    return {
      kind: 'exploration-findings',
      meta: {
        runAt: new Date().toISOString(),
        role,
        area,
        url: page.url(),
        baseUrl: ui.baseUrl,
        counts: {
          P0: findings.filter((finding) => finding.severity === 'P0').length,
          P1: findings.filter((finding) => finding.severity === 'P1').length,
          P2: findings.filter((finding) => finding.severity === 'P2').length,
          total: findings.length
        }
      },
      findings,
      summary
    }
  }
})

await runIfMain(import.meta.url, journey)
export default journey
