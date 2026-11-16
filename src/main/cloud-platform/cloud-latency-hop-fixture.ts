import { createServer, connect, type Server, type Socket } from 'node:net'

/**
 * A TCP hop whose runtime→client direction can be delayed, so a latency test can
 * prove it measures the path instead of a hard-coded number. Relay targets go
 * through it in the terminal latency test; delay 0 is a plain pass-through.
 */

export type LatencyHop = {
  url: string
  setDelayMs: (ms: number) => void
  close: () => Promise<void>
}

export async function startLatencyHop(targetPort: number | (() => number)): Promise<LatencyHop> {
  let delayMs = 0
  // Why: server.close() waits for open sockets; tracking them lets close() cut a
  // lingering proxied session instead of hanging the hook for 60s.
  const sockets = new Set<Socket>()
  const server: Server = createServer((client) => {
    const upstream = connect(
      typeof targetPort === 'number' ? targetPort : targetPort(),
      '127.0.0.1'
    )
    sockets.add(client)
    sockets.add(upstream)
    client.pipe(upstream)
    upstream.on('data', (chunk: Buffer) => {
      // Why pause: with a delay the write must happen after the timer, and pausing
      // keeps later chunks from overtaking this one.
      if (delayMs === 0) {
        client.write(chunk)
        return
      }
      upstream.pause()
      setTimeout(() => {
        client.write(chunk)
        upstream.resume()
      }, delayMs)
    })
    const drop = (): void => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', () => {
      sockets.delete(client)
      upstream.destroy()
    })
    upstream.on('close', () => {
      sockets.delete(upstream)
      client.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    setDelayMs: (ms) => {
      delayMs = ms
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy()
        }
        sockets.clear()
        server.close(() => resolve())
      })
  }
}
