import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { extractDomInventory } from './prototype-inventory.mjs'
import {
  diffInventories,
  diceSimilarity,
  lcsPairs,
  matchLabels,
  normalizeLabel
} from './prototype-diff.mjs'

const FIXTURE = `<!doctype html><html lang="zh-CN"><body>
  <aside class="sidebar"><nav class="side-nav">
    <button class="nav-item" data-route="workbench"><span>工作台</span></button>
    <button class="nav-item admin-only" data-route="hosts"><span>主机</span></button>
  </nav></aside>
  <main id="content">
    <h1>工作台</h1>
    <div class="stat-card"><span class="stat-label">进行中项目</span><div class="stat-value">3</div></div>
    <div class="card"><h2>全部项目</h2>
      <table aria-label="全部项目">
        <thead><tr><th>项目</th><th>最近使用</th></tr></thead>
        <tbody><tr><td>payment</td><td>1 小时前</td></tr></tbody>
      </table>
    </div>
    <label for="loginAccount">域账号</label><input id="loginAccount" name="username">
    <button>打开</button>
  </main>
  <div class="modal-layer" hidden>
    <div class="modal" role="dialog" aria-labelledby="newProjectTitle">
      <h2 id="newProjectTitle">新建项目</h2>
      <input aria-label="项目名"><button>创建</button>
    </div>
  </div>
  <aside class="drawer" role="dialog" aria-labelledby="hostDrawerTitle">
    <h2 id="hostDrawerTitle">主机详情</h2>
  </aside>
  <div class="context-menu" id="fileMenu" role="menu" aria-label="文件操作" hidden>
    <button class="menu-item">下载</button>
  </div>
  <iframe title="工作区" src="https://example.test/cloud-admin.html"></iframe>
</body></html>`

test('DOM inventory schema: nav/sections/stats/tables/fields/actions/overlays/frames', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(FIXTURE)
    const inventory = await extractDomInventory(page, { surface: 'workbench' })

    assert.equal(inventory.surface, 'workbench')
    assert.equal(inventory.title, '工作台')
    assert.deepEqual(
      inventory.nav.map((item) => item.label),
      ['工作台', '主机']
    )
    assert.deepEqual(
      inventory.sections.map((section) => section.label),
      ['全部项目']
    )
    assert.equal(inventory.stats[0].label, '进行中项目')
    assert.equal(inventory.stats[0].valueShape, 'number')
    assert.equal(inventory.tables[0].name, '全部项目')
    assert.deepEqual(inventory.tables[0].columns, ['项目', '最近使用'])
    assert.equal(inventory.fields[0].label, '域账号')
    assert.equal(inventory.fields[0].id, 'loginAccount')
    assert.ok(inventory.actions.some((action) => action.label === '打开'))
    assert.ok(inventory.dialogs.some((dialog) => dialog.name === '新建项目'))
    assert.ok(inventory.drawers.some((drawer) => drawer.name === '主机详情'))
    assert.ok(inventory.menus.some((menu) => menu.name === '文件操作'))
    assert.ok(inventory.frames.some((frame) => frame.src.includes('cloud-admin.html')))
    assert.ok(inventory.tokens.length >= 1)
  } finally {
    await browser.close()
  }
})

test('normalization helpers: optional marks, aliases and LCS', () => {
  assert.equal(normalizeLabel('  主机管理 · 只读（二期） '), '主机管理')
  assert.ok(diceSimilarity('下载策略', '下载策略配置') >= 0.75)
  assert.equal(matchLabels(['主机管理'], ['主机']).pairs[0].via, 'alias')
  assert.deepEqual(
    lcsPairs(['工作台', '项目', '主机'], ['工作台', '主机']).map((pair) => pair.prototypeIndex),
    [0, 2]
  )
})

function blankSurface(overrides = {}) {
  return {
    surface: 'workbench',
    title: '',
    breadcrumb: '',
    nav: [],
    sections: [],
    stats: [],
    tables: [],
    fields: [],
    actions: [],
    menus: [],
    dialogs: [],
    drawers: [],
    frames: [],
    tokens: [],
    ...overrides
  }
}

