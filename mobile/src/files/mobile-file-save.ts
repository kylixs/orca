import { Platform } from 'react-native'
import { File } from 'expo-file-system'
import { requireOptionalNativeModule } from 'expo-modules-core'
import { isSharingModuleAvailable } from './file-action-capabilities'
import { FileActionError, SHARING_UNAVAILABLE_MESSAGE } from './file-action-error'
import {
  SAF_MAX_BYTES,
  touchPreparedCacheFile,
  type PreparedCachedFile
} from './mobile-file-download-cache'
import { uniqueLocalFileName } from './file-download-naming'
import { sharePreparedFile } from '../platform/share-file'

export type SavePreparedFileResult =
  | { kind: 'saved'; path: string; sha256: string }
  | { kind: 'shared'; path: string; sha256: string }

/** Only a SAF write is a confirmed on-device save; a share-sheet result stays non-deterministic. */
export type SavedPreparedFileResult = Extract<SavePreparedFileResult, { kind: 'saved' }>

/**
 * The only user-visible "download". Android writes small files through SAF so they land in the
 * folder the user picked; larger files go through the share sheet, whose FileProvider streams
 * from the cache instead of building a multi-megabyte base64 string in JS.
 */
export async function savePreparedFileToPhone(
  prepared: PreparedCachedFile
): Promise<SavePreparedFileResult> {
  if (Platform.OS !== 'android') {
    await sharePreparedFile(prepared, { dialogTitle: 'Save to phone' })
    return { kind: 'shared', path: prepared.fileName, sha256: prepared.sha256 }
  }
  if (prepared.size <= SAF_MAX_BYTES && hasStorageAccessFramework()) {
    return saveThroughStorageAccessFramework(prepared)
  }
  if (isSharingModuleAvailable()) {
    await sharePreparedFile(prepared, { dialogTitle: 'Save to phone' })
    return { kind: 'shared', path: prepared.fileName, sha256: prepared.sha256 }
  }
  throw new FileActionError('unavailable', SHARING_UNAVAILABLE_MESSAGE)
}

async function saveThroughStorageAccessFramework(
  prepared: PreparedCachedFile
): Promise<SavePreparedFileResult> {
  // The legacy namespace constructs its native shim at import; keep it out of old binaries and
  // out of the module graph until the Android save path actually runs.
  const { StorageAccessFramework } = await import('expo-file-system/legacy')
  let permission: Awaited<
    ReturnType<typeof StorageAccessFramework.requestDirectoryPermissionsAsync>
  >
  try {
    permission = await StorageAccessFramework.requestDirectoryPermissionsAsync()
  } catch {
    throw new FileActionError('save_failed', 'Unable to open the folder picker')
  }
  if (!permission.granted) {
    throw new FileActionError('cancelled', 'Save cancelled')
  }

  let existing: string[]
  try {
    existing = await StorageAccessFramework.readDirectoryAsync(permission.directoryUri)
  } catch {
    throw new FileActionError(
      'save_failed',
      'Folder permission was revoked. Choose another folder.'
    )
  }
  const fileName = uniqueLocalFileName(prepared.fileName, existing.map(safDocumentName))
  let targetUri: string
  try {
    targetUri = await StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      fileName,
      prepared.mimeType
    )
  } catch {
    throw new FileActionError(
      'save_failed',
      'Folder permission was revoked. Choose another folder.'
    )
  }
  try {
    // Reading the cache as base64 is bounded by SAF_MAX_BYTES; the model already refused larger.
    const base64 = await new File(prepared.uri).base64()
    await StorageAccessFramework.writeAsStringAsync(targetUri, base64, { encoding: 'base64' })
  } catch {
    throw new FileActionError('save_failed', 'Unable to write the file to that folder')
  }
  touchPreparedCacheFile(prepared)
  return {
    kind: 'saved',
    path: safVisiblePath(targetUri) || fileName,
    sha256: prepared.sha256
  }
}

function hasStorageAccessFramework(): boolean {
  try {
    const module = requireOptionalNativeModule<Record<string, unknown>>('ExponentFileSystem')
    return (
      module != null &&
      typeof module.requestDirectoryPermissionsAsync === 'function' &&
      typeof module.createSAFFileAsync === 'function'
    )
  } catch {
    return false
  }
}

/** SAF documents arrive as `primary:Folder/name.ext` inside a content URI. */
function safDocumentName(uri: string): string {
  const decoded = decodeURIComponent(uri)
  const tail = decoded.split('/').pop() ?? decoded
  const afterColon = tail.split(':').pop() ?? tail
  return afterColon || decoded
}

/** The part of a SAF document URI a person recognizes: `Download/name.ext`, not `content://…`. */
function safVisiblePath(uri: string): string {
  const decoded = decodeURIComponent(uri)
  const documentPart = decoded.split('/document/').pop() ?? decoded
  const withoutVolume = documentPart.split(':').slice(1).join(':') || documentPart
  return withoutVolume
}
