import { useLocalSearchParams } from 'expo-router'
import { MobileFilePreviewScreen } from '../../../../../src/files/MobileFilePreviewScreen'
import { normalizeMobileFilePreviewRouteParams } from '../../../../../src/files/mobile-file-preview-route'

/**
 * The file preview is native in every build, OTA included.
 *
 * It hosts the file action sheet, selection mode, and save/open actions; the desktop page behind
 * the shell cannot perform any of them on a phone. The web sibling remains for direct shell use.
 */
export default function MobileFilePreviewRoute() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    relativePath?: string | string[]
    source?: string | string[]
    absolutePath?: string | string[]
    grantId?: string | string[]
    terminal?: string | string[]
    pathText?: string | string[]
    cwd?: string | string[]
    nativeChatTab?: string | string[]
    nativeChatSession?: string | string[]
    line?: string | string[]
    column?: string | string[]
    name?: string | string[]
    worktreeName?: string | string[]
    mode?: string | string[]
  }>()
  return <MobileFilePreviewScreen route={normalizeMobileFilePreviewRouteParams(params)} />
}
