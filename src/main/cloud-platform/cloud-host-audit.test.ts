import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readArray, readField, readNumber, readString } from '../../shared/json-fields'
import { REPO_ROOT } from './cloud-session-e2e-harness'
import {
  startAgentLaunchStack,
  type AgentLaunchStack
} from './cloud-agent-launch-execution-fixture'

/**
 * M73 (G-08): a host records its own security refusals and reports them on the
 * heartbeat, so the platform audit chain covers what only the host can see.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm73-host-audit')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let stack: AgentLaunchStack
let adminToken: string

function attemptUpgrade(credential: string): Promise<{ status?: number; reject?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(stack.cloud.endpoint, ['orca-runtime', `orca-cred.${credential}`], {
      headers: { 'x-orca-device-pubkey': Buffer.alloc(32).toString('base64') },
      rejectUnauthorized: false,
      handshakeTimeout: 5_000
    })
    ws.once('unexpected-response', (_req, res) => {
      const reject = res.headers['x-orca-reject']
      resolve({
        status: res.statusCode,
        reject: Array.isArray(reject) ? reject[0] : reject
      })
      ws.terminate()
    })
    ws.once('open', () => {
      ws.close()
      resolve({})
    })
    ws.once('error', () => resolve({}))
  })
}

async function auditEvents(eventType: string): Promise<unknown[]> {
  const res = await fetch(`${stack.platform.url}/v1/audit/events?eventType=${eventType}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  expect(res.status).toBe(200)
  return readArray(await res.json(), 'events') ?? []
}

beforeAll(async () => {
  stack = await startAgentLaunchStack()
  // The fixture builds the runtime directly; production wires this in attachCloudRuntime.
  stack.cloud.runtime.setCloudHostAudit((event) => stack.admission.client!.reportAudit(event))
  const login = await fetch(`${stack.platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm73-admin' })
  })
  adminToken = readString(await login.json(), 'accessToken') ?? ''
  expect(adminToken).not.toBe('')
}, 120_000)

afterAll(async () => {
  stack?.stopPtyController()
  stack?.desktop.close()
  stack?.admission.client?.stop()
  await stack?.cloud.runtime.stop()
  await stack?.platform.stop()
})

describe('主机侧拒绝进入平台审计链（真实平台 + 真实 TLS Runtime）', () => {
  it('M73-1 越界写、主机级方法与伪造凭证三个阶段各自留下审计事件', async () => {
    const write = await stack.desktop.rpc('files.write', {
      worktree: `path:${stack.projectRoot}`,
      relativePath: 'escape.txt',
      content: 'x'
    })
    expect(write.ok).toBe(false)

    const hostMethod = await stack.desktop.rpc('settings.update', { settings: {} })
    expect(hostMethod.ok).toBe(false)

    const forged = await attemptUpgrade('not-a-signed-ticket')
    expect(forged).toMatchObject({ status: 401 })

    // One heartbeat carries the batch; the platform appends it to the chain.
    await stack.admission.client!.refresh()

    const pathDenied = await auditEvents('host.path_denied')
    expect(pathDenied.length).toBeGreaterThan(0)
    expect(pathDenied[0]).toMatchObject({
      actor: 'host:dev-m67',
      targetType: 'device',
      result: 'denied',
      metadata: { denial: 'PATH_OUTSIDE_ROOT', reason: 'workspace_scope', method: 'files.write' }
    })

    const methodDenied = await auditEvents('host.method_denied')
    expect(methodDenied.length).toBeGreaterThan(0)
    expect(methodDenied[0]).toMatchObject({
      metadata: { denial: 'METHOD_NOT_AVAILABLE', method: 'settings.update' }
    })

    const rejected = await auditEvents('host.connection_rejected')
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected[0]).toMatchObject({
      actor: 'host:dev-m67',
      targetType: 'host',
      result: 'denied',
      metadata: { reason: 'malformed' }
    })

    const verify = await fetch(`${stack.platform.url}/v1/audit/verify`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    const verdict = await verify.json()
    expect(readField(verdict, 'ok')).toBe(true)
    expect(readNumber(verdict, 'checked') ?? 0).toBeGreaterThan(pathDenied.length)

    saveEvidence('m73-host-refusals.json', {
      forged,
      pathDenied,
      methodDenied,
      connectionRejected: rejected,
      verify: verdict
    })
  }, 90_000)
})
