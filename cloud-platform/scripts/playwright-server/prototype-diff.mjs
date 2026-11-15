/**
 * Three-class prototype diff orchestration. Layout/field/menu comparators live
 * in sibling modules; this file owns the finding ledger and acceptance check.
 * Re-exports the shared primitives and the report writer for one import point.
 */
import { union } from './prototype-diff-core.mjs'
import { compareLayoutSurface } from './prototype-diff-layout.mjs'
import { compareActions, compareFields } from './prototype-diff-fields.mjs'
import { compareNavTitles, compareOverlays } from './prototype-diff-menus.mjs'

export {
  ALIAS_PAIRS,
  aliasMatch,
  compareOrdered,
  diceSimilarity,
  lcsPairs,
  matchLabels,
  normalizeLabel
} from './prototype-diff-core.mjs'
export { renderReport, writeComparisonEvidence } from './prototype-report.mjs'

export function diffInventories(collection) {
  const findings = []
  const add = (finding) => findings.push({ id: `F${findings.length + 1}`, ...finding })

  for (const entry of collection.roles) {
    const role = entry.role
    const prototype = entry.prototype
    const actual = entry.actual
    const surfaces = union(
      Object.keys(prototype.surfaces),
      Object.keys(actual.surfaces),
      Object.keys(prototype.reachability),
      Object.keys(actual.reachability)
    )

    for (const surface of surfaces) {
      const protoReach = prototype.reachability[surface]
      const actualReach = actual.reachability[surface]
      if (protoReach === 'reached' && actualReach !== 'reached') {
        add({
          role,
          surface,
          class: 'layout',
          kind: 'missing',
          object: 'page',
          severity: 'P0',
          prototype: { reachability: protoReach },
          actual: { reachability: actualReach },
          message:
            actualReach === 'forbidden'
              ? `原型可达页面「${surface}」在实际侧被拒绝`
              : `原型可达页面「${surface}」在实际侧缺失`,
          suggestion: '补齐路由与渲染器，或确认该页面已从产品范围移除'
        })
      } else if (protoReach === 'forbidden' && actualReach === 'reached') {
        add({
          role,
          surface,
          class: 'layout',
          kind: 'state_drift',
          object: 'page',
          severity: 'P2',
          prototype: { reachability: protoReach },
          actual: { reachability: actualReach },
          message: `角色门禁不一致：原型「${surface}」被拒绝，实际可达`,
          suggestion: '核对平台管理员权限判定'
        })
      }
      if (protoReach !== 'reached' || actualReach !== 'reached') {continue}
      const prototypeInventory = prototype.surfaces[surface]
      const actualInventory = actual.surfaces[surface]
      if (!prototypeInventory || !actualInventory) {continue}
      compareLayoutSurface({
        add,
        role,
        surface,
        prototypeInventory,
        actualInventory
      })
      compareFields({ add, role, surface, p: prototypeInventory, a: actualInventory })
      compareActions({ add, role, surface, p: prototypeInventory, a: actualInventory })
    }

    compareNavTitles({ add, role, prototype, actual })
    compareOverlays({ add, role, prototype, actual })
  }

  return {
    generatedAt: collection.generatedAt ?? new Date().toISOString(),
    prototypeUrl: collection.prototypeUrl,
    baseUrl: collection.baseUrl,
    method:
      'same DOM inventory for both sides; layout=LCS, fields=normalized label + alias + Dice, menus=label+role',
    roles: collection.roles.map((entry) => ({
      role: entry.role,
      account: entry.account,
      reachability: {
        prototype: entry.prototype.reachability,
        actual: entry.actual.reachability
      }
    })),
    findings,
    summary: summarize(findings),
    acceptance: verifyKnownDifferences(findings)
  }
}


function summarize(findings) {
  const bySeverity = { P0: 0, P1: 0, P2: 0 }
  const byClass = { layout: 0, field: 0, menu: 0 }
  const byRole = {}
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1
    byClass[finding.class] = (byClass[finding.class] ?? 0) + 1
    byRole[finding.role] = (byRole[finding.role] ?? 0) + 1
  }
  return { total: findings.length, bySeverity, byClass, byRole }
}

/** The six §4.5 predictable differences must all be detectable. */
export function verifyKnownDifferences(findings) {
  const checks = [
    {
      id: 'nav-rename',
      label: '侧栏/页标题：项目授权/下载策略 → 成员与权限/平台设置',
      found: findings.some(
        (finding) =>
          finding.class === 'menu' &&
          finding.object === 'nav-title' &&
          ((/项目授权/.test(finding.prototype?.title ?? '') &&
            /成员与权限/.test(finding.actual?.title ?? '')) ||
            (/下载策略/.test(finding.prototype?.title ?? '') &&
              /平台设置/.test(finding.actual?.title ?? '')))
      )
    },
    {
      id: 'workbench-stats',
      label: '工作台统计卡换名',
      found: findings.some(
        (finding) =>
          finding.surface === 'workbench' &&
          finding.object === 'stat' &&
          (finding.kind === 'renamed' || finding.kind === 'missing') &&
          /进行中项目|今日会话|可用主机|待审批下载/.test(finding.prototype?.label ?? '')
      )
    },
    {
      id: 'recent-column',
      label: '工作台「全部项目」缺「最近使用」列',
      found: findings.some(
        (finding) =>
          finding.class === 'layout' &&
          finding.object === 'table-column' &&
          finding.kind === 'missing' &&
          /最近使用/.test(finding.prototype?.column ?? '')
      )
    },
    {
      id: 'diagnostics-route',
      label: '实际无 diagnostics 路由',
      found: findings.some(
        (finding) =>
          finding.class === 'layout' &&
          finding.object === 'page' &&
          finding.surface === 'diagnostics' &&
          finding.kind === 'missing'
      )
    },
    {
      id: 'p3-overlay',
      label: 'P3 由完整路由变为 overlay + iframe',
      found: findings.some(
        (finding) =>
          finding.object === 'workspace' &&
          finding.kind === 'layout_drift' &&
          /overlay/.test(finding.message) &&
          /iframe/.test(finding.message)
      )
    },
    {
      id: 'login-selector',
      label: '登录输入 id 漂移（loginAccount/loginPassword → username/password）',
      found: findings.some(
        (finding) =>
          finding.surface === 'login' &&
          finding.kind === 'selector_drift' &&
          /loginAccount|loginPassword/.test(finding.prototype?.id ?? '') &&
          /username|password/.test(finding.actual?.id ?? '')
      )
    }
  ]
  return { checks, passed: checks.every((check) => check.found) }
}

/* ---------------- report ---------------- */

