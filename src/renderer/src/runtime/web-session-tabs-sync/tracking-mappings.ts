import type { WebSessionTabsSyncState } from './state'
import {
  hostSessionTabIdByLocalKey,
  hostSessionTabMappingKeysByEnvironmentAndWorktree
} from './state'
import { resolveWebAgentSessionHandoff } from '../web-agent-session-handoff'

function hostSessionTabMappingKey(args: {
  environmentId: string
  worktreeId: string
  tabId: string
}): string {
  return `${args.environmentId}:${args.worktreeId}:${args.tabId}`
}

// Why: a client-owned split mints a local group id the host never saw, so a mirrored
// move must resolve it back to the host group it actually became.
const hostSessionGroupIdByLocalKey = new Map<string, string>()

function hostSessionGroupMappingKey(args: {
  environmentId: string
  worktreeId: string
  groupId: string
}): string {
  return `${args.environmentId}:${args.worktreeId}:${args.groupId}`
}

export function setHostSessionGroupIdMapping(
  args: { environmentId: string; worktreeId: string; groupId: string },
  hostGroupId: string
): void {
  const mappingKey = hostSessionGroupMappingKey(args)
  // Why: the first exact member-set match is the stable identity; a later frame must not
  // re-point an established local group at a different host group.
  if (!hostSessionGroupIdByLocalKey.has(mappingKey)) {
    hostSessionGroupIdByLocalKey.set(mappingKey, hostGroupId)
  }
}

export function resolveHostSessionGroupIdForWebSessionGroup(args: {
  environmentId: string
  worktreeId: string
  groupId: string
}): string | null {
  return hostSessionGroupIdByLocalKey.get(hostSessionGroupMappingKey(args)) ?? null
}

export function clearHostSessionGroupIdMappings(environmentId: string, worktreeId: string): void {
  const prefix = hostSessionGroupMappingKey({ environmentId, worktreeId, groupId: '' })
  for (const key of hostSessionGroupIdByLocalKey.keys()) {
    if (key.startsWith(prefix)) {
      hostSessionGroupIdByLocalKey.delete(key)
    }
  }
}

export function clearHostSessionGroupIdMappingsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}:`
  for (const key of hostSessionGroupIdByLocalKey.keys()) {
    if (key.startsWith(prefix)) {
      hostSessionGroupIdByLocalKey.delete(key)
    }
  }
}

export function resetHostSessionGroupIdMappingsForTests(): void {
  hostSessionGroupIdByLocalKey.clear()
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
  const prefix = hostSessionTabMappingKey({ environmentId, worktreeId, tabId: '' })
  const keys = hostSessionTabMappingKeysByEnvironmentAndWorktree.get(environmentId)?.get(worktreeId)
  const entries = new Map<string, string>()
  for (const key of keys ?? []) {
    const hostTabId = hostSessionTabIdByLocalKey.get(key)
    if (hostTabId !== undefined) {
      entries.set(key.slice(prefix.length), hostTabId)
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
