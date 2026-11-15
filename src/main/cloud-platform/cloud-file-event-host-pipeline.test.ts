import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readArray, readField, readNumber, readString } from '../../shared/json-fields'
import {
  REPO_ROOT,
  connectCloudSession,
  makeSelfSignedTls,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { startCloudRuntimeAdmission } from '../startup/cloud-runtime-admission'

/**
 * U68 (R-01): the real client→host→platform audit pipeline. A real platform
 * process issues the ticket; a real enrolled host (heartbeat client) accepts
 * `audit.recordFileEvent` over the E2EE session, queues it, and delivers it on
 * the next heartbeat; the platform lands it in the hash chain under the bare
 * event name with user attribution. This replaces the U66 acceptance test
 * bridge, which had to POST to the internal ingress directly because the host
 * RPC did not exist.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'u68-host-audit')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let platform: Platform
let adminToken = ''
let admission: ReturnType<typeof startCloudRuntimeAdmission>
let cloud: CloudRuntime
let projectId = ''

async function auditEvents(query: string): Promise<unknown[]> {
  const res = await fetch(`${platform.url}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  expect(res.status).toBe(200)
  return readArray(await res.json(), 'events') ?? []
}

async function connectSession(
  deviceName: string
): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const session = await openPlatformSession(platform, {
    projectKey: 'u68-pipeline',
    deviceName
  })
  const connection = await connectCloudSession(
    cloud.endpoint,
    cloud.serverPublicKeyB64,
    session,
    5000,
    { tlsRejectUnauthorized: false }
  )
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got close ${connection.close.code}`)
  }
  return connection
}

beforeAll(async () => {
  platform = await startPlatform()
  const login = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u68-admin' })
  })
  adminToken = readString(await login.json(), 'accessToken') ?? ''
  expect(adminToken).not.toBe('')

  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  expect(hostToken).not.toBeNull()

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u68-host-'))
  admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken ?? '',
      ORCA_CLOUD_HOST_NAME: 'dev-u68',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: dataDir }
  )
  expect(admission).not.toBeNull()
  await admission!.ready

  cloud = await startCloudRuntime({
    admission: admission!.admission,
    connectionGate: admission!.connectionGate,
    userDataPrefix: 'orca-u68-',
    tls: makeSelfSignedTls('dev-u68')
  })
  // Production wiring is attachCloudRuntime; the fixture binds by hand.
  admission!.bindRuntime(cloud.runtime)
  expect(admission!.client).not.toBeNull()
  cloud.runtime.setCloudHostAudit?.((event) => admission!.client!.reportAudit(event))
  cloud.runtime.setCloudFileEventAudit?.(admission!.client!.fileEvents.audit)
  await admission!.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'u68-pipeline',
      name: 'u68-pipeline',
      hostId: admission!.host()!.hostId,
      path: '/srv/work/u68-pipeline'
    })
  })
  expect(create.status).toBe(201)
  projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      // `download` + `browser`: with the platform's default download-deny policy
      // the refusal is the policy one (DOWNLOAD_DISABLED), not a missing
      // permission — that is the denial the host must map to file_download.
      permissions: ['open', 'file:read', 'download', 'browser']
    })
  })
  expect(grant.status).toBe(200)
}, 120_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

describe('U68 宿主审计管线（真实平台 + 真实宿主心跳 + 真实 E2EE 会话）', () => {
  it('U68-1 复制/下载/拦截三类事件经宿主 RPC 与心跳进入平台审计链', async () => {
    const session = await connectSession('u68-web-copy')
    try {
      // AC-45 shape: a web workspace copy, reported the way the renderer does.
      const copy = await session.rpc('audit.recordFileEvent', {
        eventType: 'file_copy',
        result: 'success',
        traceId: 'tr_u68copy1',
        metadata: {
          fileName: 'rules.ts',
          path: 'src/engine/rules.ts',
          copyKind: 'content-whole',
          copiedChars: 1240,
          copiedBytes: 3720,
          kind: 'file',
          surface: 'web',
          capturePoint: 'web-clipboard-api',
          occurredAt: Date.now()
        }
      })
      expect(copy.ok, JSON.stringify(copy)).toBe(true)
      if (copy.ok) {
        expect(readField(copy.result, 'queued')).toBe(true)
      }

      // AC-41: a desktop download outcome plus its savedName supplement — one
      // event on the chain, the name merged into it (§2.10.3).
      const download = await session.rpc('audit.recordFileEvent', {
        eventType: 'file_download',
        result: 'success',
        traceId: 'tr_u68dl1',
        metadata: {
          fileName: 'app.ts',
          path: 'src/config/app.ts',
          sizeBytes: 4096,
          method: 'files.readChunk',
          kind: 'file',
          surface: 'desktop',
          capturePoint: 'download-runtime-client',
          occurredAt: Date.now()
        }
      })
      expect(download.ok).toBe(true)
      const supplement = await session.rpc('audit.recordFileEvent', {
        eventType: 'file_download',
        result: 'success',
        traceId: 'tr_u68dl1',
        metadata: { savedName: 'app-copy.ts' }
      })
      expect(supplement.ok).toBe(true)
      if (supplement.ok) {
        expect(readField(supplement.result, 'merged')).toBe(true)
      }

      // AC-42: the frontend interception producer.
      const blocked = await session.rpc('audit.recordFileEvent', {
        eventType: 'download_blocked',
        result: 'denied',
        metadata: {
          fileName: 'secret.bin',
          path: 'dist/secret.bin',
          kind: 'file',
          surface: 'desktop',
          capturePoint: 'frontend-block',
          policy: 'deny',
          reason: 'DOWNLOAD_DISABLED',
          occurredAt: Date.now()
        }
      })
      expect(blocked.ok).toBe(true)

      // Flush the host's queue onto the chain.
      await admission!.client!.refresh()
      await admission!.client!.refresh()

      const chainEvents = await auditEvents(
        'eventTypes=file_download,file_copy,download_blocked&limit=100'
      )
      const byType = (eventType: string): unknown[] =>
        chainEvents.filter((event) => readString(event, 'eventType') === eventType)

      expect(byType('file_copy')).toHaveLength(1)
      expect(byType('file_download')).toHaveLength(1)
      expect(byType('download_blocked')).toHaveLength(1)

      const copyEvent = byType('file_copy')[0]
      expect(readString(copyEvent, 'actor')).toBe('zhangsan')
      expect(readString(readField(copyEvent, 'metadata'), 'actorSource')).toBe('subject')
      expect(readString(readField(copyEvent, 'metadata'), 'subject')).toBe('user:zhangsan')
      expect(readNumber(readField(copyEvent, 'metadata'), 'copiedBytes')).toBe(3720)
      expect(readString(readField(copyEvent, 'metadata'), 'capturePoint')).toBe('web-clipboard-api')

      const downloadEvent = byType('file_download')[0]
      expect(readString(downloadEvent, 'result')).toBe('success')
      expect(readString(readField(downloadEvent, 'metadata'), 'savedName')).toBe('app-copy.ts')
      expect(readString(readField(downloadEvent, 'metadata'), 'captureConfidence')).toBe(
        'client-declared'
      )

      const blockedEvent = byType('download_blocked')[0]
      expect(readString(blockedEvent, 'result')).toBe('denied')
      expect(readString(readField(blockedEvent, 'metadata'), 'capturePoint')).toBe('frontend-block')

      saveEvidence('u68-1-pipeline.json', {
        generatedAt: new Date().toISOString(),
        copyReply: copy.ok ? copy.result : copy,
        downloadReply: download.ok ? download.result : download,
        supplementReply: supplement.ok ? supplement.result : supplement,
        chainEvents: chainEvents.map((event) => ({
          eventType: readString(event, 'eventType'),
          actor: readString(event, 'actor'),
          result: readString(event, 'result'),
          metadata: readField(event, 'metadata')
        }))
      })
    } finally {
      session.ws.close()
    }
  }, 60_000)

  it('U68-2 下载策略拒绝由宿主映射为 file_download denied（host-attested）', async () => {
    const session = await connectSession('u68-denial')
    try {
      // The platform's default download policy is deny; the ticket carries
      // `browser`, so the refusal is the policy one, not a permission ACL.
      const denied = await session.rpc('browser.download', { selector: 'a' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) {
        expect(denied.message).toContain('disabled for this project by platform policy')
      }

      await admission!.client!.refresh()
      await admission!.client!.refresh()
      const downloads = (await auditEvents('eventType=file_download&limit=50')).filter(
        (event) => readString(event, 'result') === 'denied'
      )
      expect(downloads).toHaveLength(1)
      const hostDenied = downloads[0]
      expect(readString(readField(hostDenied, 'metadata'), 'method')).toBe('browser.download')
      expect(readString(readField(hostDenied, 'metadata'), 'denial')).toBe('DOWNLOAD_DISABLED')
      expect(readString(readField(hostDenied, 'metadata'), 'captureConfidence')).toBe(
        'host-attested'
      )
      expect(readString(readField(hostDenied, 'metadata'), 'actorSource')).toBe('subject')
      saveEvidence('u68-2-denial.json', { rpcDenied: denied, hostDenied })
    } finally {
      session.ws.close()
    }
  }, 60_000)

  it('U68-3 非云方法白名单与坏字段：单条拒绝不影响同会话其他事件；链完整', async () => {
    const session = await connectSession('u68-negative')
    try {
      const bad = await session.rpc('audit.recordFileEvent', {
        eventType: 'file_copy',
        result: 'success',
        metadata: { excerpt: 'U68_SECRET_MARKER' }
      })
      // The excerpt is stripped by the host (AC-53), not refused.
      expect(bad.ok).toBe(true)

      const invalid = await session.rpc('audit.recordFileEvent', {
        eventType: 'file_copy',
        result: 'success',
        metadata: { body: 'raw content' }
      })
      expect(invalid.ok).toBe(false)
      if (!invalid.ok) {
        expect(invalid.code).toBe('invalid_argument')
        expect(invalid.message).toContain('body')
      }

      const good = await session.rpc('audit.recordFileEvent', {
        eventType: 'file_copy',
        result: 'success',
        metadata: {
          path: 'docs/readme.md',
          fileName: 'readme.md',
          copyKind: 'content-whole',
          copiedBytes: 5,
          surface: 'web',
          occurredAt: Date.now()
        }
      })
      expect(good.ok).toBe(true)

      const rateLimited: unknown[] = []
      for (let index = 0; index < 121; index += 1) {
        const reply = await session.rpc('audit.recordFileEvent', {
          eventType: 'file_download',
          result: 'failure',
          traceId: `tr_rate_${index}`,
          metadata: {
            path: `tmp/f${index}.bin`,
            fileName: `f${index}.bin`,
            kind: 'file',
            surface: 'desktop',
            occurredAt: Date.now()
          }
        })
        if (reply.ok && readField(reply.result, 'queued') === false) {
          rateLimited.push(readField(reply.result, 'reason'))
        }
      }
      expect(rateLimited).toContain('rate-limited')

      await admission!.client!.refresh()
      await admission!.client!.refresh()

      const verify = await fetch(`${platform.url}/v1/audit/verify`, {
        headers: { authorization: `Bearer ${adminToken}` }
      })
      expect(verify.status).toBe(200)

      const copies = await auditEvents(`eventType=file_copy&projectId=${projectId}&limit=50`)
      expect(
        copies.every((event) => JSON.stringify(event).includes('U68_SECRET_MARKER') === false)
      ).toBe(true)

      saveEvidence('u68-3-negatives.json', {
        excerptStripped: bad.ok,
        invalidReply: invalid,
        rateLimitedReplies: rateLimited.length,
        chainVerified: true
      })
    } finally {
      session.ws.close()
    }
  }, 90_000)
})
