import type { WebSessionTabsSnapshotApplyOptions } from './state'
import { captureWebSessionIntentOwner } from '../web-runtime-session-environment'
import { peekWebSessionFocusIntent } from '../web-session-focus-intent'

/**
 * U138: a cloud host is the single active-tab authority. Follow it on every frame so a value the
 * host corrects after the one-shot entry adoption still lands. A caller focus intent is a local
 * gesture already on its way to the host, so it keeps priority.
 */
export function resolveHostActiveApplyOptions(args: {
  environmentId: string
  worktreeId: string
  isCloudSession: boolean
  pendingAdoption: boolean
  hasHostGroups: boolean
}): { options?: WebSessionTabsSnapshotApplyOptions; adoptHostLayout: boolean } {
  const adoptHostLayout = args.isCloudSession && args.pendingAdoption && args.hasHostGroups
  const followHostActive =
    args.isCloudSession &&
    peekWebSessionFocusIntent(
      captureWebSessionIntentOwner(args.environmentId),
      args.worktreeId
    ) === null
  const options =
    adoptHostLayout || followHostActive
      ? {
          ...(adoptHostLayout ? { adoptHostLayout: true } : {}),
          ...(followHostActive ? { hostActiveAuthoritative: true } : {})
        }
      : undefined
  return { options, adoptHostLayout }
}
