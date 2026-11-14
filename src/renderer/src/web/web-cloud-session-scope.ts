import { isWebClientLocation } from '@/lib/web-client-location'
import { isCloudSessionRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  isCloudSessionWebEnvironment,
  readStoredWebRuntimeEnvironment,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'

/**
 * Whether this page's runtime connection is a cloud (ticket) session.
 *
 * A cloud session's host refuses every native-catalog RPC (`repo.list`,
 * `ssh.*`, `projectGroup.list`, `folderWorkspace.list`,
 * `worktree.lineageList` are desktop-owned state), so the App's startup chain
 * gates those calls on this instead of booting degraded on a doomed call.
 *
 * Why the memo is keyed on the stored environment's id: the answer must not
 * outlive the session it describes. A dead cloud ticket drops the same page
 * back into WebConnect, and pairing there saves a different (non-cloud)
 * environment under a new id — the next read re-derives the scope instead of
 * silently keeping the cloud skips on a paired client.
 *
 * Why the web-client check comes first: a desktop client has no web session
 * record to read, and callers (sidebar, IPC bridges) must not touch
 * `localStorage` at all on that path.
 */
let cached: { environmentId: string | null; cloud: boolean } | null = null

export function isActiveWebClientCloudSession(): boolean {
  const environment = isWebClientLocation() ? readStoredWebRuntimeEnvironment() : null
  const environmentId = environment?.id ?? null
  if (cached?.environmentId !== environmentId) {
    cached = {
      environmentId,
      cloud: environment !== null && isCloudSessionWebEnvironment(environment)
    }
  }
  return cached.cloud
}

/** Test seam: the next read re-derives the scope from the stored environment. */
export function resetWebCloudSessionScope(): void {
  cached = null
}

/**
 * Whether this paired web environment is a cloud (ticket) session, whose host refuses the
 * client-preference families (`ui.*`, `settings.*`): browser-local state is the only peer.
 * Nothing paired yet is not a cloud session, so callers keep their paired behavior.
 */
export function isCloudSessionStoredEnvironment(
  environment: StoredWebRuntimeEnvironment | null
): boolean {
  return environment !== null && isCloudSessionRuntimeEnvironment(environment)
}
