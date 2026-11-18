import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { saveEvidence } from './harness.ts'

/**
 * U66-1: `audit.recordFileEvent` ingress (§2.10) and file-event chain landing.
 * The three event families, the 120/min session budget, same-trace merging, the
 * field whitelist, non-cloud sessions, and the AC-53 negative assertion all run
 * over real HTTP against a seeded platform.
 */

const INTERNAL_TOKEN = 'u66-internal'
const T0 = 1_800_000_000_000
const PROJECT_ID = 'proj_payment'
const HOST_ID = 'host_dev001'
const FILE_EVENT_TYPES = new Set(['file_download', 'file_copy', 'download_blocked'])

let clock = T0
let app: ApiHandle
let url = ''
let deviceId = ''
let adminToken = ''
const evidence: unknown[] = []

before(async () => {
  clock = T0
  app = createApp({ port: 0, now: () => clock, internalToken: INTERNAL_TOKEN })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`
  deviceId = await login('zhangsan', 'Passw0rd!', 'u66-device')
  adminToken = await login('admin', 'Adm1n!', 'u66-admin')
})

after(async () => {
  saveEvidence('u66-1-events', 'file-event-recording.json', {
    generatedAt: new Date().toISOString(),
    clock: T0,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
    fileEvents: app.store.audit.filter((event) => FILE_EVENT_TYPES.has(event.eventType)),
    chain: app.audit.verify(),
    ingressGaps: await readIngressGaps(),
    checks: evidence
  })
  await app.close()
})

async function login(username: string, password: string, device: string): Promise<string> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceName: device,
      devicePubKey: Buffer.from(`u66-${device}`).toString('base64')
    })
  })
  const body = (await res.json()) as { accessToken?: string; device?: { id?: string } }
  assert.equal(res.status, 200, JSON.stringify(body))
  return username === 'admin' ? (body.accessToken ?? '') : (body.device?.id ?? '')
}

type Outcome = { status: number; body: Record<string, unknown>; retryAfter: string | null }

async function postFileEvent(
  payload: Record<string, unknown>,
  token: string | null = INTERNAL_TOKEN
): Promise<Outcome> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== null) headers['x-internal-token'] = token
  const res = await fetch(`${url}/v1/internal/audit/file-events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })
  const text = await res.text()
  return {
    status: res.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    retryAfter: res.headers.get('retry-after')
  }
}

function downloadEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'file_download',
    result: 'success',
    traceId: 'tr_download_1',
    cloudSession: 'sess_main',
    projectId: PROJECT_ID,
    deviceId,
    hostId: HOST_ID,
    metadata: {
      fileName: 'app.ts',
      path: 'src/config/app.ts',
      sizeBytes: 4096,
      method: 'files.readChunk',
      kind: 'file',
      surface: 'desktop',
      capturePoint: 'download-runtime-client',
      policy: 'allow',
      occurredAt: T0,
      sha256: 'a'.repeat(64),
      mime: 'text/typescript',
      isBinary: false,
      clientVersion: '2026.10.2'
    },
    ...overrides
  }
}

function copyEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'file_copy',
    result: 'success',
    traceId: 'tr_copy_1',
    cloudSession: 'sess_main',
    projectId: PROJECT_ID,
    deviceId,
    metadata: {
      fileName: 'rules.ts',
      path: 'src/engine/rules.ts',
      method: 'copyContent',
      kind: 'file',
      copyKind: 'content-whole',
      copiedChars: 1240,
      copiedBytes: 3720,
      surface: 'mobile',
      capturePoint: 'mobile-copy-content',
      occurredAt: T0
    },
    ...overrides
  }
}

function blockedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'download_blocked',
    result: 'denied',
    traceId: 'tr_blocked_1',
    cloudSession: 'sess_main',
    projectId: PROJECT_ID,
    deviceId,
    metadata: {
      fileName: 'app.ts',
      path: 'src/config/app.ts',
      method: 'files.readChunk',
      kind: 'file',
      surface: 'web',
      policy: 'deny',
      reason: 'DOWNLOAD_DISABLED',
      occurredAt: T0
    },
    ...overrides
  }
}

function chainEvent(traceId: string): (typeof app.store.audit)[number] | undefined {
  return app.store.audit.find((event) => event.traceId === traceId)
}

function fileEventCount(): number {
  return app.store.audit.filter((event) => FILE_EVENT_TYPES.has(event.eventType)).length
}

