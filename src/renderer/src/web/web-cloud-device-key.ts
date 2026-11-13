import { parseJsonText, readString } from '../../../shared/json-fields'
import { WebPairingCloudKeyError, type WebPairingCloudBinding } from './web-pairing'
import {
  bytesToBase64,
  generateKeyPair,
  publicKeyFromSecretKey,
  publicKeyToBase64,
  secretKeyFromBase64
} from './web-e2ee'

/**
 * The browser's cloud device identity. The platform binds the public half into
 * every ticket, and the host compares it with the upgrade's `orca-device.` token.
 * The secret half never leaves the persisted blob and the E2EE handshake.
 */

const KEY_BYTES = 32
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const LOCAL_STORAGE_KEY = 'orca.webCloudDeviceKey'

/** The persistence seam; callers supply localStorage/IndexedDB, this module stays pure. */
export type WebCloudDeviceKeyStorage = {
  read(): string | null
  write(value: string): void
}

export type WebCloudDeviceIdentity = {
  publicKeyB64: string
  secretKeyB64: string
}

function decodeKey(value: string): Uint8Array | null {
  if (!STANDARD_BASE64.test(value)) {
    return null
  }
  const unpadded = value.replace(/=+$/, '')
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  let binary: string
  try {
    binary = globalThis.atob(padded)
  } catch {
    return null
  }
  if (binary.length !== KEY_BYTES) {
    return null
  }
  const bytes = new Uint8Array(KEY_BYTES)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytesToBase64(bytes) === padded ? bytes : null
}

function parseStoredIdentity(raw: string | null): WebCloudDeviceIdentity | null {
  if (raw === null) {
    return null
  }
  const parsed = parseJsonText(raw)
  const publicKeyB64 = readString(parsed, 'publicKeyB64')
  const secretKeyB64 = readString(parsed, 'secretKeyB64')
  if (publicKeyB64 === null || secretKeyB64 === null) {
    return null
  }
  const publicKey = decodeKey(publicKeyB64)
  const secretKey = decodeKey(secretKeyB64)
  if (!publicKey || !secretKey) {
    return null
  }
  // Why: a mismatched pair still produces a public key the platform can enrol,
  // so it would only fail much later, inside the handshake.
  const derived = publicKeyFromSecretKey(secretKey)
  if (derived.some((byte, index) => byte !== publicKey[index])) {
    return null
  }
  return {
    publicKeyB64: publicKeyToBase64(publicKey),
    secretKeyB64: bytesToBase64(secretKey)
  }
}

/** Browser wiring for the storage seam; tests inject their own instead. */
export function createLocalStorageWebCloudDeviceKey(
  storage: Storage = window.localStorage
): WebCloudDeviceKeyStorage {
  return {
    read: () => storage.getItem(LOCAL_STORAGE_KEY),
    write: (value) => storage.setItem(LOCAL_STORAGE_KEY, value)
  }
}

/** Reads the persisted identity, or generates and persists one on first use. */
export function loadOrCreateWebCloudDeviceKey(
  storage: WebCloudDeviceKeyStorage
): WebCloudDeviceIdentity {
  const stored = parseStoredIdentity(storage.read())
  if (stored) {
    return stored
  }
  const pair = generateKeyPair()
  const identity: WebCloudDeviceIdentity = {
    publicKeyB64: publicKeyToBase64(pair.publicKey),
    secretKeyB64: bytesToBase64(pair.secretKey)
  }
  storage.write(JSON.stringify(identity))
  return identity
}

/** The cloud handshake key: the persisted device secret, required and 32 bytes. */
export function resolveWebCloudDeviceSecretKey(
  binding: WebPairingCloudBinding | undefined,
  secretKeyB64: string | undefined
): Uint8Array | null {
  if (!binding) {
    return null
  }
  if (!secretKeyB64) {
    throw new WebPairingCloudKeyError('Cloud pairing requires the persisted device secret key.')
  }
  try {
    return secretKeyFromBase64(secretKeyB64)
  } catch {
    throw new WebPairingCloudKeyError(
      'Cloud pairing device secret key must be a 32-byte base64 key.'
    )
  }
}

/** The two fields an offer may carry; the secret half is deliberately absent. */
export function webCloudPairingBinding(
  identity: WebCloudDeviceIdentity,
  credential: string
): WebPairingCloudBinding {
  return { credential, devicePublicKeyB64: identity.publicKeyB64 }
}
