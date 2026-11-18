import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * U258/U264: an unread body above this declared size is never drained to keep a
 * connection alive. Chunked framing hides its size, so it is drained under a
 * bounded budget instead — a small chunked refusal keeps keep-alive.
 *
 * A pre-read refusal cannot know whether it is discarding a legal command:
 * register accepts 64 KiB and heartbeat 1 MiB. Closing is still safe because a
 * legal caller reads its body before answering; only the refused connection is
 * lost.
 */
export const UNREAD_BODY_CLOSE_BYTES = 16 * 1024
export const CHUNKED_DRAIN_LIMIT_BYTES = 16 * 1024
export const CHUNKED_DRAIN_TIMEOUT_MS = 250

const bodyReadRequests = new WeakSet<IncomingMessage>()
const policyInstalled = new WeakSet<ServerResponse>()

/** Marks a request whose body a handler consumed; its body must not be closed. */
export function markRequestBodyRead(req: IncomingMessage): void {
  bodyReadRequests.add(req)
}

/** Whether this response would leave a large, unread request body for Node to drain. */
export function leavesUnreadLargeBody(req: IncomingMessage | undefined): boolean {
  if (req === undefined || bodyReadRequests.has(req)) return false
  const declared = Number(req.headers['content-length'])
  return Number.isFinite(declared) && declared > UNREAD_BODY_CLOSE_BYTES
}

/**
 * U264: consume what is already in flight so a small chunked body keeps the
 * connection, and destroy instead of draining an unknown (possibly endless)
 * stream past the bound.
 */
function boundUnreadChunkedBody(req: IncomingMessage): void {
  if (req.complete || bodyReadRequests.has(req)) return
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
 * U264: the one decision for an exit that leaves the body unread, applied by
 * the `writeHead` wrapper so static files, OPTIONS, 404s and mTLS refusals all
 * obey it. A request whose body was already read is exempt.
 */
export function applyUnreadBodyPolicy(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent || bodyReadRequests.has(req)) return
  if (leavesUnreadLargeBody(req)) {
    res.setHeader('connection', 'close')
    return
  }
  if (req.headers['transfer-encoding'] !== undefined) boundUnreadChunkedBody(req)
}

/** U264: wrap `writeHead` once per response so no bare exit can skip the rule. */
export function installUnreadBodyPolicy(res: ServerResponse, req: IncomingMessage): void {
  if (policyInstalled.has(res)) return
  policyInstalled.add(res)
  const writeHead = res.writeHead.bind(res)
  // SAFETY: the wrapper accepts and forwards exactly the arguments Node passes
  // to the overloaded `writeHead`; the cast only restores that overload type.
  res.writeHead = ((...args: Parameters<typeof writeHead>) => {
    applyUnreadBodyPolicy(req, res)
    return writeHead(...args)
  }) as ServerResponse['writeHead']
}
