import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import {
  readArrayValue,
  readField,
  readNumber,
  readObjectValue,
  readString
} from '../../../shared/json-fields'
import type { RuntimeMobileSessionClientTab } from '../../../shared/runtime-mobile-session-tab-contracts'

/**
 * U96 B-令7: simple-workspace orphan fallback.
 *
 * The host may still hold the PTY of a tab whose projected row lost its handle
 * (a restart between persistence and publication). For those pending rows we
 * ask `terminal.list` for this worktree, match the surviving PTY by `ptyId`,
 * and claim it back through `terminal.adoptOrphans` under the same worktree
 * selector the A-3 scope validates. One attempt per bootstrap: a failed
 * list/adopt degrades silently instead of warning in a loop.
 */

export type CloudSimpleOrphanCandidate = {
  tabId: string
  leafId: string
  /** The PTY the persisted row still names; the host inventory is matched on it. */
  ptyId: string
  title: string
}

export type CloudSimpleOrphanClaim = {
  terminal: string
  ptyId: string
  incarnationId: string
  tabId: string
  leafId: string
}

export type CloudSimpleOrphanFrame = { tabs: readonly RuntimeMobileSessionClientTab[] }

export type CloudSimpleOrphanInventory = {
  claims: CloudSimpleOrphanClaim[]
  topologyRevision: number
}

const MAX_ORPHAN_CLAIMS = 64

/**
 * Tabs whose row has no live handle but still names a PTY. The simple workspace
 * renders one leaf per host tab, so the first pending row of a tab is the one
 * worth claiming; extra leaves of a split are left to the host topology.
 */
export function collectSimpleWorkspaceOrphanCandidates(
  frame: CloudSimpleOrphanFrame
): CloudSimpleOrphanCandidate[] {
  const seenTabs = new Set<string>()
  const candidates: CloudSimpleOrphanCandidate[] = []
  for (const row of frame.tabs) {
    if (row.type !== 'terminal' || row.status !== 'pending-handle') {
      continue
    }
    const ptyId = row.ptyId
    if (typeof ptyId !== 'string' || ptyId === '' || seenTabs.has(row.parentTabId)) {
      continue
    }
    seenTabs.add(row.parentTabId)
    candidates.push({
      tabId: row.parentTabId,
      leafId: row.leafId,
      ptyId,
      title: row.title
    })
    if (candidates.length === MAX_ORPHAN_CLAIMS) {
      break
    }
  }
  return candidates
}

export function buildSimpleOrphanListParams(worktree: string): Record<string, unknown> {
  return { worktree, requireFreshPtyLiveness: true, includeVisualLayouts: false }
}

/**
 * Claims from a `terminal.list` answer. A claim needs the host's own orphan
 * attestation plus a PTY incarnation; anything weaker stays pending rather than
 * binding a tab to a PTY the host cannot fence.
 */
export function readSimpleOrphanInventory(
  candidates: readonly CloudSimpleOrphanCandidate[],
  listedResult: unknown,
  scope: { worktree: string; workspacePath: string }
): CloudSimpleOrphanInventory | null {
  const terminals = readArrayValue(readField(listedResult, 'terminals'))
  if (terminals === null) {
    return null
  }
  const byPtyId = new Map<string, unknown>()
  const duplicated = new Set<string>()
  for (const entry of terminals) {
    const terminal = readObjectValue(entry)
    if (terminal === null) {
      continue
    }
    const ptyId = readString(terminal, 'ptyId')
    if (ptyId === null) {
      continue
    }
    if (byPtyId.has(ptyId)) {
      duplicated.add(ptyId)
    } else {
      byPtyId.set(ptyId, terminal)
    }
  }

  const claims: CloudSimpleOrphanClaim[] = []
  for (const candidate of candidates) {
    if (duplicated.has(candidate.ptyId)) {
      continue
    }
    const terminal = byPtyId.get(candidate.ptyId)
    if (terminal === undefined || readField(terminal, 'orphaned') !== true) {
      continue
    }
    const worktreePath = readString(terminal, 'worktreePath')
    if (worktreePath !== null && worktreePath !== scope.workspacePath) {
      continue
    }
    const handle = readString(terminal, 'handle')
    const incarnationId = readString(terminal, 'incarnationId')
    if (handle === null || incarnationId === null) {
      continue
    }
    claims.push({
      terminal: handle,
      ptyId: candidate.ptyId,
      incarnationId,
      tabId: candidate.tabId,
      leafId: candidate.leafId
    })
  }

  const revisions = readObjectValue(readField(listedResult, 'topologyRevisions'))
  const revisionKey = [scope.worktree, scope.workspacePath].find(
    (key) => readNumber(revisions, key) !== null
  )
  return {
    claims,
    topologyRevision: revisionKey === undefined ? 0 : (readNumber(revisions, revisionKey) ?? 0)
  }
}

export function buildSimpleOrphanAdoptParams(
  worktree: string,
  inventory: CloudSimpleOrphanInventory
): Record<string, unknown> {
  return {
    worktree,
    expectedTopologyRevision: inventory.topologyRevision,
    claims: inventory.claims
  }
}

/**
 * The adopted `session.tabs` snapshot, or null. Returned raw: the caller owns
 * the frame parser, so this module never invents a projection of its own.
 */
export async function recoverSimpleWorkspaceTerminalOrphans(args: {
  rpc: CloudRpc
  workspacePath: string
  frame: CloudSimpleOrphanFrame
  /** False once the bootstrap was cancelled or degraded; stops the second call. */
  isCurrent: () => boolean
}): Promise<unknown> {
  const candidates = collectSimpleWorkspaceOrphanCandidates(args.frame)
  if (candidates.length === 0) {
    return null
  }
  const worktree = cloudWorktreeSelector(args.workspacePath)
  const listed = await args
    .rpc('terminal.list', buildSimpleOrphanListParams(worktree))
    .catch(() => null)
  if (!args.isCurrent() || !listed?.ok) {
    return null
  }
  const inventory = readSimpleOrphanInventory(candidates, listed.result, {
    worktree,
    workspacePath: args.workspacePath
  })
  if (inventory === null || inventory.claims.length === 0) {
    return null
  }
  const adopted = await args
    .rpc('terminal.adoptOrphans', buildSimpleOrphanAdoptParams(worktree, inventory))
    .catch(() => null)
  if (!args.isCurrent() || !adopted?.ok) {
    return null
  }
  return readObjectValue(readField(adopted.result, 'snapshot'))
}
