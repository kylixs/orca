import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-session-contracts'
import { assertProjectedSessionTabVisible } from '../runtime/rpc/methods/session-tab-browser-placement-projection'
import {
  checkCloudTargetScope,
  type CloudPathDecision,
  type CloudPathRoots
} from './cloud-path-boundary'

/**
 * U96 A-2: `terminal` permission also carries the session-tab inventory and
 * restore subset, so a client picks the worktree and tab those calls address.
 * The inventory is filtered per ticket; these checks keep a direct `session.tabs.*`
 * call inside the same boundary instead of trusting its selectors.
 */

export type CloudSessionTabsScope = { kind: 'worktree' } | { kind: 'tab' }

/** Names a worktree only: the selector boundary is the whole call. */
const WORKTREE_METHODS: ReadonlySet<string> = new Set([
  'session.tabs.list',
  'session.tabs.subscribe'
])

/** Names a worktree and one tab inside it; the tab must be in that worktree's projection. */
const TAB_METHODS: ReadonlySet<string> = new Set([
  'session.tabs.activate',
  'session.tabs.close',
  'session.tabs.move'
])

export function cloudSessionTabsScopeOf(method: string): CloudSessionTabsScope | null {
  if (WORKTREE_METHODS.has(method)) {
    return { kind: 'worktree' }
  }
  if (TAB_METHODS.has(method)) {
    return { kind: 'tab' }
  }
  // listAll/subscribeAll name no worktree; their payloads are filtered by the
  // inventory projection instead of an envelope check.
  return null
}

export type CloudSessionTabsGuardRuntime = {
  resolveWorktreeRootPath: (worktreeSelector: string) => Promise<string>
  /** Absent on hosts that cannot answer; a tab method then fails closed. */
  listMobileSessionTabs?: (worktreeSelector: string) => Promise<RuntimeMobileSessionTabsResult>
}

export async function checkCloudSessionTabsScope(args: {
  runtime: CloudSessionTabsGuardRuntime
  roots: CloudPathRoots
  method: string
  params: unknown
  scope: CloudSessionTabsScope
}): Promise<CloudPathDecision> {
  const selector = stringField(args.params, 'worktree')
  if (selector === null) {
    return {
      ok: false,
      reason: 'worktree_required',
      message: 'This call must name the worktree it addresses.'
    }
  }
  let worktreePath: string
  try {
    worktreePath = await args.runtime.resolveWorktreeRootPath(selector)
  } catch {
    return {
      ok: false,
      reason: 'worktree_unknown',
      message: 'This worktree is not available to the cloud session.'
    }
  }
  // Why write scope: the inventory projection keeps exactly the worktrees under
  // the ticket's workspace root, so list and mutate must agree with it.
  const worktreeScope = checkCloudTargetScope(args.roots, 'write', worktreePath)
  if (!worktreeScope.ok) {
    return worktreeScope
  }
  if (args.scope.kind === 'worktree') {
    return { ok: true }
  }
  const tabId = stringField(args.params, 'tabId')
  if (tabId === null) {
    return { ok: false, reason: 'tab_required', message: 'This call must name a tab.' }
  }
  const list = args.runtime.listMobileSessionTabs
  if (!list) {
    return {
      ok: false,
      reason: 'tab_unverifiable',
      message: 'This host cannot verify the tab before the operation.'
    }
  }
  return assertCloudSessionTabVisible(await list(selector), tabId)
}

/** A tab reachable through a direct call must be one the worktree projects. */
export function assertCloudSessionTabVisible(
  snapshot: RuntimeMobileSessionTabsResult,
  tabId: string
): CloudPathDecision {
  try {
    assertProjectedSessionTabVisible(snapshot, tabId)
    return { ok: true }
  } catch {
    return {
      ok: false,
      reason: 'tab_unknown',
      message: 'This tab is not available to the cloud session.'
    }
  }
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return null
  }
  const field: unknown = key in value ? Reflect.get(value, key) : undefined
  return typeof field === 'string' && field.length > 0 ? field : null
}
