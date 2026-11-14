import { isWebClientLocation } from '@/lib/web-client-location'
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
 */
let cloudSessionScope: boolean | null = null

export function isActiveWebClientCloudSession(): boolean {
  cloudSessionScope ??=
    isWebClientLocation() && isCloudSessionScope(readStoredWebRuntimeEnvironment())
  return cloudSessionScope
}

function isCloudSessionScope(environment: StoredWebRuntimeEnvironment | null): boolean {
  return environment !== null && isCloudSessionWebEnvironment(environment)
}

/** Test seam: the next read re-derives the scope from the stored environment. */
export function resetWebCloudSessionScope(): void {
  cloudSessionScope = null
}