function makeCollection({ prototypeSurfaces, actualSurfaces, prototypeReach = {}, actualReach = {} }) {
  return {
    generatedAt: '2026-11-15T00:00:00.000Z',
    prototypeUrl: 'file:///prototype.html',
    baseUrl: 'https://127.0.0.1:18787',
    roles: [
      {
        role: 'admin',
        account: 'admin',
        prototype: {
          side: 'prototype',
          role: 'admin',
          reachability: prototypeReach,
          surfaces: prototypeSurfaces
        },
        actual: {
          side: 'actual',
          role: 'admin',
          reachability: actualReach,
          surfaces: actualSurfaces
        }
      }
    ]
  }
}

test('diff class layout: missing table column is P1', () => {
  const prototypeTable = {
    name: '全部项目',
    columns: ['项目', '仓库', '最近使用', '状态'],
    rowCount: 1,
    sampleRow: []
  }
  const actualTable = {
    name: '全部项目',
    columns: ['项目', '仓库', '状态'],
    rowCount: 1,
    sampleRow: []
  }
  const diff = diffInventories(
    makeCollection({
      prototypeSurfaces: {
        workbench: blankSurface({ tables: [prototypeTable] })
      },
      actualSurfaces: {
        workbench: blankSurface({ tables: [actualTable] })
      },
      prototypeReach: { workbench: 'reached' },
      actualReach: { workbench: 'reached' }
    })
  )
  const missing = diff.findings.find(
    (finding) =>
      finding.class === 'layout' &&
      finding.object === 'table-column' &&
      finding.kind === 'missing' &&
      finding.prototype.column === '最近使用'
  )
  assert.ok(missing)
  assert.equal(missing.severity, 'P1')
})

test('diff class field: alias rename + selector and required drift', () => {
  const prototype = blankSurface({
    surface: 'login',
    fields: [
      { label: '主机管理', id: 'hostMgmt', name: 'host', type: 'text', required: false, disabled: false, readonly: false, placeholder: null },
      { label: '域账号', id: 'loginAccount', name: 'username', type: 'text', required: false, disabled: false, readonly: false, placeholder: '域账号' }
    ]
  })
  const actual = blankSurface({
    surface: 'login',
    fields: [
      { label: '主机', id: 'host', name: 'host', type: 'text', required: false, disabled: false, readonly: false, placeholder: null },
      { label: '域账号', id: 'username', name: 'username', type: 'text', required: true, disabled: false, readonly: false, placeholder: '域账号' }
    ]
  })
  const diff = diffInventories(
    makeCollection({
      prototypeSurfaces: { login: prototype },
      actualSurfaces: { login: actual },
      prototypeReach: { login: 'reached' },
      actualReach: { login: 'reached' }
    })
  )
  assert.ok(
    diff.findings.some((finding) => finding.class === 'field' && finding.kind === 'renamed')
  )
  assert.ok(
    diff.findings.some(
      (finding) =>
        finding.class === 'field' &&
        finding.kind === 'selector_drift' &&
        finding.prototype.id === 'loginAccount'
    )
  )
  assert.ok(
    diff.findings.some(
      (finding) =>
        finding.class === 'field' &&
        finding.kind === 'state_drift' &&
        finding.severity === 'P1' &&
        finding.prototype.required === false &&
        finding.actual.required === true
    )
  )
})

test('diff class menu: missing action is P1', () => {
  const prototype = blankSurface({
    surface: 'projects',
    actions: [
      { label: '打开', role: 'button', disabled: false, title: null },
      { label: '详情', role: 'button', disabled: false, title: null }
    ]
  })
  const actual = blankSurface({
    surface: 'projects',
    actions: [{ label: '打开', role: 'button', disabled: false, title: null }]
  })
  const diff = diffInventories(
    makeCollection({
      prototypeSurfaces: { projects: prototype },
      actualSurfaces: { projects: actual },
      prototypeReach: { projects: 'reached' },
      actualReach: { projects: 'reached' }
    })
  )
  const missing = diff.findings.find(
    (finding) =>
      finding.class === 'menu' &&
      finding.object === 'action' &&
      finding.kind === 'missing' &&
      finding.prototype.label === '详情'
  )
  assert.ok(missing)
  assert.equal(missing.severity, 'P1')
})
