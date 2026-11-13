import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/**
 * Shared login-lockout counter (AC-02 under multi-replica deployment).
 *
 * Each API replica used to count failures in its own memory, so five wrong
 * passwords spread over three replicas never locked the account. The counter is
 * trivially small and must agree everywhere, so it lives in one process the
 * replicas call — the same shape as the audit writer.
 */

export const MAX_FAILURES = 5
export const LOCK_MS = 15 * 60_000

export type LockoutState = { locked: boolean; remaining: number; lockedUntil: number }

export type LockoutStore = {
  /** Records one failed attempt; the fifth locks the account. */
  recordFailure: (username: string, nowMs: number) => LockoutState
  isLocked: (username: string, nowMs: number) => LockoutState
  /** A successful login clears the counter. */
  clear: (username: string) => void
  size: () => number
}

export function createLockoutStore(): LockoutStore {
  const attempts = new Map<string, { count: number; lockedUntil: number }>()

  const stateOf = (username: string, nowMs: number): LockoutState => {
    const record = attempts.get(username)
    if (!record) {
      return { locked: false, remaining: MAX_FAILURES, lockedUntil: 0 }
    }
    if (record.lockedUntil > nowMs) {
      return { locked: true, remaining: 0, lockedUntil: record.lockedUntil }
    }
    // Why reset on read: an expired lock must not keep counting old failures.
    if (record.lockedUntil !== 0) {
      attempts.delete(username)
      return { locked: false, remaining: MAX_FAILURES, lockedUntil: 0 }
    }
    return { locked: false, remaining: MAX_FAILURES - record.count, lockedUntil: 0 }
  }

  return {
    recordFailure: (username, nowMs) => {
      const current = stateOf(username, nowMs)
      if (current.locked) {
        return current
      }
      const record = attempts.get(username) ?? { count: 0, lockedUntil: 0 }
      record.count += 1
      if (record.count >= MAX_FAILURES) {
        record.lockedUntil = nowMs + LOCK_MS
        record.count = 0
      }
      attempts.set(username, record)
      return stateOf(username, nowMs)
    },
    isLocked: (username, nowMs) => stateOf(username, nowMs),
    clear: (username) => {
      attempts.delete(username)
    },
    size: () => attempts.size
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(createHash('sha256').update(a).digest('hex'))
  const right = Buffer.from(createHash('sha256').update(b).digest('hex'))
  return timingSafeEqual(left, right)
}

export type LockoutService = {
  port: number
  store: LockoutStore
  close: () => Promise<void>
}

export async function startLockoutService(options: {
  port: number
  internalToken: string
  now?: () => number
}): Promise<LockoutService> {
  const now = options.now ?? (() => Date.now())
  const store = createLockoutStore()
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => json(res, 500, { error: { code: 'INTERNAL_ERROR' } }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://lockout')
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, accounts: store.size() })
    }
    const offered = req.headers['x-internal-token']
    if (typeof offered !== 'string' || !safeEqual(offered, options.internalToken)) {
      return json(res, 401, { error: { code: 'UNAUTHORIZED' } })
    }
    // A GET carries the name in the query, a POST in the body.
    const body = req.method === 'GET' ? {} : await readJson(req)
    const fromQuery = url.searchParams.get('username')
    const username =
      fromQuery ?? (typeof body.username === 'string' ? body.username : '')
    if (username === '') {
      return json(res, 400, { error: { code: 'USERNAME_REQUIRED' } })
    }
    if (req.method === 'POST' && url.pathname === '/v1/failure') {
      return json(res, 200, store.recordFailure(username, now()))
    }
    if (req.method === 'GET' && url.pathname === '/v1/state') {
      return json(res, 200, store.isLocked(username, now()))
    }
    if (req.method === 'POST' && url.pathname === '/v1/clear') {
      store.clear(username)
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: { code: 'NOT_FOUND' } })
  }

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    port,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// Why the path check: the same file is imported by tests, where argv[1] is the runner.
const isMain = process.argv[1]?.includes('login-lockout') === true
if (isMain) {
  const service = await startLockoutService({
    port: Number(process.env.PORT ?? 18789),
    internalToken: process.env.INTERNAL_TOKEN ?? 'internal-test-token'
  })
  console.log(`[login-lockout] listening on http://127.0.0.1:${service.port}`)
}
