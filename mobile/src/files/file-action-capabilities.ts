import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'
import { File, Paths } from 'expo-file-system'
import type { FileActionCapabilities } from './mobile-file-actions'

export type FileActionCapabilityProbes = {
  platform: 'ios' | 'android' | 'web' | 'other'
  sharing: boolean
  intentLauncher: boolean
  saf: boolean
  contentUri: boolean
}

/**
 * Capabilities are derived from probes, never from a static import of the native wrapper.
 *
 * `expo-sharing` and `expo-intent-launcher` call `requireNativeModule` at module scope, which
 * throws in an OTA JS bundle running on a binary built before either module existed. Only the JS
 * side of a probe may be imported here; the wrapper itself is a dynamic import taken after the
 * probe says the module is present.
 */
export function fileActionCapabilitiesFor(
  probes: FileActionCapabilityProbes
): FileActionCapabilities {
  const sharing = probes.platform !== 'web' && probes.sharing
  if (probes.platform === 'ios') {
    return { saveToPhone: sharing, openWith: sharing }
  }
  if (probes.platform === 'android') {
    return {
      // Large Android saves also use the share sheet, so either path makes the action available.
      saveToPhone: sharing || probes.saf,
      openWith: probes.intentLauncher && probes.contentUri
    }
  }
  return { saveToPhone: false, openWith: false }
}

/**
 * OTA-shippable rollback switch. Turning it off hides Save/Open while Copy path/content, search,
 * and preview keep working; it needs no new native binary.
 */
export function fileActionsFeatureEnabled(): boolean {
  return process.env.EXPO_PUBLIC_FILE_ACTIONS !== 'off'
}

export function fileActionCapabilities(): FileActionCapabilities {
  if (!fileActionsFeatureEnabled()) {
    return { saveToPhone: false, openWith: false }
  }
  return fileActionCapabilitiesFor(probeFileActionCapabilities())
}

export function probeFileActionCapabilities(): FileActionCapabilityProbes {
  const platform = capabilityPlatform()
  if (platform === 'web') {
    return { platform, sharing: false, intentLauncher: false, saf: false, contentUri: false }
  }
  return {
    platform,
    sharing: hasOptionalModule('ExpoSharing'),
    intentLauncher: hasOptionalModule('ExpoIntentLauncher'),
    saf: platform === 'android' && hasStorageAccessFramework(),
    contentUri: platform === 'android' && hasFileContentUri()
  }
}

/** Dynamic-import guard for the sharing wrapper; the static module would throw on old binaries. */
export function isSharingModuleAvailable(): boolean {
  return hasOptionalModule('ExpoSharing')
}

export function isIntentLauncherModuleAvailable(): boolean {
  return hasOptionalModule('ExpoIntentLauncher')
}

function capabilityPlatform(): FileActionCapabilityProbes['platform'] {
  if (Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web') {
    return Platform.OS
  }
  return 'other'
}

function hasOptionalModule(name: string): boolean {
  try {
    return requireOptionalNativeModule(name) != null
  } catch {
    return false
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

function hasFileContentUri(): boolean {
  try {
    // The getter exists only on expo-file-system's Android native object in SDK 55+.
    return typeof new File(Paths.cache, 'orca-content-uri-probe').contentUri === 'string'
  } catch {
    return false
  }
}
