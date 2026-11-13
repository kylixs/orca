import {
  ownEntries,
  parseJsonText,
  readField,
  readNumber,
  readString
} from '../../../shared/json-fields'
import type { WebCloudSessionStorage } from './web-cloud-session-storage'

/**
 * The browser console's host-key pin store (AC-29). Same trust-on-first-use rule
 * as the desktop: the first E2EE key seen for a host is recorded, and a later,
 * different key is a substitution attempt that must be re-verified by hand.
 *
 * SHA-256 over the raw key bytes via WebCrypto — the digest has to be
 * collision-resistant, and the browser has no synchronous hash to borrow.
 */

export const WEB_HOST_TRUST_STORAGE_KEY = 'orca.webCloudHostTrust'

export type WebPinnedHostKey = { fingerprint: string; e2eePublicKeyB64: string; pinnedAtMs: number }

export type WebHostTrustStore = {
  version: 1
  hosts: Record<string, WebPinnedHostKey>
}

export type WebHostKeyVerdict =
  | { state: 'first_use'; fingerprint: string }
  | { state: 'trusted'; fingerprint: string }
  | { state: 'mismatch'; pinnedFingerprint: string; seenFingerprint: string }

export async function webHostKeyFingerprint(e2eePublicKeyB64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(e2eePublicKeyB64), (char) => char.charCodeAt(0))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `sha256:${hex}`
}

function readPinned(value: unknown): WebPinnedHostKey | null {
  const fingerprint = readString(value, 'fingerprint')
  const e2eePublicKeyB64 = readString(value, 'e2eePublicKeyB64')
  const pinnedAtMs = readNumber(value, 'pinnedAtMs')
  if (fingerprint === null || e2eePublicKeyB64 === null || pinnedAtMs === null) {
    return null
  }
  return { fingerprint, e2eePublicKeyB64, pinnedAtMs }
}

export function emptyWebHostTrust(): WebHostTrustStore {
  return { version: 1, hosts: {} }
}

/** A corrupt or empty store means nothing is pinned yet, never "trust everything". */
export function loadWebHostTrust(storage: WebCloudSessionStorage): WebHostTrustStore {
  const store = emptyWebHostTrust()
  const text = storage.read()
  if (text === null) {
    return store
  }
  try {
    for (const [hostId, value] of ownEntries(readField(parseJsonText(text), 'hosts'))) {
      const pinned = readPinned(value)
      if (pinned) {
        store.hosts[hostId] = pinned
      }
    }
  } catch {
    return emptyWebHostTrust()
  }
  return store
}

export function saveWebHostTrust(storage: WebCloudSessionStorage, store: WebHostTrustStore): void {
  storage.write(JSON.stringify(store))
}

export async function webHostKeyVerdict(
  store: WebHostTrustStore,
  hostId: string,
  e2eePublicKeyB64: string
): Promise<WebHostKeyVerdict> {
  const seenFingerprint = await webHostKeyFingerprint(e2eePublicKeyB64)
  const pinned = store.hosts[hostId]
  if (!pinned) {
    return { state: 'first_use', fingerprint: seenFingerprint }
  }
  if (pinned.fingerprint === seenFingerprint) {
    return { state: 'trusted', fingerprint: seenFingerprint }
  }
  return { state: 'mismatch', pinnedFingerprint: pinned.fingerprint, seenFingerprint }
}

export async function pinWebHostKey(
  storage: WebCloudSessionStorage,
  hostId: string,
  e2eePublicKeyB64: string,
  nowMs: number
): Promise<WebPinnedHostKey> {
  const store = loadWebHostTrust(storage)
  const pinned: WebPinnedHostKey = {
    fingerprint: await webHostKeyFingerprint(e2eePublicKeyB64),
    e2eePublicKeyB64,
    pinnedAtMs: nowMs
  }
  store.hosts[hostId] = pinned
  saveWebHostTrust(storage, store)
  return pinned
}
