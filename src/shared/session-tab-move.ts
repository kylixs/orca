import type { RuntimeMobileSessionTabMove } from './runtime-session-contracts'

export type SessionTabMoveRequest = {
  requestId: string
  worktreeId: string
  expiresAt?: number
} & RuntimeMobileSessionTabMove

/** `applied: false` means the window's store did not contain the target worktree/tab/group. */
export type SessionTabMoveResponse = {
  requestId: string
  applied: boolean
}
