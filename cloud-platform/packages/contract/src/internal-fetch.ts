import { readFileSync } from 'node:fs'
import { request } from 'node:https'

export type MtlsClientConfig = {
  internalUrl: string
  keyPath?: string
  certPath?: string
  caPath?: string
  token: string
}

/**
 * Fetches a control-plane resource over mTLS. Kept dependency-free so the
 * relay and runtime can share it without pulling in a TLS stack.
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
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 500,
              headers: res.headers as Record<string, string>
            })
          )
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}
