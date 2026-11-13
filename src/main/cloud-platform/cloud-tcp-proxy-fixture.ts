import { createServer, connect, type Server, type Socket } from 'node:net'

/**
 * A pause-able TCP hop in front of the platform, so a test can cut the network
 * without stopping the platform and losing its in-memory sessions and grants.
 */

export type PausableProxy = {
  url: string
  /** Rejects new connections and drops live ones; the platform keeps running. */
  pause: () => void
  resume: () => void
}

export async function startPausableProxy(targetPort: number): Promise<PausableProxy> {
  let paused = false
  const live = new Set<Socket>()
  const server: Server = createServer((client) => {
    if (paused) {
      client.destroy()
      return
    }
    const upstream = connect(targetPort, '127.0.0.1')
    live.add(client)
    live.add(upstream)
    client.pipe(upstream).pipe(client)
    const drop = (): void => {
      live.delete(client)
      live.delete(upstream)
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', () => {
      drop()
      upstream.destroy()
    })
    upstream.on('close', () => {
      drop()
      client.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    pause: () => {
      paused = true
      for (const socket of live) {
        socket.destroy()
      }
      live.clear()
    },
    resume: () => {
      paused = false
    }
  }
}

export type RecordingProxy = {
  url: string
  totalBytes: () => number
  /** Every byte the hop carried, both directions, concatenated. */
  captured: () => Buffer
  close: () => Promise<void>
}

/**
 * Records everything that crosses the platform hop, so a test can prove a
 * session's payload never did — and, with a marker sent on purpose, that the
 * recording itself would have caught it.
 */
export async function startRecordingProxy(
  // A getter lets the proxy exist before the runtime it forwards to has a port.
  targetPort: number | (() => number)
): Promise<RecordingProxy> {
  const chunks: Buffer[] = []
  let size = 0
  const server: Server = createServer((client) => {
    const upstream = connect(
      typeof targetPort === 'number' ? targetPort : targetPort(),
      '127.0.0.1'
    )
    const record = (chunk: Buffer): void => {
      chunks.push(chunk)
      size += chunk.length
    }
    client.on('data', record)
    upstream.on('data', record)
    client.pipe(upstream).pipe(client)
    const drop = (): void => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    totalBytes: () => size,
    captured: () => Buffer.concat(chunks),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
