import { readField, readString } from './json-fields'
import { parseRemoteRuntimeJsonText } from './remote-runtime-request-frames'

export type RemoteRuntimeHandshakeState = 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

export type RemoteRuntimeAuthenticatedFrame =
  | { kind: 'authenticated' }
  /** `reason` is the host's `e2ee_error` code, when it named one. */
  | { kind: 'rejected'; unauthorized: boolean; reason: string | null }
  | { kind: 'invalid' }

export function classifyRemoteRuntimeReadyFrame(frame: string): 'ready' | 'invalid' | 'unexpected' {
  let ready: unknown
  try {
    ready = parseRemoteRuntimeJsonText(frame)
  } catch {
    return 'invalid'
  }
  return typeof ready === 'object' &&
    ready !== null &&
    (ready as { type?: unknown }).type === 'e2ee_ready'
    ? 'ready'
    : 'unexpected'
}

export function parseRemoteRuntimeAuthenticatedFrame(
  plaintext: string
): RemoteRuntimeAuthenticatedFrame {
  let authenticated: unknown
  try {
    authenticated = parseRemoteRuntimeJsonText(plaintext)
  } catch {
    return { kind: 'invalid' }
  }
  if (readString(authenticated, 'type') === 'e2ee_authenticated') {
    return { kind: 'authenticated' }
  }
  const errorCode = readString(readField(authenticated, 'error'), 'code')
  return {
    kind: 'rejected',
    unauthorized: errorCode === 'unauthorized',
    reason: typeof errorCode === 'string' ? errorCode : null
  }
}

/** Why the host refused: its own code when it sent one, the generic wording otherwise. */
export function remoteRuntimeAuthRejectionMessage(
  rejection: Extract<RemoteRuntimeAuthenticatedFrame, { kind: 'rejected' }>
): string {
  const base = 'Remote Orca runtime rejected the pairing token.'
  if (rejection.reason === 'device_proof_failed') {
    return `${base} It presented a different device key than the cloud ticket names.`
  }
  return rejection.reason && rejection.reason !== 'unauthorized'
    ? `${base} The host reported: ${rejection.reason}.`
    : base
}

export function formatRemoteRuntimeCloseMessage(code: number, reason: Buffer): string {
  const suffixParts: string[] = []
  if (code !== 1005 && code !== 1006) {
    suffixParts.push(String(code))
  }
  const reasonText = reason.toString().trim()
  if (reasonText) {
    suffixParts.push(reasonText)
  }
  return suffixParts.length > 0
    ? `Remote Orca runtime closed the connection (${suffixParts.join(': ')}).`
    : 'Remote Orca runtime closed the connection.'
}

export function ignoreSettledRemoteRuntimeSocketError(): void {}
