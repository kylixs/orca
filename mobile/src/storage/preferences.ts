import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored } from './mirrored-storage-keys'
import { TERMINAL_TEXT_SCALES } from '../terminal/terminal-text-scales'
import {
  DEFAULT_MOBILE_HTML_OPEN_MODE,
  isMobileHtmlOpenMode,
  type MobileHtmlOpenMode
} from '../files/mobile-html-open-mode'

const PINS_PREFIX = 'orca:pins:'
// Consent to the push service is separate from the old socket notification choice.
const NOTIF_KEY = 'orca:pushServiceNotificationsEnabled'

export type PushNotificationsPreference = {
  readonly value: boolean | null
  readonly loaded: boolean
}

// Why: null distinguishes people who have never made the one-time onboarding
// decision from people who explicitly chose Not now or disabled notifications.
export async function readPushNotificationsPreference(): Promise<PushNotificationsPreference> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_KEY)
    return { value: raw === null ? null : raw === 'true', loaded: true }
  } catch {
    return { value: null, loaded: false }
  }
}

// Why: default-off prevents background notification events from opening the
// system prompt; only the onboarding CTA or Settings switch requests permission.
export async function loadPushNotificationsEnabled(): Promise<boolean> {
  const preference = await readPushNotificationsPreference()
  return preference.value ?? false
}

export async function savePushNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIF_KEY, String(enabled))
}

const REMOTE_PUSH_HOST_REGISTRATIONS_KEY = 'orca:remotePushHostRegistrations'

// Why persisted: switching off while a host is offline leaves a token the gateway
// would still push to. The pending list is the phone's side of the desktop's
// unregister outbox — it survives a restart so the retry actually happens.
export type RemotePushHostRegistrations = {
  readonly registeredHostIds: readonly string[]
  readonly pendingUnregisterHostIds: readonly string[]
}

const EMPTY_REMOTE_PUSH_HOST_REGISTRATIONS: RemotePushHostRegistrations = {
  registeredHostIds: [],
  pendingUnregisterHostIds: []
}

export async function loadRemotePushHostRegistrations(): Promise<RemotePushHostRegistrations> {
  try {
    const raw = await AsyncStorage.getItem(REMOTE_PUSH_HOST_REGISTRATIONS_KEY)
    if (!raw) {
      return EMPTY_REMOTE_PUSH_HOST_REGISTRATIONS
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      registeredHostIds: stringArray(parsed.registeredHostIds),
      pendingUnregisterHostIds: stringArray(parsed.pendingUnregisterHostIds)
    }
  } catch {
    return EMPTY_REMOTE_PUSH_HOST_REGISTRATIONS
  }
}

export async function saveRemotePushHostRegistrations(
  value: RemotePushHostRegistrations
): Promise<void> {
  await AsyncStorage.setItem(REMOTE_PUSH_HOST_REGISTRATIONS_KEY, JSON.stringify(value))
}

const TEXT_SCALE_KEY = 'orca:terminalTextScale'

// Declared beside the terminal that applies them, because the document is bundled for the WebView
// and must not reach this module's storage import; re-exported here for the settings screen.
export { TERMINAL_TEXT_SCALES } from '../terminal/terminal-text-scales'
const DEFAULT_TEXT_SCALE = 1

export async function loadTerminalTextScale(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(TEXT_SCALE_KEY)
    if (raw === null) {
      return DEFAULT_TEXT_SCALE
    }
    const parsed = Number(raw)
    return (TERMINAL_TEXT_SCALES as readonly number[]).includes(parsed)
      ? parsed
      : DEFAULT_TEXT_SCALE
  } catch {
    return DEFAULT_TEXT_SCALE
  }
}

export async function saveTerminalTextScale(scale: number): Promise<void> {
  const value = String(scale)
  // Through the one write path: the hybrid shell hands this key to the page on every `init`,
  // built synchronously, and what it reads is noted there on an accepted write (ruling 35).
  await persistMirrored(TEXT_SCALE_KEY, value)
}

const AUTOCOMPLETE_KEY = 'orca:terminalAutocompleteEnabled'

// Why: terminal command inputs default to autocorrect/suggestions OFF so the
// keyboard never mangles commands, flags, or paths. Users who want phone-style
// typing opt in via Settings → Terminal; the choice persists locally per device.
export async function loadTerminalAutocompleteEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(AUTOCOMPLETE_KEY)
    return raw === 'true'
  } catch {
    return false
  }
}

export async function saveTerminalAutocompleteEnabled(enabled: boolean): Promise<void> {
  const value = String(enabled)
  await persistMirrored(AUTOCOMPLETE_KEY, value)
}

export type MobileShellBuildKind = 'native' | 'ota'

/**
 * Which shell this binary was built for, and the only place the build-time constant is spelled.
 *
 * `babel-preset-expo`'s inline-env-vars plugin replaces a literal `process.env.EXPO_PUBLIC_*`
 * member expression with the build machine's value, so in a release bundle this function has no
 * variable left in it. That rewrite only fires on a literal member expression: a destructure, a
 * computed key or a copy through another binding is not inlined and would read `undefined` on a
 * device, which is why every caller goes through this one and never through `process.env`.
 *
 * Anything but the exact string `ota` — unset, empty, a typo, a value from a stale shell — is
 * native. A build without the variable, development or release, is the native app; the hybrid shell
 * mounts only in a build made with it, and nothing stored can change that.
 */
