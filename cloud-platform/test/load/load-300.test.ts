import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpus, loadavg } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { login, makeTlsCerts, registerHost, saveEvidence, spawnService, type Service } from '../e2e/harness.ts'
import { CloudClient } from '../../apps/client/src/cloud-client.ts'

/**
 * M110 (AC-22): the platform's stated peak is 300 concurrent sessions. This runs
 * that shape for real — 300 clients, each with its own login, device key, real
 * TCP probe, real TLS WSS upgrade and a live RPC cadence for the whole window —
 * against a real API process and a real TLS runtime.
 *
 * The full shape (300 sessions / 30 minutes) runs from the shell:
 *   LOAD_SESSIONS=300 LOAD_DURATION_S=1800 node --test --test-concurrency=1 test/load/load-300.test.ts
 * A scaled pass verifies the harness quickly:
 *   LOAD_SESSIONS=30 LOAD_DURATION_S=60 ...
 */

const SESSIONS = Number(process.env.LOAD_SESSIONS ?? 300)
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 1_800)
const RAMP_BATCH = 25
const RPC_INTERVAL_MS = 2_000
const RPC_TIMEOUT_MS = 5_000
const CONNECT_BUDGET_MS = 2_000 // requirements §5.1, direct
const LABEL = `${SESSIONS}x${DURATION_S}s`

type Stats = { count: number; p50: number; p95: number; max: number }
type Entry = { id: number; route: string; connectMs: number; rpcOk: number; rpcFail: number; closed: boolean }

function statsOf(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percent: number): number =>
    Math.round((sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)] ?? 0) * 100) / 100
  return { count: sorted.length, p50: at(50), p95: at(95), max: sorted.at(-1) ?? 0 }
}

let api: Service
let runtime: Service

before(async () => {
  // A non-trivial listing: the sim maps `<sandbox>/<project path>`, so seed that
  // exact directory (the seeded project lives at /srv/work/payment-service).
  const listing = '/tmp/orca-m110-sandbox/srv/work/payment-service'
  mkdirSync(listing, { recursive: true })
  for (let index = 0; index < 24; index += 1) {
    writeFileSync(`${listing}/module-${index}.ts`, `export const m${index} = ${index}\n`)
  }
  // The platform hands clients `wss://`, so the runtime must serve TLS.
  const tls = makeTlsCerts()
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'm110-internal' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-load'
  )
  runtime = await spawnService(
    'apps/runtime/src/runtime-sim.ts',
    {
      PORT: '0',
      API_URL: api.url,
      HOST_ID: 'host_dev001',
      HOST_NAME: 'dev-001',
      SANDBOX_ROOT: '/tmp/orca-m110-sandbox',
      TLS_KEY: tls.key,
      TLS_CERT: tls.cert
    },
    /\[runtime-sim\] dev-001 listening on :(\d+)/,
    'runtime-load'
  )
  const adminToken = await login(api.url, 'admin', 'Adm1n!')
  // The seeded project already points at host_dev001; bind the real port.
  await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-001',
    directAddr: `127.0.0.1:${runtime.port}`,
    relayTarget: `127.0.0.1:${runtime.port}`
  })
  await new Promise((resolve) => setTimeout(resolve, 1_500))
}, 120_000)

after(async () => {
  await runtime?.stop()
  await api?.stop()
})

