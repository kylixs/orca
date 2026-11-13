import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'

/**
 * Stand-in for the Orca host's TLS listener, spawned as its own process so the
 * relay's forwarding tests observe a real hop. HTTP answers echo back the path,
 * method, body and proxy headers the host actually received; WSS echoes frames.
 */
const server = createServer(
  {
    key: readFileSync(process.env.TLS_KEY ?? ''),
    cert: readFileSync(process.env.TLS_CERT ?? '')
  },
  (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          path: req.url,
          method: req.method,
          body: Buffer.concat(chunks).toString('utf8'),
          forwarded: {
            for: req.headers['x-forwarded-for'] ?? null,
            proto: req.headers['x-forwarded-proto'] ?? null,
            host: req.headers['x-forwarded-host'] ?? null
          }
        })
      )
    })
  }
)

const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  ws.send('w6a-host-ok')
  ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
})

const port = Number(process.env.PORT ?? 0)
server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  const bound = typeof address === 'object' && address ? address.port : port
  console.log(`[relay-target-host] listening on :${bound}`)
})