export function mobileShellBuildKind(): MobileShellBuildKind {
  return process.env.EXPO_PUBLIC_MOBILE_SHELL === 'ota' ? 'ota' : 'native'
}

const TERMINAL_LIVE_INPUT_DISABLED_PREFIX = 'orca:terminalLiveInputDisabled:'

export type DisabledTerminalLiveInputHandlesPreference = {
  readonly handles: Set<string>
  readonly loaded: boolean
}

function terminalLiveInputDisabledKey(hostId: string, worktreeId: string): string {
  return `${TERMINAL_LIVE_INPUT_DISABLED_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(
    worktreeId
  )}`
}

export async function readDisabledTerminalLiveInputHandlesPreference(
  hostId: string,
  worktreeId: string
): Promise<DisabledTerminalLiveInputHandlesPreference> {
  try {
    const raw = await AsyncStorage.getItem(terminalLiveInputDisabledKey(hostId, worktreeId))
    if (!raw) {
      return { handles: new Set(), loaded: true }
    }
    return { handles: new Set(stringArray(JSON.parse(raw))), loaded: true }
  } catch {
    return { handles: new Set(), loaded: false }
  }
}

export async function loadDisabledTerminalLiveInputHandles(
  hostId: string,
  worktreeId: string
): Promise<Set<string>> {
  const preference = await readDisabledTerminalLiveInputHandlesPreference(hostId, worktreeId)
  return preference.handles
}

export async function saveDisabledTerminalLiveInputHandles(
  hostId: string,
  worktreeId: string,
  handles: ReadonlySet<string>
): Promise<void> {
  const key = terminalLiveInputDisabledKey(hostId, worktreeId)
  const value = JSON.stringify([...handles])
  await persistMirrored(key, value)
}

const SIDEBAR_WIDTH_KEY = 'orca:hostSidebarWidth'

// Bounds for the draggable host worktree-list sidebar on tablet/foldable
// layouts (mirrors the desktop's resizable sidebar). The caller additionally
// caps the max against the window so the detail pane keeps usable space.
export const HOST_SIDEBAR_MIN_WIDTH = 280
export const HOST_SIDEBAR_MAX_WIDTH = 560
export const HOST_SIDEBAR_DEFAULT_WIDTH = 340

export function clampHostSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return HOST_SIDEBAR_DEFAULT_WIDTH
  }
  return Math.min(HOST_SIDEBAR_MAX_WIDTH, Math.max(HOST_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export async function loadHostSidebarWidth(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (raw === null) {
      return HOST_SIDEBAR_DEFAULT_WIDTH
    }
    return clampHostSidebarWidth(Number(raw))
  } catch {
    return HOST_SIDEBAR_DEFAULT_WIDTH
  }
}

export async function saveHostSidebarWidth(width: number): Promise<void> {
  const value = String(clampHostSidebarWidth(width))
  await persistMirrored(SIDEBAR_WIDTH_KEY, value)
}

const DOCK_WIDTH_KEY = 'orca:hostDockWidth'

// Bounds for the draggable right-hand session dock (Source Control / Files / PR)
// on wide layouts. Mirrors the left worktree-list sidebar's bounds so the two
// resizable columns read as a matched pair; the default matches the left default.
// The caller additionally caps the max against the window so the terminal keeps
// usable space.
export const HOST_DOCK_MIN_WIDTH = 280
export const HOST_DOCK_MAX_WIDTH = 560
export const HOST_DOCK_DEFAULT_WIDTH = 340

export function clampHostDockWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return HOST_DOCK_DEFAULT_WIDTH
  }
  return Math.min(HOST_DOCK_MAX_WIDTH, Math.max(HOST_DOCK_MIN_WIDTH, Math.round(width)))
}

export async function loadHostDockWidth(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(DOCK_WIDTH_KEY)
    if (raw === null) {
      return HOST_DOCK_DEFAULT_WIDTH
    }
    return clampHostDockWidth(Number(raw))
  } catch {
    return HOST_DOCK_DEFAULT_WIDTH
  }
}

export async function saveHostDockWidth(width: number): Promise<void> {
  const value = String(clampHostDockWidth(width))
  await persistMirrored(DOCK_WIDTH_KEY, value)
}

export type MobileTerminalLinkOpenMode = 'ask' | 'orca-browser' | 'phone-browser'

export type LegacyTerminalLinkOpenMode = Exclude<MobileTerminalLinkOpenMode, 'ask'>

const TERMINAL_LINK_OPEN_MODE_KEY = 'orca:terminalLinkOpenMode:v2'
const LEGACY_TERMINAL_LINK_OPEN_MODE_KEY = 'orca:terminalLinkOpenMode'
export const DEFAULT_TERMINAL_LINK_OPEN_MODE: MobileTerminalLinkOpenMode = 'ask'

