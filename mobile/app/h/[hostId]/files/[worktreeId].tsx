import { useLocalSearchParams } from 'expo-router'
import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'
import { firstParam } from '../../../../src/navigation/route-param-reader'

/**
 * The file explorer is native in every build, OTA included.
 *
 * The desktop web page has no download/open bridge and no row action sheet, so handing this route
 * to the shell would make the new file actions disappear exactly where the OTA build normally
 * lands. The web sibling still exists for a shell that opens this route directly.
 */
export default function MobileFileExplorerScreen() {
  // Through `firstParam`, as the tasks and agent-history switches do: expo-router answers a
  // repeated query key with an array, and a bare read puts it straight into the template.
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const worktreeId = firstParam(params.worktreeId)
  const name = firstParam(params.name)
  return (
    <MobileFileExplorerPanel
      // A different worktree is a fresh explorer: search, filter, and sheet state reset by remount.
      key={`${hostId}:${worktreeId}`}
      hostId={hostId}
      worktreeId={worktreeId}
      name={name}
      embedded={false}
    />
  )
}
