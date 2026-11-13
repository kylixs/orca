import WebSocket from 'ws'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../shared/agent-launch-runtime-capability'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../shared/agent-session-optional-model-capability'
import {
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { decrypt, deriveSharedKey, encrypt } from '../../shared/e2ee-crypto'
import { parseJsonText, readString } from '../../shared/json-fields'
import type { CloudEndpoint, CloudConnectTicket, CloudDeviceKeyPair } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'
import { CloudRpcMultiplexer } from './cloud-rpc-multiplexer'
import { derCertificateFingerprint, isSha256Fingerprint } from './cloud-host-tls'

/** Probe→ticket→upgrade→E2EE: the socket half of a cloud project connection. */

/**
 * What this client tells a cloud runtime it can render on a launched surface.
 *
 * `agent.launch.v2`: the desktop shell behind this transport reads either outcome — a structured
 * chat it opens, or a terminal agent. It can only open one if it also advertises the structured
 * read surface, otherwise a structured outcome arrives with no way to read it. The replay and
 * prompt-carry capabilities are a separate contract this transport does not negotiate, so it must
 * not claim them for the host.
 */
export const CLOUD_RUNTIME_CLIENT_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
] as const

export type CloudSocketInput = {
  endpoint: CloudEndpoint
  ticket: CloudConnectTicket
  devicePubKeyB64: string
  deviceKeys: CloudDeviceKeyPair
  tlsRejectUnauthorized: boolean
  /**
   * The TLS certificate the platform says this host serves, compared against the
   * live certificate after the handshake. With self-signed hosts
   * `rejectUnauthorized` is off — and Node then skips `checkServerIdentity` — so
   * this comparison is what makes the platform's `tlsFingerprint` mean anything.
   */
  expectedTlsFingerprint?: string
  onClose: (code: number, reason: string) => void
}

export type CloudSocket = {
  mux: CloudRpcMultiplexer
  /** The device the host's ticket bound this socket to. */
  ticketDevicePubKey: string | null
  /** A caller-side refusal (e.g. a changed host key) must reach the peer as a close code. */
  close: (code?: number, reason?: string) => void
}

/** The live certificate's DER, via the socket the ws types keep private. */
function peerCertificateRaw(websocket: unknown): Buffer | undefined {
  if (websocket === null || typeof websocket !== 'object') {
    return undefined
  }
  const socket: unknown = Reflect.get(websocket, '_socket')
  if (socket === null || typeof socket !== 'object') {
    return undefined
  }
  const getPeerCertificate = Reflect.get(socket, 'getPeerCertificate')
  if (typeof getPeerCertificate !== 'function') {
    return undefined
  }
  try {
    const cert: unknown = Reflect.apply(getPeerCertificate, socket, [])
    if (cert === null || typeof cert !== 'object') {
      return undefined
    }
    const raw = Reflect.get(cert, 'raw')
    return raw instanceof Buffer ? raw : undefined
  } catch {
    // A socket whose handshake never settled has no certificate to compare.
    return undefined
  }
}

