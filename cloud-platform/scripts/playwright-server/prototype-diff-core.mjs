/** Shared normalizers, alias table, Dice and ordered-list comparators. */
export const ALIAS_PAIRS = [
  ['项目授权', '成员与权限'],
  ['下载策略', '平台设置'],
  ['主机管理', '主机'],
  ['项目列表', '全部项目'],
  ['查看全部', '查看全部项目'],
  ['全部项目', '项目列表']
]

const ALIAS_MAP = new Map()
for (const [left, right] of ALIAS_PAIRS) {
  const a = normalizeLabel(left)
  const b = normalizeLabel(right)
  if (!ALIAS_MAP.has(a)) {ALIAS_MAP.set(a, new Set())}
  if (!ALIAS_MAP.has(b)) {ALIAS_MAP.set(b, new Set())}
  ALIAS_MAP.get(a).add(b)
  ALIAS_MAP.get(b).add(a)
}

/** NFC, collapse whitespace, strip optional-state marks ("· 只读", "（二期）"). */
export function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/ /g, ' ')
    .replace(/[·•]\s*只读/g, '')
    .replace(/[（(]\s*二期\s*[)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function aliasMatch(left, right) {
  const a = normalizeLabel(left)
  const b = normalizeLabel(right)
  return a === b || Boolean(ALIAS_MAP.get(a)?.has(b))
}

function bigrams(value) {
  const counts = new Map()
  for (let i = 0; i < value.length - 1; i += 1) {
    const gram = value.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

/** Sørensen–Dice coefficient over character bigrams (CJK-safe). */
export function diceSimilarity(left, right) {
  const a = normalizeLabel(left)
  const b = normalizeLabel(right)
  if (a === b) {return a ? 1 : 0}
  if (a.length < 2 || b.length < 2) {return 0}
  const leftGrams = bigrams(a)
  const rightGrams = bigrams(b)
  let overlap = 0
  for (const [gram, count] of leftGrams) {
    overlap += Math.min(count, rightGrams.get(gram) ?? 0)
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1))
}

/** Greedy exact -> alias -> Dice (>=0.75) matching; never silently drops a label. */
export function matchLabels(prototypeLabels, actualLabels, options = {}) {
  const threshold = options.threshold ?? 0.75
  const prototype = prototypeLabels.map(normalizeLabel)
  const actual = actualLabels.map(normalizeLabel)
  const usedActual = new Set()
  const pairs = []
  const claim = (index) => {
    usedActual.add(index)
    return index
  }

  prototype.forEach((label, prototypeIndex) => {
    const exact = actual.findIndex((candidate, index) => !usedActual.has(index) && candidate === label)
    if (exact !== -1) {
      pairs.push({ prototypeIndex, actualIndex: claim(exact), via: 'exact', score: 1 })
    }
  })
  prototype.forEach((label, prototypeIndex) => {
    if (pairs.some((pair) => pair.prototypeIndex === prototypeIndex)) {return}
    const alias = actual.findIndex(
      (candidate, index) => !usedActual.has(index) && aliasMatch(label, candidate)
    )
    if (alias !== -1) {
      pairs.push({ prototypeIndex, actualIndex: claim(alias), via: 'alias', score: 1 })
    }
  })
  prototype.forEach((label, prototypeIndex) => {
    if (pairs.some((pair) => pair.prototypeIndex === prototypeIndex)) {return}
    let best = { index: -1, score: 0 }
    actual.forEach((candidate, index) => {
      if (usedActual.has(index)) {return}
      const score = diceSimilarity(label, candidate)
      if (score > best.score) {best = { index, score }}
    })
    if (best.index >= 0 && best.score >= threshold) {
      pairs.push({
        prototypeIndex,
        actualIndex: claim(best.index),
        via: 'similarity',
        score: Number(best.score.toFixed(3))
      })
    }
  })

  const missing = prototype
    .map((_, index) => index)
    .filter((index) => !pairs.some((pair) => pair.prototypeIndex === index))
  const extra = actual.map((_, index) => index).filter((index) => !usedActual.has(index))
  pairs.sort((left, right) => left.prototypeIndex - right.prototypeIndex)
  return { pairs, missing, extra }
}

/** Longest common subsequence over ordered labels; returns index pairs. */
export function lcsPairs(left, right) {
  const a = left.map(normalizeLabel)
  const b = right.map(normalizeLabel)
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0)
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push({ prototypeIndex: i, actualIndex: j })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

/** Ordered comparison: missing/extra from LCS, reorder from out-of-order exact pairs. */
export function compareOrdered(prototypeLabels, actualLabels) {
  const prototype = prototypeLabels.map(normalizeLabel)
  const actual = actualLabels.map(normalizeLabel)
  const lcs = lcsPairs(prototype, actual)
  const matchedPrototype = new Set(lcs.map((pair) => pair.prototypeIndex))
  const matchedActual = new Set(lcs.map((pair) => pair.actualIndex))
  const missing = prototype.map((_, index) => index).filter((index) => !matchedPrototype.has(index))
  const extra = actual.map((_, index) => index).filter((index) => !matchedActual.has(index))

  const exactPairs = []
  const used = new Set()
  prototype.forEach((label, prototypeIndex) => {
    const found = actual.findIndex((candidate, index) => !used.has(index) && candidate === label)
    if (found !== -1) {
      used.add(found)
      exactPairs.push({ prototypeIndex, actualIndex: found })
    }
  })
  const reordered = exactPairs.length > lcs.length
  return { lcs, missing, extra, reordered }
}

/* ---------------- diff ---------------- */


export function union(...lists) {
  return [...new Set(lists.flat())]
}

export function labelEvidence(inventory, index) {
  return inventory[index]?.label ?? ''
}
