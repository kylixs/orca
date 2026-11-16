import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import { readArrayValue, readField, readObjectValue, readString } from '../../../shared/json-fields'

/**
 * U112 D1 (§4.1/§4.3): an explicit end retires every host-backed terminal.
 *
 * The panel's unmount policy only closes the PTY it created (`createdHere`), so
 * attached/reopened tabs — the host-owned shape — would survive an end. Closing
 * them is the host inventory's job: `session.tabs.close` closes the PTY *and*
 * retires the persisted row, which is what keeps it from reappearing on reopen.
 */
export async function closeHostSessionTabsForEnd(
  args: { rpc: CloudRpc; workspacePath?: string | null },
  capabilityGranted = true
): Promise<void> {
  if (!capabilityGranted || !args.workspacePath) {
    return
  }
  const worktree = cloudWorktreeSelector(args.workspacePath)
  const listed = await args.rpc('session.tabs.list', { worktree }).catch(() => null)
  if (!listed?.ok) {
    return
  }
  const tabIds = new Set<string>()
  for (const entry of readArrayValue(readField(listed.result, 'tabs')) ?? []) {
    const row = readObjectValue(entry)
    if (row === null || readField(row, 'type') !== 'terminal') {
      continue
    }
    const tabId = readString(row, 'parentTabId')
    if (tabId !== null) {
      tabIds.add(tabId)
    }
  }
  // Serial: a split host tab closes several PTYs, and the console's 5s budget
  // is the only concurrency bound we have (§4.2).
  for (const tabId of tabIds) {
    await args.rpc('session.tabs.close', { worktree, tabId, reason: 'user' }).catch(() => undefined)
  }
}