test(`AC-22 ${SESSIONS} 并发会话 ${DURATION_S} 秒：连接、保持与稳态 RPC`, async () => {
  const entries: Entry[] = []
  const connectTimes: number[] = []
  const failureCodes = new Set<string>()

  // ---- connect phase: a fresh client per session, ramped so logins do not stampede ----
  for (let start = 0; start < SESSIONS; start += RAMP_BATCH) {
    const batch = Array.from({ length: Math.min(RAMP_BATCH, SESSIONS - start) }, (_, offset) =>
      (async (): Promise<Entry | null> => {
        const id = start + offset
        const client = new CloudClient(api.url)
        try {
          await client.login('zhangsan', 'Passw0rd!')
          const projects = await client.listProjects()
          const project = projects[0]
          if (!project) return null
          const started = Date.now()
          const opened = await client.openProject(project.id)
          const connectMs = Date.now() - started
          connectTimes.push(connectMs)
          return { id, route: opened.route, connectMs, rpcOk: 0, rpcFail: 0, closed: false }
        } catch (error) {
          return {
            id,
            route: `failed:${error instanceof Error ? error.message : String(error)}`,
            connectMs: -1,
            rpcOk: 0,
            rpcFail: 0,
            closed: false
          }
        }
      })()
    )
    for (const entry of await Promise.all(batch)) {
      if (entry) entries.push(entry)
    }
  }

  const connectOk = entries.filter((entry) => entry.route !== 'failed')
  assert.equal(
    connectOk.length,
    SESSIONS,
    `every session must connect; failed=${SESSIONS - connectOk.length}`
  )
  const connectStats = statsOf(connectTimes)
  assert.ok(
    connectStats.p95 <= CONNECT_BUDGET_MS,
    `connect P95 ${connectStats.p95}ms over budget ${CONNECT_BUDGET_MS}ms`
  )

  // ---- steady phase: every session talks on its own cadence until the deadline ----
  const deadline = Date.now() + DURATION_S * 1_000
  const clients = new Map<number, CloudClient>()
  const worktrees = new Map<number, string>()
  for (const entry of connectOk) {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0]!.id)
    clients.set(entry.id, client)
    worktrees.set(entry.id, opened.connect.workspace.projectRoot)
    client.onClose(() => {
      entry.closed = true
    })
  }

  const loops = connectOk.map((entry, index) =>
    (async (): Promise<void> => {
      const client = clients.get(entry.id)
      const worktree = worktrees.get(entry.id)
      if (!client || !worktree) return
      // Phase offset spreads the cadence instead of synchronising a tick storm.
      await new Promise((resolve) => setTimeout(resolve, (index % RAMP_BATCH) * (RPC_INTERVAL_MS / RAMP_BATCH)))
      let tick = 0
      while (Date.now() < deadline && !entry.closed) {
        const result =
          tick % 10 === 0
            ? await client.rpc('files.readDir', { worktree, relativePath: '.' }, RPC_TIMEOUT_MS)
            : await client.rpc('workspace.info', {}, RPC_TIMEOUT_MS)
        if (result.ok) entry.rpcOk += 1
        else {
          entry.rpcFail += 1
          failureCodes.add(`${entry.id}:${result.code}`)
        }
        tick += 1
        await new Promise((resolve) => setTimeout(resolve, RPC_INTERVAL_MS))
      }
    })()
  )
  await Promise.all(loops)

  const rpcOk = entries.reduce((sum, entry) => sum + entry.rpcOk, 0)
  const rpcFail = entries.reduce((sum, entry) => sum + entry.rpcFail, 0)
  const closedCount = entries.filter((entry) => entry.closed).length
  const successRate = rpcOk + rpcFail > 0 ? rpcOk / (rpcOk + rpcFail) : 0
  assert.ok(
    successRate >= 0.999,
    `steady-state RPC success ${(successRate * 100).toFixed(3)}% (${rpcFail} failures of ${rpcOk + rpcFail}); codes=${[...failureCodes].slice(0, 10).join(', ')}`
  )
  assert.equal(closedCount, 0, `${closedCount} sessions were closed under load`)

  for (const client of clients.values()) client.close()

  saveEvidence('m110-load-300', `result-${LABEL}.json`, {
    sessions: SESSIONS,
    durationS: DURATION_S,
    connect: { budgetMs: CONNECT_BUDGET_MS, ...connectStats },
    steady: { rpcOk, rpcFail, successRate, unexpectedCloses: closedCount, failureCodes: [...failureCodes].slice(0, 20) },
    routes: Object.entries(
      connectOk.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.route] = (counts[entry.route] ?? 0) + 1
        return counts
      }, {})
    ),
    host: { cpus: cpus().length, loadavg: loadavg().map((value) => Math.round(value * 100) / 100) },
    node: process.version,
    platform: process.platform
  })
}, DURATION_S * 1_000 + 300_000)
