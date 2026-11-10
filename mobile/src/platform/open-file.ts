import { Platform } from 'react-native'
import { File } from 'expo-file-system'
import {
  isIntentLauncherModuleAvailable,
  isSharingModuleAvailable
} from '../files/file-action-capabilities'
import { FileActionError, SHARING_UNAVAILABLE_MESSAGE } from '../files/file-action-error'
import {
  touchPreparedCacheFile,
  type PreparedCachedFile
} from '../files/mobile-file-download-cache'
import { sharePreparedFile } from './share-file'

/** `Intent.FLAG_GRANT_READ_URI_PERMISSION`, which lets the receiver read our content URI. */
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001

export type OpenPreparedFileResult = 'opened' | 'shared'

/**
 * Hands the cached file to another app.
 *
 * Android uses ACTION_VIEW with the FileProvider content URI and a read grant. A missing handler
 * (or a stale content URI) falls back to the share sheet; iOS has no ACTION_VIEW equivalent, so
 * the share sheet is the open-with surface.
 */
export async function openPreparedFile(
  prepared: PreparedCachedFile
): Promise<OpenPreparedFileResult> {
  if (Platform.OS !== 'android') {
    await sharePreparedFile(prepared, { dialogTitle: 'Open with' })
    return 'shared'
  }
  if (!isIntentLauncherModuleAvailable()) {
    if (isSharingModuleAvailable()) {
      await sharePreparedFile(prepared, { dialogTitle: 'Open with' })
      return 'shared'
    }
    throw new FileActionError('no_app', SHARING_UNAVAILABLE_MESSAGE)
  }
  let contentUri: string
  try {
    contentUri = new File(prepared.uri).contentUri
  } catch {
    throw new FileActionError(
      'no_app',
      'No app available for this file type. Use Save to phone instead.'
    )
  }
  if (!contentUri) {
    throw new FileActionError(
      'no_app',
      'No app available for this file type. Use Save to phone instead.'
    )
  }
  try {
    const IntentLauncher = await import('expo-intent-launcher')
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: prepared.mimeType,
      flags: FLAG_GRANT_READ_URI_PERMISSION
    })
    touchPreparedCacheFile(prepared)
    return 'opened'
  } catch {
    if (isSharingModuleAvailable()) {
      // The chooser is the documented no-handler fallback; it still lets the user pick an app.
      await sharePreparedFile(prepared, { dialogTitle: 'Open with' })
      return 'shared'
    }
    throw new FileActionError(
      'no_app',
      'No app available for this file type. Use Save to phone instead.'
    )
  }
}
