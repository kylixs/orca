import WebSocket from 'ws'
import { decrypt, deriveSharedKey, encrypt } from '../../shared/e2ee-crypto'
import { parseJsonText, readString } from '../../shared/json-fields'
import type { CloudEndpoint, CloudConnectTicket, CloudDeviceKeyPair } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'
import { CloudRpcMultiplexer } from './cloud-rpc-multiplexer'

/** Probe→ticket→upgrade→E2EE: the socket half of a cloud project connection. */

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
  close: () => void
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
    const close = (): void => {
      mux?.close()
      ws.close()
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
        encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: claims?.deviceToken }), sharedKey)
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
