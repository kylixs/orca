/** Human report + machine diff writer. */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { union } from './prototype-diff-core.mjs'

function evidence(value) {
  if (value === null || value === undefined) {return '—'}
  if (typeof value === 'string') {return value}
  const text = JSON.stringify(value)
  return text.length > 180 ? `${text.slice(0, 177)}…` : text
}

export function renderReport(diff) {
  const lines = []
  lines.push('# 原型对照报告（PS-3）')
  lines.push('')
  lines.push(`- 生成时间：${diff.generatedAt}`)
  lines.push(`- 原型：\`${diff.prototypeUrl}\``)
  lines.push(`- 实际：\`${diff.baseUrl}\``)
  lines.push(`- 方法：${diff.method}`)
  lines.push('')
  lines.push('## 6 条可预见差异验收自检')
  lines.push('')
  lines.push('| # | 预期差异 | 检出 |')
  lines.push('| --- | --- | --- |')
  diff.acceptance.checks.forEach((check, index) => {
    lines.push(`| ${index + 1} | ${check.label} | ${check.found ? '✅ 已检出' : '❌ 未检出'} |`)
  })
  lines.push('')
  lines.push(`结论：${diff.acceptance.passed ? '**6/6 全部检出，方法有效**' : '**存在未检出项，方法需复核**'}`)
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push(`- 差异总数：${diff.summary.total}`)
  lines.push(
    `- 按严重度：P0 ${diff.summary.bySeverity.P0 ?? 0} · P1 ${
      diff.summary.bySeverity.P1 ?? 0
    } · P2 ${diff.summary.bySeverity.P2 ?? 0}`
  )
  lines.push(
    `- 按类：布局 ${diff.summary.byClass.layout ?? 0} · 字段 ${diff.summary.byClass.field ?? 0} · 菜单 ${
      diff.summary.byClass.menu ?? 0
    }`
  )
  lines.push(
    `- 按角色：${Object.entries(diff.summary.byRole)
      .map(([role, count]) => `${role} ${count}`)
      .join(' · ')}`
  )
  lines.push('')
  lines.push('## 页面可达性')
  lines.push('')
  for (const role of diff.roles) {
    const surfaces = union(
      Object.keys(role.reachability.prototype ?? {}),
      Object.keys(role.reachability.actual ?? {})
    )
    lines.push(`### ${role.role}`)
    lines.push('')
    lines.push('| 页面 | 原型 | 实际 |')
    lines.push('| --- | --- | --- |')
    for (const surface of surfaces) {
      lines.push(
        `| ${surface} | ${role.reachability.prototype?.[surface] ?? '—'} | ${
          role.reachability.actual?.[surface] ?? '—'
        } |`
      )
    }
    lines.push('')
  }
  lines.push('## 差异明细')
  lines.push('')
  for (const role of diff.roles.map((entry) => entry.role)) {
    const roleFindings = diff.findings.filter((finding) => finding.role === role)
    lines.push(`### ${role}（${roleFindings.length} 条）`)
    lines.push('')
    const surfaces = union(roleFindings.map((finding) => finding.surface)).sort()
    for (const surface of surfaces) {
      const surfaceFindings = roleFindings.filter((finding) => finding.surface === surface)
      lines.push(`#### ${surface}`)
      lines.push('')
      lines.push('| ID | 级别 | 类/型 | 差异 | 原型证据 | 实际证据 | 建议 |')
      lines.push('| --- | --- | --- | --- | --- | --- | --- |')
      for (const finding of surfaceFindings) {
        lines.push(
          `| ${finding.id} | ${finding.severity} | ${finding.class}/${finding.kind} | ${finding.message} | ${evidence(
            finding.prototype
          )} | ${evidence(finding.actual)} | ${finding.suggestion ?? ''} |`
        )
      }
      lines.push('')
    }
  }
  return `${lines.join('\n')}\n`
}

export function writeComparisonEvidence(diff, outDir) {
  mkdirSync(outDir, { recursive: true })
  const diffFile = path.join(outDir, 'diff.json')
  const reportFile = path.join(outDir, 'report.md')
  writeFileSync(diffFile, JSON.stringify(diff, null, 2))
  writeFileSync(reportFile, renderReport(diff))
  return { diffFile, reportFile }
}