export function upgradeCloudSocket(input: CloudSocketInput): Promise<CloudSocket> {
  const { endpoint, ticket, deviceKeys } = input
  const wsOptions: WebSocket.ClientOptions = {
    headers: { 'x-orca-device-pubkey': input.devicePubKeyB64 },
    rejectUnauthorized: input.tlsRejectUnauthorized
  }
  if (endpoint.sni) {
    // ws forwards unknown options to tls.connect, where SNI is `servername`.
    Object.assign(wsOptions, { servername: endpoint.sni })
  }
  return new Promise<CloudSocket>((resolve, reject) => {
    const ws = new WebSocket(
      endpoint.url,
      ['orca-runtime', `orca-cred.${ticket.credential}`],
      wsOptions
    )
    const ticketDevicePubKey = readTicketClaims(ticket.credential).devicePubKey
    let mux: CloudRpcMultiplexer | null = null
    const close = (code?: number, reason?: string): void => {
      mux?.close()
      if (code === undefined) {
        ws.close()
        return
      }
      ws.close(code, reason ?? '')
    }
    ws.once('unexpected-response', (_req, res) => {
      reject(
        Object.assign(new Error(`upgrade rejected: ${res.statusCode}`), {
          code: res.headers['x-orca-reject'] ?? 'UPGRADE_REJECTED',
          statusCode: res.statusCode
        })
      )
      ws.terminate()
    })
    ws.once('error', reject)
    ws.once('message', (readyRaw) => {
      const ready = parseJsonText(readyRaw.toString())
      if (readString(ready, 'type') !== 'e2ee_ready') {
        reject(new Error(`expected e2ee_ready, got ${JSON.stringify(ready)}`))
        ws.terminate()
        return
      }
      // The platform hands the host's E2EE key to the client with the ticket.
      const hostKey = Uint8Array.from(Buffer.from(ticket.host.e2eePublicKeyB64, 'base64'))
      if (hostKey.length !== 32) {
        // A host that has not reported its key yet cannot be talked to. Failing
        // here is honest; deriving with a short key throws inside ws's listener.
        reject(
          Object.assign(new Error('host E2EE key missing or malformed'), {
            code: 'HOST_KEY_INVALID'
          })
        )
        ws.terminate()
        return
      }
      const sharedKey = deriveSharedKey(deviceKeys.secretKey, hostKey)
      ws.once('message', (authRaw) => {
        const auth = parseJsonText(decrypt(authRaw.toString(), sharedKey) ?? '{}')
        if (readString(auth, 'type') !== 'e2ee_authenticated') {
          reject(new Error(`expected e2ee_authenticated, got ${JSON.stringify(auth)}`))
          ws.terminate()
          return
        }
        mux = new CloudRpcMultiplexer(ws, sharedKey)
        resolve({ mux, ticketDevicePubKey, close })
      })
      const claims = readTicketClaims(ticket.credential)
      ws.send(
        encrypt(
          JSON.stringify({
            type: 'e2ee_auth',
            deviceToken: claims?.deviceToken,
            clientCapabilities: CLOUD_RUNTIME_CLIENT_CAPABILITIES
          }),
          sharedKey
        )
      )
    })
    ws.once('open', () => {
      // Only the new `sha256:<hex>` form pins. Older platforms fill this field
      // with a legacy fallback name; enforcing against that would break them, so
      // they keep today's (CA-less) behavior — the mixed-version rule.
      const expected = isSha256Fingerprint(input.expectedTlsFingerprint)
        ? input.expectedTlsFingerprint
        : undefined
      if (endpoint.url.startsWith('wss:') && expected) {
        // Checked reads: the ws types do not expose the underlying socket, and a
        // plain `ws://` hop has no certificate to compare. Reflect.apply keeps the
        // TLSSocket as the receiver (getPeerCertificate reads `this._handle`).
        const raw = peerCertificateRaw(ws)
        if (raw === undefined) {
          reject(
            Object.assign(new Error('no peer certificate on a wss connection'), {
              code: 'TLS_CERTIFICATE_MISSING'
            })
          )
          ws.terminate()
          return
        }
        const seen = derCertificateFingerprint(raw)
        if (seen !== expected) {
          // Interrupt before any credential-derived byte leaves the client; the
          // platform named a different certificate than the one being served.
          reject(
            Object.assign(
              new Error(`host TLS certificate mismatch: expected ${expected}, saw ${seen}`),
              {
                code: 'TLS_FINGERPRINT_MISMATCH',
                expectedTlsFingerprint: expected,
                seenFingerprint: seen
              }
            )
          )
          ws.terminate()
          return
        }
      }
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(deviceKeys.publicKey).toString('base64')
        })
      )
    })
    ws.once('close', (code, reason) => input.onClose(code, reason.toString()))
  })
}
