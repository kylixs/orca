import type { PreloadApi } from '../../../../preload/api-types'
import type { CloudWorkspaceInfoResponse } from '../../../../shared/cloud-workspace-info'
import {
  openCloudWorkspaceOverRpc,
  type CloudWorkspaceRpc
} from '../../../../shared/cloud-workspace-open'
import { readObjectValue, readString } from '../../../../shared/json-fields'
import { callRuntimeResult } from './web-runtime-calls'

/**
 * The web-only `cloudWorkspace` namespace (W13): a cloud session reads its own
 * ticket-scoped workspace facts and runs the shared ensure flow over the one
 * admitted connection. The desktop preload never installs it — a desktop client
 * has no ticket to answer from.
 */

/** One host read; a stuck host must not hold the workspace bootstrap on it. */
const INFO_TIMEOUT_MS = 15_000

function rpcErrorCode(error: unknown): string {
  return readString(readObjectValue(error) ?? {}, 'code') ?? 'runtime_error'
}

/** Adapts the web transport to the reply shape `openCloudWorkspaceOverRpc` reads. */
const cloudWorkspaceRpc: CloudWorkspaceRpc = async (method, params, timeoutMs) => {
  try {
    return { ok: true, result: await callRuntimeResult(method, params, timeoutMs) }
  } catch (error) {
    return {
      ok: false,
      code: rpcErrorCode(error),
      ...(error instanceof Error && error.message ? { message: error.message } : {})
    }
  }
}

export function createCloudWorkspaceApi(): NonNullable<Partial<PreloadApi>['cloudWorkspace']> {
  return {
    info: () =>
      callRuntimeResult<CloudWorkspaceInfoResponse>('workspace.info', undefined, INFO_TIMEOUT_MS),
    ensure: ({ projectId, roots }) => openCloudWorkspaceOverRpc(cloudWorkspaceRpc, projectId, roots)
  }
}
