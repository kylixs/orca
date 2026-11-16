import { toast } from 'sonner'
import type { RuntimeMobileSessionTabMove } from '../../../../shared/runtime-types'
import { translate } from '@/i18n/i18n'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '../../store'
import {
  isWebRuntimeSessionActive,
  moveWebRuntimeSessionTab
} from '../../runtime/web-runtime-session'

export async function mirrorWebRuntimeTabMove(
  args: RuntimeMobileSessionTabMove & {
    worktreeId: string
  }
): Promise<boolean> {
  const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), args.worktreeId)
  if (!isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const moved = await moveWebRuntimeSessionTab({
    ...args,
    environmentId
  })
  if (!moved) {
    // Why: the local drop already rendered optimistically; without this the host
    // refusal is invisible until the next snapshot snaps the tab back.
    toast.error(
      translate(
        'auto.components.tab-bar.web-runtime-tab-move-mirror.failed',
        "Couldn't move the tab on the host."
      )
    )
  }
  return moved
}
