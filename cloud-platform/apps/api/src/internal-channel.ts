import { createServer as createHttpsServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { TLSSocket } from 'node:tls'

export type { MtlsClientConfig } from '../../../packages/contract/src/internal-fetch.ts'
export { mtlsFetch } from '../../../packages/contract/src/internal-fetch.ts'

export type InternalChannelOptions = {
  port: number
  keyPath: string
  certPath: string
  /** CA used to verify client certificates (mTLS). */
  caPath: string
  /** Allowed client certificate subjects; empty means "any cert from the CA". */
  allowedCNs?: string[]
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

export type InternalChannel = {
  port: number
  close: () => Promise<void>
}

const UNREAD_BODY_CLOSE_BYTES = 16 * 1024
const CHUNKED_DRAIN_LIMIT_BYTES = 16 * 1024
const CHUNKED_DRAIN_TIMEOUT_MS = 250

/**
 * U264: mirrors the public listener's pre-read rule (server.ts `applyUnreadBodyPolicy`).
 * These refusals happen before the handler runs, so the body is always unread.
 */
function closeUnreadBody(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent) return
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared)) {
    if (declared > UNREAD_BODY_CLOSE_BYTES) res.setHeader('connection', 'close')
    return
  }
  if (req.headers['transfer-encoding'] === undefined || req.complete) return
  let drained = 0
  let done = false
  const finish = (destroy: boolean): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    req.off('data', onData)
    req.off('end', onEnd)
    req.off('error', onError)
    if (destroy) req.destroy()
    else req.resume()
  }
  const onData = (chunk: Buffer): void => {
    drained += chunk.length
    if (drained > CHUNKED_DRAIN_LIMIT_BYTES) finish(true)
  }
  const onEnd = (): void => finish(false)
  const onError = (): void => finish(false)
  const timer = setTimeout(() => finish(true), CHUNKED_DRAIN_TIMEOUT_MS)
  req.on('data', onData)
  req.on('end', onEnd)
  req.on('error', onError)
  req.resume()
}

/**
 * Dedicated HTTPS listener for platform → relay/runtime control traffic.
 * Requires a client certificate signed by the internal CA: the shared bearer
 * token alone is not sufficient for these routes (design §5.1, §14.5).
 */
export async function startInternalChannel(
  options: InternalChannelOptions
): Promise<InternalChannel> {
  const server: Server = createHttpsServer(
    {
      key: readFileSync(options.keyPath),
      cert: readFileSync(options.certPath),
      ca: readFileSync(options.caPath),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    },
    (req, res) => {
      const socket = req.socket as TLSSocket
      if (!socket.authorized) {
        // Covers missing cert and certs signed by an unknown CA.
        closeUnreadBody(req, res)
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ error: { code: 'MTLS_REQUIRED', message: '需要有效的客户端证书。' } })
        )
        return
      }
      const subject = socket.getPeerCertificate?.()
      const cn = subject?.subject?.CN ?? ''
      if (options.allowedCNs && options.allowedCNs.length > 0 && !options.allowedCNs.includes(cn)) {
        closeUnreadBody(req, res)
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { code: 'MTLS_CN_NOT_ALLOWED', message: '客户端证书未被授权。' }
          })
        )
        return
      }
      options.handler(req, res).catch(() => {
        closeUnreadBody(req, res)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }))
      })
    }
  )
  // Reject the TLS handshake when the peer presents no certificate at all.
  server.on('tlsClientError', () => undefined)

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
