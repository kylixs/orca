import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'

export type SessionTabsTraceParamKey =
  | 'navigation'
  | 'intent'
  | 'materializeOnly'
  | 'notifyClients'
  | 'persistSelection'
  | 'reason'
  | 'worktreeId'
  | 'tabId'
  | 'leafId'

/** Wire params are trimmed to this allowlist; terminal content and credentials never land here. */
export type SessionTabsTraceParams = Partial<
  Record<SessionTabsTraceParamKey, string | boolean | number>
>

export type SessionTabsTraceApplyOptions = {
  hostActiveAuthoritative: boolean
  adoptHostLayout: boolean
}

export type SessionTabsTraceSnapshotSummary = {
  activeTabId?: string | null
  activeGroupId?: string | null
  snapshotVersion?: number
  publicationEpoch?: string
  applied?: boolean
  applyOptions?: SessionTabsTraceApplyOptions
}

export type SessionTabsTraceResult = SessionTabsTraceSnapshotSummary & {
  /** `session.tabs.listAll` answers per worktree, so its frame carries more than one snapshot. */
  snapshots?: SessionTabsTraceSnapshotSummary[]
}

export type SessionTabsTraceFrame = {
  seq: number
  ts: number
  dir: 'req' | 'res' | 'stream'
  requestId: string
  streamSeq?: number
  method: string
  environmentId?: string
  worktree?: string
  tabId?: string
  leafId?: string
  runtimeId?: string
  params?: SessionTabsTraceParams
  ok?: boolean
  errorCode?: string
  result?: SessionTabsTraceResult
  /** Backfilled by the apply layer: did this frame actually change client state? */
  applied?: boolean
  applyOptions?: SessionTabsTraceApplyOptions
}

export type SessionTabsFrameTraceHandle = {
  readonly frames: readonly SessionTabsTraceFrame[]
  clear: () => void
  dump: () => string
}

export type SessionTabsTraceRequest = {
  selector: string
  method: string
  params?: unknown
}

export type SessionTabsSubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}
