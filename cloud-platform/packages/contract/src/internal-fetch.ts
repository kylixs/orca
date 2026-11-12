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
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: options.headers as Record<string, string>,
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
    req.end()
  })
}
