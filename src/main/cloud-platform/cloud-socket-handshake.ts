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
  onClose: (code: number, reason: string) => void
}

export type CloudSocket = {
  mux: CloudRpcMultiplexer
  /** The device the host's ticket bound this socket to. */
  ticketDevicePubKey: string | null
  /** A caller-side refusal (e.g. a changed host key) must reach the peer as a close code. */
  close: (code?: number, reason?: string) => void
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