function isTerminalLinkOpenMode(value: unknown): value is MobileTerminalLinkOpenMode {
  return value === 'ask' || value === 'orca-browser' || value === 'phone-browser'
}

function isLegacyTerminalLinkOpenMode(value: unknown): value is LegacyTerminalLinkOpenMode {
  return value === 'orca-browser' || value === 'phone-browser'
}

let terminalLinkOpenModeWriteBarrier: Promise<void> | null = null

/** Orders every v2 write, including the migration's read/compare/write. */
function queueTerminalLinkOpenModeWrite<T>(write: () => Promise<T>): Promise<T> {
  const queued = (terminalLinkOpenModeWriteBarrier ?? Promise.resolve()).then(write)
  const barrier = queued.then(
    () => undefined,
    () => undefined
  )
  terminalLinkOpenModeWriteBarrier = barrier
  void barrier.then(() => {
    if (terminalLinkOpenModeWriteBarrier === barrier) {
      terminalLinkOpenModeWriteBarrier = null
    }
  })
  return queued
}

export async function loadTerminalLinkOpenMode(): Promise<MobileTerminalLinkOpenMode> {
  await terminalLinkOpenModeWriteBarrier
  try {
    const raw = await AsyncStorage.getItem(TERMINAL_LINK_OPEN_MODE_KEY)
    return isTerminalLinkOpenMode(raw) ? raw : DEFAULT_TERMINAL_LINK_OPEN_MODE
  } catch {
    return DEFAULT_TERMINAL_LINK_OPEN_MODE
  }
}

export function saveTerminalLinkOpenMode(mode: MobileTerminalLinkOpenMode): Promise<void> {
  // Why: a Remember save landing mid-migration must not be overwritten by the migration's `ask`.
  return queueTerminalLinkOpenModeWrite(() => persistMirrored(TERMINAL_LINK_OPEN_MODE_KEY, mode))
}

let legacyLinkModeConsumed = false

/**
 * Reads the pre-v2 preference once, on the first link sheet.
 *
 * The old value primes that sheet only. Migration writes `ask` to v2 only when no v2 value exists;
 * a user who already picked a v2 mode keeps it. Either way the old key is removed.
 */
export async function consumeLegacyTerminalLinkOpenMode(): Promise<LegacyTerminalLinkOpenMode | null> {
  if (legacyLinkModeConsumed) {
    return null
  }
  legacyLinkModeConsumed = true
  // Why: the v2 read/compare/write shares its key with Remember saves; single-flight both so a
  // save issued while the migration is awaiting storage cannot land before the migration's `ask`.
  return queueTerminalLinkOpenModeWrite(async () => {
    let preselect: LegacyTerminalLinkOpenMode | null = null
    try {
      const raw = await AsyncStorage.getItem(LEGACY_TERMINAL_LINK_OPEN_MODE_KEY)
      const legacy = isLegacyTerminalLinkOpenMode(raw) ? raw : null
      if (raw === null) {
        return null
      }
      const current = await AsyncStorage.getItem(TERMINAL_LINK_OPEN_MODE_KEY)
      if (current === null) {
        await persistMirrored(TERMINAL_LINK_OPEN_MODE_KEY, DEFAULT_TERMINAL_LINK_OPEN_MODE)
        // Why: a user who already picked a v2 mode must not see the old value highlighted.
        preselect = legacy
      }
      await persistMirrored(LEGACY_TERMINAL_LINK_OPEN_MODE_KEY, null)
    } catch {
      // Why: a store that fails here must not keep the old value as a preselection on every sheet.
      return preselect
    }
    return preselect
  })
}

/** Test seam: the one-time migration latch outlives a test's storage double. */
export function resetLegacyTerminalLinkOpenModeForTests(): void {
  legacyLinkModeConsumed = false
  terminalLinkOpenModeWriteBarrier = null
}

export const MOBILE_HTML_OPEN_MODE_KEY = 'orca:mobileHtmlOpenMode'

/**
 * Invalid or unreadable values fall back to `ask`, which is the only mode that writes nothing
 * until the reader chooses. The caller shows the chooser for that answer.
 */
export async function loadMobileHtmlOpenMode(): Promise<MobileHtmlOpenMode> {
  try {
    const raw = await AsyncStorage.getItem(MOBILE_HTML_OPEN_MODE_KEY)
    return isMobileHtmlOpenMode(raw) ? raw : DEFAULT_MOBILE_HTML_OPEN_MODE
  } catch {
    return DEFAULT_MOBILE_HTML_OPEN_MODE
  }
}

export async function saveMobileHtmlOpenMode(mode: MobileHtmlOpenMode): Promise<void> {
  await persistMirrored(MOBILE_HTML_OPEN_MODE_KEY, mode)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export async function loadPinnedIds(hostId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PINS_PREFIX + hostId)
    if (!raw) {
      return new Set()
    }
    return new Set(stringArray(JSON.parse(raw)))
  } catch {
    return new Set()
  }
}

export async function savePinnedIds(hostId: string, ids: Set<string>): Promise<void> {
  const key = PINS_PREFIX + hostId
  const value = JSON.stringify([...ids])
  await persistMirrored(key, value)
}
