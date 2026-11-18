import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { AuditChain } from '../../api/src/audit.ts'
import { createWriterLease } from './writer-lease.ts'
import { openAnchorStore, type AnchorStore } from './anchor.ts'
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
const DEFAULT_LEASE_TTL_MS = 3_000
/** Design §13.2: one signed anchor every five minutes. */
const DEFAULT_ANCHOR_INTERVAL_MS = 300_000

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

/**
 * U250: bound the append body. A legal batch holds up to MAX_BATCH events, so a
 * flat 4 KiB cap would reject the documented workload; 1 KiB per event stays
 * bounded while covering a full batch, and an oversized body is dropped whole.
 */
const APPEND_BODY_MAX_BYTES = MAX_BATCH * 1024

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  let oversized = false
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Keep draining an oversized body so the connection stays usable.
    if (size > APPEND_BODY_MAX_BYTES) {
      oversized = true
      chunks.length = 0
      continue
    }
    if (!oversized) chunks.push(buffer)
  }
  if (oversized || chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    // `null` and scalars have no fields, so treat them like an absent body.
    if (parsed === null || typeof parsed !== 'object') return {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: non-null object from JSON.parse is an array or plain object; callers only read properties.
    return parsed as Record<string, unknown>
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
  /** Standby pairing: a shared file only one writer may hold at a time. */
  leasePath?: string | null
  leaseTtlMs?: number
  holderId?: string
  /** Signed chain anchors; absent keeps the writer anchor-free (tests of the chain itself). */
  anchorPath?: string | null
  anchorKeyPath?: string | null
  anchorIntervalMs?: number
}): Promise<AuditWriter> {
  const store: WriterStore = { audit: [], auditSeq: 0, auditTip: 'GENESIS' }
  const log = options.logPath ? openAuditLogFile(options.logPath) : null
  const chain = new AuditChain(store, log?.append)
  const lease = options.leasePath
    ? createWriterLease({
        path: options.leasePath,
        holderId: options.holderId ?? `writer-${process.pid}`,
        ttlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
      })
    : null
  let leader = lease === null || lease.acquire()
  // Only the leader reads the log into the chain; a standby that restored early
  // would serve a tip that is already behind the leader's.
  if (leader && log) {
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

  const promoteTimer = lease
    ? setInterval(
        () => {
          if (leader) {
            // A promoted standby stamps its own id; the old holder must stop here.
            if (!lease.assertLeadership()) leader = false
            return
          }
          if (!lease.acquire()) return
          void serialize(() => {
            // Appends landed while this process was standby; re-read before taking over.
            if (log) chain.restore(log.load())
            leader = true
          })
        },
        Math.max(50, Math.floor((options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS) / 4))
      )
    : null

  const canAppend = (): boolean => leader && (lease === null || lease.assertLeadership())

  const anchors: AnchorStore | null =
    options.anchorPath && options.anchorKeyPath
      ? openAnchorStore({ path: options.anchorPath, keyPath: options.anchorKeyPath })
      : null

  /** One anchor per (advancing) tip; a quiet chain needs no new proof. */
  const anchorTip = (): void => {
    if (!anchors || !leader) return
    if (chain.size === 0 || chain.size <= anchors.lastSeq()) return
    anchors.append({ seq: chain.size, hash: chain.tip }, Date.now())
  }
  const anchorTimer = anchors
    ? setInterval(() => {
        // Why serialized: the timer must not read a tip an append is mid-way through.
        void serialize(() => anchorTip())
      }, options.anchorIntervalMs ?? DEFAULT_ANCHOR_INTERVAL_MS)
    : null
  anchorTimer?.unref?.()

  const append = (inputs: readonly AuditEventInput[]): Promise<AuditEvent[]> =>
    serialize(() => inputs.map((input) => chain.append(input)))

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => json(res, 500, { error: { code: 'INTERNAL_ERROR' } }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://writer')
    if (url.pathname === '/health') {
      return json(res, 200, {
        ...chain.getHealth(),
        role: leader ? 'leader' : 'standby',
        events: chain.size,
        tip: chain.tip
      })
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
      // A write failure is transient, so the append below is attempted instead:
      // a recovered disk heals without a writer restart.
      const health = chain.getHealth()
      if (!health.ok && health.reason === 'chain_broken') {
        return json(res, 503, { error: { code: 'AUDIT_CHAIN_BROKEN' } })
      }
      // Why a distinct code: the replica should fail over, not treat this as a
      // broken chain (which is global and must stop every writer).
      if (!canAppend()) {
        return json(res, 503, { error: { code: 'AUDIT_WRITER_STANDBY' } })
      }
      let appended: AuditEvent[]
      try {
        appended = await append(raw)
      } catch (error) {
        const failed = chain.getHealth()
        if (!failed.ok && failed.reason === 'write_failed') {
          // New code on the existing error.code field: old clients fall through
          // to AUDIT_UNAVAILABLE and retry instead of latching a broken chain.
          return json(res, 503, { error: { code: 'AUDIT_WRITE_FAILED' } })
        }
        throw error
      }
      return json(res, 200, { events: appended })
    }

    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const eventTypes = (url.searchParams.get('eventTypes') ?? '')
        .split(',')
        .map((type) => type.trim())
        .filter((type) => type !== '')
      const page = chain.query({
        actor: url.searchParams.get('actor') ?? undefined,
        eventType: url.searchParams.get('eventType') ?? undefined,
        eventTypes: eventTypes.length > 0 ? eventTypes : undefined,
        result: url.searchParams.get('result') ?? undefined,
        traceId: url.searchParams.get('traceId') ?? undefined,
        since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined,
        until: url.searchParams.get('until') ? Number(url.searchParams.get('until')) : undefined,
        fileName: url.searchParams.get('fileName') ?? undefined,
        keyword: url.searchParams.get('q') ?? url.searchParams.get('keyword') ?? undefined,
        username: url.searchParams.get('username') ?? undefined,
        projectId: url.searchParams.get('projectId') ?? undefined,
        hostId: url.searchParams.get('hostId') ?? undefined,
        limit: Math.min(Number(url.searchParams.get('limit') ?? 50), 200),
        cursor: url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : undefined
      })
      return json(res, 200, page)
    }

    if (req.method === 'GET' && url.pathname === '/v1/summary') {
      return json(res, 200, chain.summary())
    }

    if (req.method === 'GET' && url.pathname === '/v1/anchors') {
      return json(res, 200, {
        publicKeyPem: anchors?.key.publicKeyPem ?? null,
        anchors: anchors?.list() ?? []
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/anchors') {
      const appended = await serialize(() => {
        anchorTip()
        return anchors?.list().at(-1) ?? null
      })
      return json(res, 200, { anchor: appended })
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
    close: () =>
      new Promise<void>((resolve) => {
        if (promoteTimer) clearInterval(promoteTimer)
        if (anchorTimer) clearInterval(anchorTimer)
        lease?.release()
        server.close(() => resolve())
      })
  }
}

// Why the path check: the same file is imported by tests, where argv[1] is the runner.
const isMain = process.argv[1]?.includes('audit-writer') === true
if (isMain) {
  const writer = await startAuditWriter({
    port: Number(process.env.PORT ?? 18788),
    internalToken: process.env.INTERNAL_TOKEN ?? 'internal-test-token',
    logPath: process.env.AUDIT_LOG_PATH ?? null,
    leasePath: process.env.AUDIT_LEASE_PATH ?? null,
    leaseTtlMs: process.env.AUDIT_LEASE_TTL_MS ? Number(process.env.AUDIT_LEASE_TTL_MS) : undefined,
    holderId: process.env.WRITER_ID,
    anchorPath: process.env.AUDIT_ANCHOR_PATH ?? null,
    anchorKeyPath: process.env.AUDIT_ANCHOR_KEY_PATH ?? null,
    anchorIntervalMs: process.env.AUDIT_ANCHOR_INTERVAL_MS
      ? Number(process.env.AUDIT_ANCHOR_INTERVAL_MS)
      : undefined
  })
  console.log(`[audit-writer] listening on http://127.0.0.1:${writer.port}`)
}