async function readIngressGaps(): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${url}/v1/audit/status`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  if (!res.ok) return null
  const body = (await res.json()) as { ingressGaps?: Record<string, unknown> }
  return body.ingressGaps ?? null
}

describe('U66-1 文件审计事件落链', () => {
  test('三类事件以裸名落链，actor 按 deviceId 反解，metadata 逐字段保留', async () => {
    const download = await postFileEvent(downloadEvent())
    assert.equal(download.status, 200, JSON.stringify(download.body))
    assert.equal(download.body.queued, true)
    assert.equal(typeof download.body.acceptedSeq, 'number')

    const copy = await postFileEvent(copyEvent())
    assert.equal(copy.status, 200, JSON.stringify(copy.body))
    assert.equal(copy.body.queued, true)

    const blocked = await postFileEvent(blockedEvent())
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body))
    assert.equal(blocked.body.queued, true)

    const downloadEventRecord = chainEvent('tr_download_1')
    assert.ok(downloadEventRecord, 'file_download must land on the chain')
    assert.equal(downloadEventRecord.eventType, 'file_download')
    assert.equal(downloadEventRecord.actor, 'zhangsan')
    assert.equal(downloadEventRecord.targetType, 'project')
    assert.equal(downloadEventRecord.targetId, PROJECT_ID)
    assert.equal(downloadEventRecord.result, 'success')
    const dm = downloadEventRecord.metadata ?? {}
    assert.equal(dm.hostId, HOST_ID)
    assert.equal(dm.hostName, 'dev-001')
    assert.equal(dm.projectKey, 'payment-service')
    assert.equal(dm.fileName, 'app.ts')
    assert.equal(dm.path, 'src/config/app.ts')
    assert.equal(dm.sizeBytes, 4096)
    assert.equal(dm.sha256, 'a'.repeat(64))
    assert.equal(dm.sha256Source, 'client')
    assert.equal(dm.method, 'files.readChunk')
    assert.equal(dm.kind, 'file')
    assert.equal(dm.surface, 'desktop')
    assert.equal(dm.capturePoint, 'download-runtime-client')
    assert.equal(dm.captureConfidence, 'client-declared')
    assert.equal(dm.policy, 'allow')
    assert.equal(dm.occurredAt, T0)
    assert.equal(dm.mime, 'text/typescript')
    assert.equal(dm.isBinary, false)
    assert.equal(dm.clientVersion, '2026.10.2')
    assert.equal(dm.actorSource, 'device')
    assert.equal(dm.subject, 'user:zhangsan')
    assert.equal(dm.deviceId, deviceId)

    const copyEventRecord = chainEvent('tr_copy_1')
    assert.ok(copyEventRecord, 'file_copy must land on the chain')
    assert.equal(copyEventRecord.eventType, 'file_copy')
    assert.equal(copyEventRecord.actor, 'zhangsan')
    const cm = copyEventRecord.metadata ?? {}
    assert.equal(cm.fileName, 'rules.ts')
    assert.equal(cm.path, 'src/engine/rules.ts')
    assert.equal(cm.copyKind, 'content-whole')
    assert.equal(cm.copiedChars, 1240)
    assert.equal(cm.copiedBytes, 3720)
    assert.equal(cm.surface, 'mobile')
    assert.equal(cm.capturePoint, 'mobile-copy-content')
    assert.equal(cm.captureConfidence, 'client-declared')

    const blockedRecord = chainEvent('tr_blocked_1')
    assert.ok(blockedRecord, 'download_blocked must land on the chain')
    assert.equal(blockedRecord.eventType, 'download_blocked')
    assert.equal(blockedRecord.result, 'denied')
    const bm = blockedRecord.metadata ?? {}
    assert.equal(bm.policy, 'deny')
    assert.equal(bm.reason, 'DOWNLOAD_DISABLED')
    assert.equal(bm.capturePoint, 'frontend-block')
    assert.equal(bm.captureConfidence, 'client-declared')

    const verdict = await app.audit.verify()
    assert.equal(verdict.ok, true)
    evidence.push({ case: 'three-event-families', acceptedSeq: download.body.acceptedSeq })
  })

  test('每云会话 120 条/分钟：第 121 条 429，缺口计数可见', async () => {
    for (let index = 0; index < 120; index += 1) {
      const outcome = await postFileEvent(
        downloadEvent({
          traceId: `tr_rate_${index}`,
          cloudSession: 'sess_rate',
          metadata: { ...(downloadEvent().metadata as Record<string, unknown>) }
        })
      )
      assert.equal(outcome.status, 200, `event ${index}: ${JSON.stringify(outcome.body)}`)
      assert.equal(outcome.body.queued, true)
    }
    const tenth = await postFileEvent(
      downloadEvent({ traceId: 'tr_rate_over', cloudSession: 'sess_rate' })
    )
    assert.equal(tenth.status, 429)
    assert.equal(tenth.body.reason, 'rate-limited')
    assert.equal(tenth.retryAfter, '60')

    const gaps = await readIngressGaps()
    assert.ok(gaps)
    assert.ok(Number(gaps.rateLimitedTotal) >= 1)
    evidence.push({ case: 'rate-limit', status: tenth.status, gaps })
  })

  test('同 traceId 去重合并：savedName 补报不新增第二条下载事件', async () => {
    const session = 'sess_dedupe'
    const first = await postFileEvent(downloadEvent({ traceId: 'tr_merge', cloudSession: session }))
    assert.equal(first.body.queued, true, JSON.stringify(first.body))
    const before = fileEventCount()

    const supplement = await postFileEvent({
      eventType: 'file_download',
      result: 'success',
      traceId: 'tr_merge',
      cloudSession: session,
      projectId: PROJECT_ID,
      deviceId,
      metadata: { savedName: 'app.ts' }
    })
    assert.equal(supplement.status, 200, JSON.stringify(supplement.body))
    assert.equal(supplement.body.queued, true)
    assert.equal(supplement.body.merged, true)

    const duplicate = await postFileEvent(
      downloadEvent({ traceId: 'tr_merge', cloudSession: session })
    )
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.body.queued, false)
    assert.equal(duplicate.body.reason, 'duplicate')

    const unmatched = await postFileEvent({
      eventType: 'file_download',
      result: 'success',
      traceId: 'tr_orphan_saved_name',
      cloudSession: session,
      projectId: PROJECT_ID,
      deviceId,
      metadata: { savedName: 'orphan.ts' }
    })
    assert.equal(unmatched.status, 200)
    assert.equal(unmatched.body.queued, false)
    assert.equal(unmatched.body.reason, 'unmatched-saved-name')

    assert.equal(fileEventCount(), before, 'dedupe must not append a second download event')
    assert.equal(app.store.audit.filter((event) => event.traceId === 'tr_merge').length, 1)
    assert.equal(chainEvent('tr_orphan_saved_name'), undefined)
    evidence.push({ case: 'trace-dedupe', eventCount: before })
  })

  test('畸形字段与未知字段被拒绝，链不新增事件', async () => {
    const session = 'sess_invalid'
    const before = fileEventCount()

    const unknownMetadata = await postFileEvent(
      downloadEvent({
        traceId: 'tr_bad_unknown_metadata',
        cloudSession: session,
        metadata: { ...(downloadEvent().metadata as Record<string, unknown>), body: 'secret' }
      })
    )
    assert.equal(unknownMetadata.status, 400)
    assert.equal((unknownMetadata.body.error as Record<string, unknown>).code, 'INVALID_FILE_EVENT')

    const unknownTopLevel = await postFileEvent(
      downloadEvent({ traceId: 'tr_bad_unknown_top', cloudSession: session, extra: true })
    )
    assert.equal(unknownTopLevel.status, 400)

    const traversal = await postFileEvent(
      downloadEvent({
        traceId: 'tr_bad_traversal',
        cloudSession: session,
        metadata: {
          ...(downloadEvent().metadata as Record<string, unknown>),
          path: '../etc/passwd'
        }
      })
    )
    assert.equal(traversal.status, 400)
    assert.deepEqual((traversal.body.error as Record<string, unknown>).details, {
      field: 'path',
      reason: 'absolute-or-parent-traversal'
    })

    const absolute = await postFileEvent(
      downloadEvent({
        traceId: 'tr_bad_absolute',
        cloudSession: session,
        metadata: { ...(downloadEvent().metadata as Record<string, unknown>), path: '/etc/passwd' }
      })
    )
    assert.equal(absolute.status, 400)

    const selfAttested = await postFileEvent(
      downloadEvent({
        traceId: 'tr_bad_confidence',
        cloudSession: session,
        metadata: {
          ...(downloadEvent().metadata as Record<string, unknown>),
          captureConfidence: 'host-attested'
        }
      })
    )
    assert.equal(selfAttested.status, 400)
    assert.equal(
      ((selfAttested.body.error as Record<string, unknown>).details as Record<string, unknown>)
        .field,
      'captureConfidence'
    )

    const badType = await postFileEvent(
      downloadEvent({ eventType: 'file_delete', traceId: 'tr_bad_type', cloudSession: session })
    )
    assert.equal(badType.status, 400)

    assert.equal(fileEventCount(), before)
    evidence.push({ case: 'invalid-fields', rejected: 6 })
  })

  test('内部认证与非云会话：401 / non-cloud-session 均不写链', async () => {
    const before = fileEventCount()
    const wrongToken = await postFileEvent(
      downloadEvent({ traceId: 'tr_auth_wrong' }),
      'wrong-token'
    )
    assert.equal(wrongToken.status, 401)
    const missingToken = await postFileEvent(downloadEvent({ traceId: 'tr_auth_missing' }), null)
    assert.equal(missingToken.status, 401)

    const nonCloud = await postFileEvent(
      downloadEvent({ traceId: 'tr_non_cloud', cloudSession: undefined, deviceId: undefined })
    )
    assert.equal(nonCloud.status, 200)
    assert.equal(nonCloud.body.queued, false)
    assert.equal(nonCloud.body.reason, 'non-cloud-session')

    const sessionAlias = await postFileEvent({
      eventType: 'file_download',
      result: 'success',
      traceId: 'tr_session_alias',
      sessionId: 'sess_alias',
      projectId: PROJECT_ID,
      deviceId,
      metadata: { ...(downloadEvent().metadata as Record<string, unknown>) }
    })
    assert.equal(sessionAlias.status, 200, JSON.stringify(sessionAlias.body))
    assert.equal(sessionAlias.body.queued, true)

    assert.equal(fileEventCount(), before + 1, 'only the sessionId-aliased event may land')
    assert.equal(chainEvent('tr_non_cloud'), undefined)
    evidence.push({ case: 'auth-and-cloud-session', status: nonCloud.status })
  })

  test('AC-53 负向：excerpt 被丢弃；AC-56/57 的移动端字段被接受', async () => {
    const session = 'sess_ac53'
    const marker = 'U66_SECRET_MARKER_9966'
    const withExcerpt = await postFileEvent(
      copyEvent({
        traceId: 'tr_excerpt',
        cloudSession: session,
        metadata: {
          ...(copyEvent().metadata as Record<string, unknown>),
          excerpt: `${marker} export const secret = 1`,
          excerptBytes: 32,
          excerptTruncated: true
        }
      })
    )
    assert.equal(withExcerpt.status, 200, JSON.stringify(withExcerpt.body))
    assert.equal(withExcerpt.body.queued, true)
    assert.equal(withExcerpt.body.reason, 'excerpt-not-allowed')
    assert.equal(withExcerpt.body.excerptDropped, true)

    const excerptRecord = chainEvent('tr_excerpt')
    assert.ok(excerptRecord)
    const serialized = JSON.stringify(excerptRecord.metadata)
    assert.equal(withExcerpt.body.queued, true)
    assert.ok(!serialized.includes(marker), 'metadata must not contain file content')
    assert.ok(!('excerpt' in (excerptRecord.metadata ?? {})))
    assert.ok(!('excerptBytes' in (excerptRecord.metadata ?? {})))
    assert.ok(!('excerptTruncated' in (excerptRecord.metadata ?? {})))

    const mobileSave = await postFileEvent(
      downloadEvent({
        traceId: 'tr_mobile_save',
        cloudSession: session,
        metadata: {
          fileName: 'app.ts',
          path: 'src/config/app.ts',
          sizeBytes: 4096,
          method: 'mobile.saveToPhone',
          kind: 'file',
          surface: 'mobile',
          capturePoint: 'mobile-save',
          occurredAt: T0,
          savedName: 'app.ts',
          reason: 'share_sheet'
        }
      })
    )
    assert.equal(mobileSave.status, 200, JSON.stringify(mobileSave.body))
    const mobileRecord = chainEvent('tr_mobile_save')
    assert.ok(mobileRecord)
    assert.equal(mobileRecord.metadata?.method, 'mobile.saveToPhone')
    assert.equal(mobileRecord.metadata?.surface, 'mobile')
    assert.equal(mobileRecord.metadata?.capturePoint, 'mobile-save')
    assert.equal(mobileRecord.metadata?.captureConfidence, 'client-declared')
    assert.equal(mobileRecord.metadata?.savedName, 'app.ts')
    assert.equal(mobileRecord.metadata?.reason, 'share_sheet')

    evidence.push({ case: 'ac-53-negative-and-mobile-fields', markerAbsent: true })
  })
})
