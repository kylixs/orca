import { readField, readNumber, readString } from '../../../shared/json-fields'
import type { DeviceScope } from '../../../shared/runtime-types'

const PAIRING_OFFER_VERSION = 2
const RUNTIME_PROTOCOL = 'orca-runtime'
const CREDENTIAL_PROTOCOL_PREFIX = 'orca-cred.'
const DEVICE_PROTOCOL_PREFIX = 'orca-device.'
const DEVICE_PUBLIC_KEY_BYTES = 32
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The platform ticket a browser must present at the WebSocket upgrade. */
export type WebPairingCloudBinding = {
  credential: string
  /** Normalised to standard base64; the wire form is the same bytes as base64url. */
  devicePublicKeyB64: string
}

export type WebPairingOffer = {
  v: typeof PAIRING_OFFER_VERSION
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  pairedDeviceId?: string
  scope?: DeviceScope
  /** Present only for offers redeemed through a cloud ticket. */
  cloud?: WebPairingCloudBinding
}

/** A cloud offer whose stored device key cannot be put on the wire. */
export class WebPairingCloudKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebPairingCloudKeyError'
  }
}

export type WebPairingStartupDecision =
  | { kind: 'auto-save-runtime-offer'; offer: WebPairingOffer }
  | { kind: 'show-connect'; initialPairingInput: string | null }
  | { kind: 'use-stored-environment' }

export function parseWebPairingInput(input: string): WebPairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  try {
    if (trimmed.toLowerCase().startsWith('orca://')) {
      const code = extractPairingCodeFromUrl(trimmed)
      return code ? decodePairingPayload(code) : null
    }
    return decodePairingPayload(trimmed)
  } catch {
    return null
  }
}

export function readPairingInputFromLocation(location: Location): string | null {
  const search = new URLSearchParams(location.search)
  for (const key of ['pairing', 'pair', 'code', 'token']) {
    const value = search.get(key)
    if (value?.trim()) {
      return value.trim()
    }
  }

  const hash = location.hash.replace(/^#/, '').trim()
  if (!hash) {
    return null
  }
  if (hash.startsWith('orca://pair')) {
    return hash
  }
  const hashParams = new URLSearchParams(hash)
  for (const key of ['pairing', 'pair', 'code', 'token']) {
    const value = hashParams.get(key)
    if (value?.trim()) {
      return value.trim()
    }
  }
  return hash
}

export function decideWebPairingStartup(args: {
  initialPairingInput: string | null
  hasStoredEnvironment: boolean
}): WebPairingStartupDecision {
  const offer = args.initialPairingInput ? parseWebPairingInput(args.initialPairingInput) : null
  if (offer?.scope === 'runtime') {
    return { kind: 'auto-save-runtime-offer', offer }
  }
  if (offer) {
    return { kind: 'show-connect', initialPairingInput: args.initialPairingInput }
  }
  return args.hasStoredEnvironment
    ? { kind: 'use-stored-environment' }
    : { kind: 'show-connect', initialPairingInput: null }
}

export function clearPairingInputFromAddressBar(): void {
  if (!window.location.hash && !window.location.search) {
    return
  }
  const cleanUrl = `${window.location.origin}${window.location.pathname}`
  // Why: pairing payloads include the runtime auth token. Clear them after
  // import so refresh/share/browser history no longer expose the secret.
  window.history.replaceState(null, document.title, cleanUrl)
}

function decodePairingPayload(base64url: string): WebPairingOffer | null {
  const json = new TextDecoder().decode(base64UrlToBytes(base64url))
  const parsed: unknown = JSON.parse(json)
  const endpoint = readString(parsed, 'endpoint')
  const deviceToken = readString(parsed, 'deviceToken')
  const publicKeyB64 = readString(parsed, 'publicKeyB64')
  if (
    readNumber(parsed, 'v') !== PAIRING_OFFER_VERSION ||
    !endpoint ||
    !deviceToken ||
    !publicKeyB64
  ) {
    return null
  }
  // Why undefined vs null: an absent `cloud` is a legacy local offer, while a
  // present but invalid one must fail closed rather than silently drop the ticket.
  const cloud = parseCloudBinding(readField(parsed, 'cloud'))
  if (cloud === null) {
    return null
  }
  const scope = parseWebPairingScope(readField(parsed, 'scope'))
  const pairedDeviceId = readString(parsed, 'pairedDeviceId')
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: normalizeWebSocketEndpoint(endpoint),
    deviceToken,
    publicKeyB64,
    ...(pairedDeviceId ? { pairedDeviceId } : {}),
    ...(scope ? { scope } : {}),
    ...(cloud ? { cloud } : {})
  }
}

