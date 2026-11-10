import { isSharingModuleAvailable } from '../files/file-action-capabilities'
import { FileActionError, SHARING_UNAVAILABLE_MESSAGE } from '../files/file-action-error'
import {
  touchPreparedCacheFile,
  type PreparedCachedFile
} from '../files/mobile-file-download-cache'

export type SharePreparedFileOptions = {
  dialogTitle?: string
  anchor?: { x?: number; y?: number; width?: number; height?: number }
}

/**
 * Opens the system share/save sheet for a file already written to the cache.
 *
 * The wrapper is imported only after the native-module probe answers true: its module scope calls
 * `requireNativeModule('ExpoSharing')`, which throws on a binary built before expo-sharing.
 */
export async function sharePreparedFile(
  prepared: PreparedCachedFile,
  options: SharePreparedFileOptions = {}
): Promise<void> {
  if (!isSharingModuleAvailable()) {
    throw new FileActionError('unavailable', SHARING_UNAVAILABLE_MESSAGE)
  }
  const Sharing = await import('expo-sharing')
  if (!(await Sharing.isAvailableAsync())) {
    throw new FileActionError('unavailable', SHARING_UNAVAILABLE_MESSAGE)
  }
  await Sharing.shareAsync(prepared.uri, {
    mimeType: prepared.mimeType,
    UTI: prepared.uti,
    dialogTitle: options.dialogTitle ?? 'Save to phone',
    ...(options.anchor ? { anchor: options.anchor } : {})
  })
  // The sheet is asynchronous: the target app may read the URI after this resolves.
  touchPreparedCacheFile(prepared)
}
