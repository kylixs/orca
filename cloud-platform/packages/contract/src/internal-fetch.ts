import { readFileSync } from 'node:fs'
import { request } from 'node:https'

export type MtlsClientConfig = {
  internalUrl: string
  keyPath?: string
  certPath?: string
  caPath?: string
  token: string
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('request aborted')
}

/**
 * node:https needs concrete bytes; dropping the body would turn every POST into
 * an empty one (U43), and an unknown streaming body must fail loudly, not become
 * an empty request.
 */
async function toRequestBody(body: RequestInit['body']): Promise<Uint8Array | undefined> {
  if (body == null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (body instanceof DataView) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  throw new TypeError('mtlsFetch only supports string/buffer request bodies on its TLS path')
}

/** Adds Content-Length for a written body unless the caller pinned framing. */
function withFraming(
  headers: Record<string, string>,
  bodyBytes: Uint8Array | undefined
): Record<string, string> {
  if (!bodyBytes) return headers
  const pinned = Object.keys(headers).some((name) => {
    const lower = name.toLowerCase()
    if (lower === 'content-length') return true
    return lower === 'transfer-encoding' && headers[name].toLowerCase().includes('chunked')
  })
  if (!pinned) headers['content-length'] = String(bodyBytes.byteLength)
  return headers
}

/**
 * Fetches a control-plane resource over mTLS. Kept dependency-free so the
 * relay and runtime can share it without pulling in a TLS stack.
 *
 * Honours `init.signal` for both transports: a hung control plane must free
 * the socket, not just reject the caller's promise (review-06 N3).
 */
export async function mtlsFetch(
  config: MtlsClientConfig,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const usesTls = config.internalUrl.startsWith('https:')
  const options: RequestInit = {
    ...init,
    headers: {
      'x-internal-token': config.token,
      ...(init.headers ?? {})
    }
  }
  if (!usesTls) return fetch(`${config.internalUrl}${path}`, options)

  const signal = init.signal ?? null
  if (signal?.aborted) throw abortReason(signal)

  // node:https does not accept RequestInit; use the dispatcher-free https module.
  const { request } = await import('node:https')
  const { readFileSync } = await import('node:fs')
  const url = new URL(`${config.internalUrl}${path}`)
  const bodyBytes = await toRequestBody(init.body)
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: withFraming(options.headers as Record<string, string>, bodyBytes),
        key: config.keyPath ? readFileSync(config.keyPath) : undefined,
        cert: config.certPath ? readFileSync(config.certPath) : undefined,
        ca: config.caPath ? readFileSync(config.caPath) : undefined,
        servername: url.hostname,
        rejectUnauthorized: true
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          cleanup()
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers: res.headers as Record<string, string>
            })
          )
        })
        // Headers arrived but the body stalled: an abort must settle the promise
        // too, otherwise the single-flight refresh would stay pending forever.
        res.on('error', (err) => {
          cleanup()
          reject(err)
        })
        res.on('aborted', () => {
          cleanup()
          reject(new Error('response aborted'))
        })
      }
    )
    const onAbort = (): void => {
      if (signal) req.destroy(abortReason(signal))
    }
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err) => {
      cleanup()
      reject(err)
    })
    if (bodyBytes) req.write(bodyBytes)
    req.end()
  })
}
