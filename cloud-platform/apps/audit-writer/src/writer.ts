import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { AuditChain } from '../../api/src/audit.ts'
import { openAuditLogFile } from '../../api/src/audit-log-file.ts'
import type { AuditEvent, AuditEventInput } from '../../api/src/store.ts'

/**
 * The single audit writer (design §3: `orca-cloud-audit-writer`, single instance).
 *
 * Every API replica posts here instead of appending to its own chain, so `seq`
 * and `prevHash` are assigned by one process and the chain cannot fork across
 * replicas. Batches are appended atomically: within one request nothing else
 * interleaves, which is what makes concurrent replicas safe without a lock.
 */

const MAX_BATCH = 1000

type WriterStore = { audit: AuditEvent[]; auditSeq: number; auditTip: string }

export type AuditWriter = {
  port: number
  append: (inputs: readonly AuditEventInput[]) => Promise<AuditEvent[]>
  close: () => Promise<void>
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

function isAuditInput(value: unknown): value is AuditEventInput {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.eventType === 'string' &&
    entry.eventType.length > 0 &&
    typeof entry.result === 'string' &&
    (entry.actor === null || typeof entry.actor === 'string') &&
    (entry.targetType === null || typeof entry.targetType === 'string') &&
    (entry.targetId === null || typeof entry.targetId === 'string') &&
    (entry.traceId === null || typeof entry.traceId === 'string')
  )
}

export async function startAuditWriter(options: {
  port: number
  internalToken: string
  logPath?: string | null
}): Promise<AuditWriter> {
  const store: WriterStore = { audit: [], auditSeq: 0, auditTip: 'GENESIS' }
  const log = options.logPath ? openAuditLogFile(options.logPath) : null
  const chain = new AuditChain(store, log?.append)
  if (log) {
    chain.restore(log.load())
  }
  // Why a promise chain: Node may start the next request before the previous
  // append resolves, which would let two batches read the same tip.
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => T | Promise<T>): Promise<T> => {
    const next = tail.then(task, task)
    tail = next.catch(() => undefined)
    return next
  }

  const append = (inputs: readonly AuditEventInput[]): Promise<AuditEvent[]> =>
    serialize(() => inputs.map((input) => chain.append(input)))

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => json(res, 500, { error: { code: 'INTERNAL_ERROR' } }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://writer')
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, events: chain.size, tip: chain.tip })
    }
    const offered = req.headers['x-internal-token']
    if (typeof offered !== 'string' || !safeEqual(offered, options.internalToken)) {
      return json(res, 401, { error: { code: 'UNAUTHORIZED' } })
    }

    if (req.method === 'POST' && url.pathname === '/v1/append') {
      const body = await readJson(req)
      const raw = body.events
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH) {
        return json(res, 400, { error: { code: 'BATCH_INVALID', max: MAX_BATCH } })
      }
      if (!raw.every(isAuditInput)) {
        return json(res, 400, { error: { code: 'EVENT_INVALID' } })
      }
      // Why refuse at the source: once the chain is broken, every replica must
      // stop minting grants, not just the one that noticed (AC-26 fail-closed).
      // Why refuse at the source: once the chain is broken, every replica must
      // stop minting grants, not just the one that noticed (AC-26 fail-closed).
      if (!chain.getHealth().ok) {
        return json(res, 503, { error: { code: 'AUDIT_CHAIN_BROKEN' } })
      }
      const appended = await append(raw)
      return json(res, 200, { events: appended })
    }

    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const page = chain.query({
        actor: url.searchParams.get('actor') ?? undefined,
        eventType: url.searchParams.get('eventType') ?? undefined,
        result: url.searchParams.get('result') ?? undefined,
        since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined,
        limit: Math.min(Number(url.searchParams.get('limit') ?? 50), 200),
        cursor: url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : undefined
      })
      return json(res, 200, page)
    }

    if (req.method === 'GET' && url.pathname === '/v1/verify') {
      return json(res, 200, { ...chain.verify(), size: chain.size, tip: chain.tip })
    }

    if (req.method === 'GET' && url.pathname === '/v1/status') {
      return json(res, 200, { ...chain.getHealth(), size: chain.size, tip: chain.tip })
    }

    return json(res, 404, { error: { code: 'NOT_FOUND' } })
  }

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  return {
    port,
    append,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// Why the path check: the same file is imported by tests, where argv[1] is the runner.
const isMain = process.argv[1]?.includes('audit-writer') === true
if (isMain) {
  const writer = await startAuditWriter({
    port: Number(process.env.PORT ?? 18788),
    internalToken: process.env.INTERNAL_TOKEN ?? 'internal-test-token',
    logPath: process.env.AUDIT_LOG_PATH ?? null
  })
  console.log(`[audit-writer] listening on http://127.0.0.1:${writer.port}`)
}
