/**
 * U113: entering a cloud workspace must re-adopt the host layout even when the tab stream is not
 * reinstalled (the same activeWorktreeId). Entry actions arm the adoption explicitly here; the
 * first applied frame that carries host groups consumes it, so one entry adopts exactly once.
 */
const pendingByWorktree = new Set<string>()

export function requestHostLayoutAdoption(worktreeId: string): void {
  pendingByWorktree.add(worktreeId)
}

export function hasPendingHostLayoutAdoption(worktreeId: string): boolean {
  return pendingByWorktree.has(worktreeId)
}

/** Consumes the entry's single adoption; later frames in the visit stay client-owned. */
export function consumeHostLayoutAdoption(worktreeId: string): boolean {
  return pendingByWorktree.delete(worktreeId)
}

export function resetHostLayoutAdoptionForTests(): void {
  pendingByWorktree.clear()
}
