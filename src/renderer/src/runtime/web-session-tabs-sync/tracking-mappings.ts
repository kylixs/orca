import type { WebSessionTabsSyncState } from './state'
import {
  hostSessionTabIdByLocalKey,
  hostSessionTabMappingKeysByEnvironmentAndWorktree
} from './state'
import { resolveWebAgentSessionHandoff } from '../web-agent-session-handoff'

// Why: ids can carry `:` (e.g. `id:path` selectors), so a joined string would let two different
// (environment, worktree, id) triples collide. A JSON tuple is unambiguous (U169 L4).
type MappingKeyTuple = [environmentId: string, worktreeId: string, localId: string]

function encodeMappingKey(tuple: MappingKeyTuple): string {
  return JSON.stringify(tuple)
}

function parseMappingKey(key: string): MappingKeyTuple | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    return null
  }
  const [environmentId, worktreeId, localId] = parsed
  if (
    typeof environmentId !== 'string' ||
    typeof worktreeId !== 'string' ||
    typeof localId !== 'string'
  ) {
    return null
  }
  return [environmentId, worktreeId, localId]
}

function hostSessionTabMappingKey(args: {
  environmentId: string
  worktreeId: string
  tabId: string
}): string {
  return encodeMappingKey([args.environmentId, args.worktreeId, args.tabId])
}

// Why: a client-owned split mints a local group id the host never saw, so a mirrored
// move must resolve it back to the host group it actually became.
const hostSessionGroupIdByLocalKey = new Map<string, string>()
// Why: the last applied frame's host group ids let a drop onto a host-owned group skip the
// local-UUID guess even before any member-set mapping exists.
const hostSessionGroupIdsByEnvironmentAndWorktree = new Map<string, Map<string, Set<string>>>()

function hostSessionGroupMappingKey(args: {
  environmentId: string
  worktreeId: string
  groupId: string
}): string {
  return encodeMappingKey([args.environmentId, args.worktreeId, args.groupId])
}

function isMappingKeyForWorktree(key: string, environmentId: string, worktreeId: string): boolean {
  const parsed = parseMappingKey(key)
  return parsed !== null && parsed[0] === environmentId && parsed[1] === worktreeId
}

export function setHostSessionGroupIdMapping(
  args: { environmentId: string; worktreeId: string; groupId: string },
  hostGroupId: string
): void {
  // Why: callers clear a stale entry before re-matching, so an existing entry here was
  // re-validated against the current frame.
  hostSessionGroupIdByLocalKey.set(hostSessionGroupMappingKey(args), hostGroupId)
}

export function resolveHostSessionGroupIdForWebSessionGroup(args: {
  environmentId: string
  worktreeId: string
  groupId: string
}): string | null {
  return hostSessionGroupIdByLocalKey.get(hostSessionGroupMappingKey(args)) ?? null
}

/** Local group id → host group id entries recorded for one worktree. */
export function hostSessionGroupMappingsForWorktree(
  environmentId: string,
  worktreeId: string
): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, hostGroupId] of hostSessionGroupIdByLocalKey) {
    if (isMappingKeyForWorktree(key, environmentId, worktreeId)) {
      const localGroupId = parseMappingKey(key)?.[2]
      if (localGroupId !== undefined) {
        entries.set(localGroupId, hostGroupId)
      }
    }
  }
  return entries
}

export function clearHostSessionGroupIdMapping(args: {
  environmentId: string
  worktreeId: string
  groupId: string
}): void {
  hostSessionGroupIdByLocalKey.delete(hostSessionGroupMappingKey(args))
}

export function setKnownHostSessionGroupIds(
  args: { environmentId: string; worktreeId: string },
  hostGroupIds: readonly string[]
): void {
  const byWorktree =
    hostSessionGroupIdsByEnvironmentAndWorktree.get(args.environmentId) ?? new Map()
  byWorktree.set(args.worktreeId, new Set(hostGroupIds))
  hostSessionGroupIdsByEnvironmentAndWorktree.set(args.environmentId, byWorktree)
}

export function isKnownHostSessionGroupId(args: {
  environmentId: string
  worktreeId: string
  groupId: string
}): boolean {
  return (
    hostSessionGroupIdsByEnvironmentAndWorktree
      .get(args.environmentId)
      ?.get(args.worktreeId)
      ?.has(args.groupId) ?? false
  )
}