/** `undefined` = absent, `null` = present but unusable. */
function parseCloudBinding(value: unknown): WebPairingCloudBinding | null | undefined {
  if (value === undefined) {
    return undefined
  }
  const credential = readString(value, 'credential')
  const devicePublicKey = readString(value, 'devicePublicKeyB64')
  // The credential travels in a comma-separated header: whitespace/commas would
  // corrupt the token list instead of being interpreted.
  if (!credential || !isSubprotocolSafe(credential) || devicePublicKey === null) {
    return null
  }
  const devicePublicKeyB64 = normalizeDevicePublicKeyBase64(devicePublicKey)
  return devicePublicKeyB64 === null ? null : { credential, devicePublicKeyB64 }
}

function isSubprotocolSafe(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || character === ',') {
      return false
    }
  }
  return true
}

/**
 * Browsers can only set the protocol list, so a cloud offer's device key rides as
 * `orca-device.<base64url>` next to the credential. A plain offer keeps today's
 * protocol-less socket.
 */
export function webRuntimeSubprotocols(offer: WebPairingOffer): string[] | null {
  const cloud = offer.cloud
  if (!cloud) {
    return null
  }
  return [
    RUNTIME_PROTOCOL,
    `${CREDENTIAL_PROTOCOL_PREFIX}${cloud.credential}`,
    `${DEVICE_PROTOCOL_PREFIX}${devicePublicKeyToBase64Url(cloud.devicePublicKeyB64)}`
  ]
}

function devicePublicKeyToBase64Url(publicKeyB64: string): string {
  const canonical = normalizeDevicePublicKeyBase64(publicKeyB64)
  if (canonical === null) {
    throw new WebPairingCloudKeyError(
      'Cloud pairing device public key must be a 32-byte base64 key.'
    )
  }
  return canonical.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Accepts standard base64 or base64url, returns canonical standard base64. */
function normalizeDevicePublicKeyBase64(value: string): string | null {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/')
  if (!STANDARD_BASE64.test(standard)) {
    return null
  }
  const unpadded = standard.replace(/=+$/, '')
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  let binary: string
  try {
    binary = globalThis.atob(padded)
  } catch {
    return null
  }
  if (binary.length !== DEVICE_PUBLIC_KEY_BYTES) {
    return null
  }
  let canonical: string
  try {
    canonical = globalThis.btoa(binary)
  } catch {
    return null
  }
  // Why round-trip: atob accepts non-canonical trailing bits, but the host's
  // base64url re-encode comparison rejects them.
  return canonical === padded ? canonical : null
}

function parseWebPairingScope(value: unknown): DeviceScope | null {
  return value === 'mobile' || value === 'runtime' ? value : null
}

function extractPairingCodeFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // Why: prefix checks accepted routes like `orca://pairing?...`; only the
  // pairing deep-link host may carry runtime auth material.
  if (parsed.protocol !== 'orca:' || parsed.hostname !== 'pair') {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null
  }
  const code = parsed.searchParams.get('code')
  if (code) {
    return code
  }
  return parsed.hash ? parsed.hash.slice(1) || null : null
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function normalizeWebSocketEndpoint(endpoint: string): string {
  if (endpoint.startsWith('http://')) {
    return `ws://${endpoint.slice('http://'.length)}`
  }
  if (endpoint.startsWith('https://')) {
    return `wss://${endpoint.slice('https://'.length)}`
  }
  return endpoint
}
