/** Field class: normalized label matching then id/type/required/state/copy. */
import { labelEvidence, matchLabels, normalizeLabel } from './prototype-diff-core.mjs'

function compareFields({ add, role, surface, p, a }) {
  const match = matchLabels(
    p.fields.map((field) => field.label),
    a.fields.map((field) => field.label)
  )
  for (const pair of match.pairs) {
    const prototypeField = p.fields[pair.prototypeIndex]
    const actualField = a.fields[pair.actualIndex]
    if (!prototypeField || !actualField) {continue}
    if (pair.via !== 'exact') {
      add({
        role,
        surface,
        class: 'field',
        kind: 'renamed',
        object: 'field',
        severity: 'P2',
        prototype: { label: prototypeField.label },
        actual: { label: actualField.label },
        message: `字段换名「${prototypeField.label}」→「${actualField.label}」（${
          pair.via === 'alias' ? '别名表' : `Dice ${pair.score}`
        }）`,
        suggestion: '确认文案口径并更新别名字典'
      })
    }
    if (prototypeField.id !== actualField.id) {
      add({
        role,
        surface,
        class: 'field',
        kind: 'selector_drift',
        object: 'field',
        severity: 'P2',
        prototype: { label: prototypeField.label, id: prototypeField.id, name: prototypeField.name },
        actual: { label: actualField.label, id: actualField.id, name: actualField.name },
        message: `字段「${prototypeField.label}」选择器漂移：id ${prototypeField.id ?? '∅'} → ${
          actualField.id ?? '∅'
        }`,
        suggestion: '保留稳定 id 或同步 data-testid，避免自动化选择器漂移'
      })
    }
    if (prototypeField.type !== actualField.type) {
      add({
        role,
        surface,
        class: 'field',
        kind: 'type_drift',
        object: 'field',
        severity: 'P2',
        prototype: { label: prototypeField.label, type: prototypeField.type },
        actual: { label: actualField.label, type: actualField.type },
        message: `字段「${prototypeField.label}」类型变化：${prototypeField.type} → ${actualField.type}`,
        suggestion: '核对输入校验与交互'
      })
    }
    if (prototypeField.required !== actualField.required) {
      add({
        role,
        surface,
        class: 'field',
        kind: 'state_drift',
        object: 'field',
        severity: 'P1',
        prototype: { label: prototypeField.label, required: prototypeField.required },
        actual: { label: actualField.label, required: actualField.required },
        message: `字段「${prototypeField.label}」必填性变化：${prototypeField.required} → ${actualField.required}`,
        suggestion: '确认提交校验口径'
      })
    }
    if (
      prototypeField.disabled !== actualField.disabled ||
      prototypeField.readonly !== actualField.readonly
    ) {
      add({
        role,
        surface,
        class: 'field',
        kind: 'state_drift',
        object: 'field',
        severity: 'P2',
        prototype: {
          label: prototypeField.label,
          disabled: prototypeField.disabled,
          readonly: prototypeField.readonly
        },
        actual: {
          label: actualField.label,
          disabled: actualField.disabled,
          readonly: actualField.readonly
        },
        message: `字段「${prototypeField.label}」禁用/只读状态变化`,
        suggestion: '确认权限态与交互态'
      })
    }
    if (normalizeLabel(prototypeField.placeholder) !== normalizeLabel(actualField.placeholder)) {
      add({
        role,
        surface,
        class: 'field',
        kind: 'copy_drift',
        object: 'field',
        severity: 'P2',
        prototype: { label: prototypeField.label, placeholder: prototypeField.placeholder },
        actual: { label: actualField.label, placeholder: actualField.placeholder },
        message: `字段「${prototypeField.label}」placeholder 文案不同`,
        suggestion: '统一提示文案'
      })
    }
    if ((prototypeField.options ?? []).join('|') !== (actualField.options ?? []).join('|')) {
      add({
        role,
        surface,
        class: 'field',
        kind: 'copy_drift',
        object: 'field-options',
        severity: 'P2',
        prototype: { label: prototypeField.label, options: prototypeField.options ?? [] },
        actual: { label: actualField.label, options: actualField.options ?? [] },
        message: `字段「${prototypeField.label}」下拉选项不同`,
        suggestion: '对齐选项集合与顺序'
      })
    }
  }
  match.missing.forEach((index) =>
    add({
      role,
      surface,
      class: 'field',
      kind: 'missing',
      object: 'field',
      severity: 'P1',
      prototype: { label: labelEvidence(p.fields, index) },
      actual: null,
      message: `字段「${labelEvidence(p.fields, index)}」在实际侧缺失`,
      suggestion: '补齐字段或更新原型'
    })
  )
  match.extra.forEach((index) =>
    add({
      role,
      surface,
      class: 'field',
      kind: 'extra',
      object: 'field',
      severity: 'P1',
      prototype: null,
      actual: { label: labelEvidence(a.fields, index) },
      message: `实际侧新增字段「${labelEvidence(a.fields, index)}」`,
      suggestion: '确认新增字段是否已进入设计'
    })
  )
}

function dedupeActions(actions) {
  const seen = new Set()
  return actions.filter((action) => {
    const key = `${normalizeLabel(action.label)}|${action.role}`
    if (seen.has(key)) {return false}
    seen.add(key)
    return true
  })
}

function compareActions({ add, role, surface, p, a }) {
  const prototypeActions = dedupeActions(p.actions)
  const actualActions = dedupeActions(a.actions)
  const match = matchLabels(
    prototypeActions.map((action) => action.label),
    actualActions.map((action) => action.label)
  )
  for (const pair of match.pairs) {
    const prototypeAction = prototypeActions[pair.prototypeIndex]
    const actualAction = actualActions[pair.actualIndex]
    if (!prototypeAction || !actualAction) {continue}
    if (pair.via !== 'exact') {
      add({
        role,
        surface,
        class: 'menu',
        kind: 'renamed',
        object: 'action',
        severity: 'P2',
        prototype: { label: prototypeAction.label, role: prototypeAction.role },
        actual: { label: actualAction.label, role: actualAction.role },
        message: `动作按钮换名「${prototypeAction.label}」→「${actualAction.label}」`,
        suggestion: '统一动作文案'
      })
    }
    if (prototypeAction.disabled !== actualAction.disabled) {
      add({
        role,
        surface,
        class: 'menu',
        kind: 'state_drift',
        object: 'action',
        severity: 'P2',
        prototype: { label: prototypeAction.label, disabled: prototypeAction.disabled },
        actual: { label: actualAction.label, disabled: actualAction.disabled },
        message: `动作「${prototypeAction.label}」禁用态不同`,
        suggestion: '核对按钮可用条件'
      })
    }
  }
  match.missing.forEach((index) =>
    add({
      role,
      surface,
      class: 'menu',
      kind: 'missing',
      object: 'action',
      severity: 'P1',
      prototype: { label: labelEvidence(prototypeActions, index) },
      actual: null,
      message: `动作「${labelEvidence(prototypeActions, index)}」在实际侧缺失`,
      suggestion: '补齐动作入口或更新原型'
    })
  )
  match.extra.forEach((index) =>
    add({
      role,
      surface,
      class: 'menu',
      kind: 'extra',
      object: 'action',
      severity: 'P1',
      prototype: null,
      actual: { label: labelEvidence(actualActions, index) },
      message: `实际侧新增动作「${labelEvidence(actualActions, index)}」`,
      suggestion: '确认新增动作是否已进入设计'
    })
  )
}


export { compareFields, compareActions }