export function clearHostSessionGroupIdMappings(environmentId: string, worktreeId: string): void {
  for (const key of hostSessionGroupIdByLocalKey.keys()) {
    if (isMappingKeyForWorktree(key, environmentId, worktreeId)) {
      hostSessionGroupIdByLocalKey.delete(key)
    }
  }
  const byWorktree = hostSessionGroupIdsByEnvironmentAndWorktree.get(environmentId)
  byWorktree?.delete(worktreeId)
  if (byWorktree?.size === 0) {
    hostSessionGroupIdsByEnvironmentAndWorktree.delete(environmentId)
  }
}

export function clearHostSessionGroupIdMappingsForEnvironment(environmentId: string): void {
  for (const key of hostSessionGroupIdByLocalKey.keys()) {
    if (parseMappingKey(key)?.[0] === environmentId) {
      hostSessionGroupIdByLocalKey.delete(key)
    }
  }
  hostSessionGroupIdsByEnvironmentAndWorktree.delete(environmentId)
}

export function resetHostSessionGroupIdMappingsForTests(): void {
  hostSessionGroupIdByLocalKey.clear()
  hostSessionGroupIdsByEnvironmentAndWorktree.clear()
}

export function clearHostSessionTabIdMappings(environmentId: string, worktreeId: string): void {
  const mappingKeysByWorktree = hostSessionTabMappingKeysByEnvironmentAndWorktree.get(environmentId)
  const mappingKeys = mappingKeysByWorktree?.get(worktreeId)
  if (!mappingKeys) {
    return
  }
  for (const mappingKey of mappingKeys) {
    hostSessionTabIdByLocalKey.delete(mappingKey)
  }
  mappingKeysByWorktree?.delete(worktreeId)
  if (mappingKeysByWorktree?.size === 0) {
    hostSessionTabMappingKeysByEnvironmentAndWorktree.delete(environmentId)
  }
}

export function setHostSessionTabIdMapping(
  args: { environmentId: string; worktreeId: string; tabId: string },
  hostTabId: string
): void {
  const mappingKey = hostSessionTabMappingKey(args)
  hostSessionTabIdByLocalKey.set(mappingKey, hostTabId)
  const mappingKeysByWorktree =
    hostSessionTabMappingKeysByEnvironmentAndWorktree.get(args.environmentId) ?? new Map()
  const mappingKeys = mappingKeysByWorktree.get(args.worktreeId) ?? new Set<string>()
  mappingKeys.add(mappingKey)
  mappingKeysByWorktree.set(args.worktreeId, mappingKeys)
  hostSessionTabMappingKeysByEnvironmentAndWorktree.set(args.environmentId, mappingKeysByWorktree)
}

export function resolveHostSessionTabIdForWebSessionTab(
  _state: WebSessionTabsSyncState,
  args: { environmentId: string; worktreeId: string; tabId: string }
): string | null {
  return (
    hostSessionTabIdByLocalKey.get(hostSessionTabMappingKey(args)) ??
    // Why: structured create returns canonical identity before its confirming snapshot; an immediate user close must already target that host tab.
    resolveWebAgentSessionHandoff({
      environmentId: args.environmentId,
      worktreeId: args.worktreeId,
      provisionalTabId: args.tabId
    })
  )
}

/** Enumerate only this publishing host's workspace mappings. */
export function hostSessionTabIdsByLocalTabForWorktree(
  environmentId: string,
  worktreeId: string
): Map<string, string> {
  const keys = hostSessionTabMappingKeysByEnvironmentAndWorktree.get(environmentId)?.get(worktreeId)
  const entries = new Map<string, string>()
  for (const key of keys ?? []) {
    const hostTabId = hostSessionTabIdByLocalKey.get(key)
    const localTabId = parseMappingKey(key)?.[2]
    if (hostTabId !== undefined && localTabId !== undefined) {
      entries.set(localTabId, hostTabId)
    }
  }
  return entries
}

/** The local tab mirroring a host tab, or null when no mirrored tab claims it. */
export function resolveLocalTabIdForHostSessionTab(args: {
  environmentId: string
  worktreeId: string
  hostTabId: string
}): string | null {
  for (const [tabId, hostTabId] of hostSessionTabIdsByLocalTabForWorktree(
    args.environmentId,
    args.worktreeId
  )) {
    if (hostTabId === args.hostTabId) {
      return tabId
    }
  }
  return null
}
