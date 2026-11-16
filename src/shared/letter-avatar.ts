// Why: offline-safe identity badge; replaces the remote Google favicon service (U122).
const AVATAR_COLORS = [
  '#4f6bed',
  '#2f9e8f',
  '#c2622f',
  '#8b5cf6',
  '#b23a5b',
  '#3d8b3d',
  '#a1770f',
  '#4b7f9e'
] as const

export function letterAvatarColor(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}

export function letterAvatarLetter(seed: string): string {
  return seed.trim().charAt(0).toUpperCase() || '?'
}
