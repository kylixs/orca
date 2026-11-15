import { describe, expect, it } from 'vitest'
import { createCloudFileEventAudit, createCloudFileEventDelivery } from './cloud-file-event-audit'
import { createCloudHostAuditQueue, type CloudHostAuditInput } from './cloud-host-audit'

/** R-01 §2.10.2: the host intake's delivery policy — capability, rate limit,
 * queue backpressure, same-trace dedupe, and the savedName merge. */

function setup(options?: {
  fileEventsCapable?: () => boolean
  rateLimit?: number
  now?: () => number
}) {
  const queue = createCloudHostAuditQueue(true)
  const audit = createCloudFileEventAudit({
    queue,
    fileEventsCapable: options?.fileEventsCapable ?? (() => true),
    ...(options?.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
    ...(options?.now !== undefined ? { now: options.now } : {})
  })
  const sent = (): CloudHostAuditInput[] => queue.take().events
  return { queue, audit, sent }
}

const identity = { deviceId: 'dev-1', subject: 'user:zhangsan', projectId: 'proj-1' }

describe('createCloudFileEventAudit（audit.recordFileEvent 宿主承接）', () => {
  it('入队：身份与 metadata 原样携带，返回 queued', () => {
    const { audit, sent } = setup()
    const reply = audit(
      {
        eventType: 'file_copy',
        result: 'success',
        traceId: 'tr_1',
        metadata: { path: 'src/a.ts', copyKind: 'content-whole', copiedBytes: 10 }
      },
      identity
    )
    expect(reply).toEqual({ queued: true })
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({
      eventType: 'file_copy',
      result: 'success',
      deviceId: 'dev-1',
      subject: 'user:zhangsan',
      projectId: 'proj-1',
      traceId: 'tr_1'
    })
  })

  it('captureConfidence 由宿主赋值为 client-declared，客户端声明无效（§2.10.2）', () => {
    const { audit, sent } = setup()
    audit(
      {
        eventType: 'file_download',
        result: 'success',
        metadata: { path: 'src/a.ts', captureConfidence: 'host-attested' }
      },
      identity
    )
    expect(sent()[0].metadata?.captureConfidence).toBe('client-declared')
  })

  it('U69 指纹对（sha256+sha256Source）原样通过承接，captureConfidence 仍由宿主固定', () => {
    const { audit, sent } = setup()
    const reply = audit(
      {
        eventType: 'file_copy',
        result: 'success',
        traceId: 'tr_u69',
        metadata: {
          path: 'src/engine/rules.ts',
          captureConfidence: 'client-declared',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          sha256Source: 'client'
        }
      },
      identity
    )
    expect(reply).toEqual({ queued: true })
    expect(sent()[0].metadata).toMatchObject({
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sha256Source: 'client',
      captureConfidence: 'client-declared'
    })
  })

  it('能力不支持时抑制并计数（§2.9）', () => {
    const { queue, audit, sent } = setup({ fileEventsCapable: () => false })
    const reply = audit({ eventType: 'file_copy', result: 'success' }, identity)
    expect(reply).toEqual({ queued: false, reason: 'capability-unsupported' })
    expect(sent()).toHaveLength(0)
    expect(queue.gaps().suppressed).toBe(1)
  })

  it('每会话 120 条/分钟，超出 rate-limited 并计数', () => {
    let clock = 0
    const { queue, audit } = setup({ rateLimit: 2, now: () => clock })
    expect(audit({ eventType: 'file_copy', result: 'success' }, identity).queued).toBe(true)
    expect(audit({ eventType: 'file_copy', result: 'success' }, identity).queued).toBe(true)
    expect(audit({ eventType: 'file_copy', result: 'success' }, identity)).toEqual({
      queued: false,
      reason: 'rate-limited'
    })
    expect(queue.gaps().rateLimited).toBe(1)
    // A different session has its own budget; the window slides with time.
    expect(
      audit({ eventType: 'file_copy', result: 'success' }, { ...identity, projectId: 'p2' }).queued
    ).toBe(true)
    clock = 61_000
    expect(audit({ eventType: 'file_copy', result: 'success' }, identity).queued).toBe(true)
  })

  it('队列满时拒绝新事件，不制造新丢弃', () => {
    const { queue, audit } = setup()
    for (let index = 0; index < 200; index += 1) {
      queue({ eventType: 'file_copy', result: 'success', traceId: `tr_${index}` })
    }
    expect(audit({ eventType: 'file_copy', result: 'success' }, identity)).toEqual({
      queued: false,
      reason: 'queue-full'
    })
    expect(queue.pending()).toBe(200)
  })

  it('同 traceId 的下载/拦截不重入（§2.4 一动作一事件）；复制不受影响', () => {
    const { audit, sent } = setup()
    expect(
      audit({ eventType: 'file_download', result: 'success', traceId: 'tr_dl' }, identity).queued
    ).toBe(true)
    expect(
      audit({ eventType: 'file_download', result: 'success', traceId: 'tr_dl' }, identity)
    ).toEqual({ queued: false, reason: 'duplicate' })
    expect(
      audit({ eventType: 'download_blocked', result: 'denied', traceId: 'tr_dl' }, identity)
    ).toEqual({ queued: false, reason: 'duplicate' })
    // A copy with no traceId still lands, and copies never dedupe.
    expect(audit({ eventType: 'file_copy', result: 'success' }, identity).queued).toBe(true)
    expect(sent().filter((event) => event.eventType === 'file_download')).toHaveLength(1)
    expect(sent().filter((event) => event.eventType === 'file_copy')).toHaveLength(1)
  })

  it('savedName 补报合并进待发的同 trace 事件；无匹配则丢弃并计数（§2.10.3）', () => {
    const { queue, audit, sent } = setup()
    audit(
      {
        eventType: 'file_download',
        result: 'success',
        traceId: 'tr_dl',
        metadata: { path: 'src/a.ts' }
      },
      identity
    )
    expect(
      audit(
        {
          eventType: 'file_download',
          result: 'success',
          traceId: 'tr_dl',
          metadata: { savedName: 'a.ts' }
        },
        identity
      )
    ).toEqual({ queued: true, merged: true })
    expect(sent()).toHaveLength(1)
    expect(sent()[0].metadata).toMatchObject({ path: 'src/a.ts', savedName: 'a.ts' })

    expect(
      audit(
        {
          eventType: 'file_download',
          result: 'success',
          traceId: 'tr_lost',
          metadata: { savedName: 'x' }
        },
        identity
      )
    ).toEqual({ queued: false, reason: 'unmatched-saved-name' })
    expect(queue.gaps().dropped).toBe(1)
    expect(sent()).toHaveLength(1)
  })

  it('excerpt 由宿主剥离并标记 excerpt-not-allowed（§2.6/AC-53）', () => {
    const { audit, sent } = setup()
    const reply = audit(
      {
        eventType: 'file_copy',
        result: 'success',
        metadata: { path: 'src/a.ts', excerpt: 'U66_SECRET_MARKER', excerptBytes: 17 }
      },
      identity
    )
    expect(reply).toEqual({ queued: true, excerptDropped: true })
    const event = sent()[0]
    expect(event.metadata?.excerpt).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('U66_SECRET_MARKER')
  })
})

describe('createCloudFileEventDelivery（§2.9 能力协商，U66 二期严格门控）', () => {
  it('平台声明 fileEvents:true 后投递；显式 false 抑制并计数', () => {
    const queue = createCloudHostAuditQueue(true)
    const delivery = createCloudFileEventDelivery(queue)
    const submit = (report: Parameters<typeof delivery.audit>[0]) =>
      delivery.audit(report, identity)

    // Before the first beat answer there is no capability: suppressed, counted.
    expect(submit({ eventType: 'file_copy', result: 'success' })).toEqual({
      queued: false,
      reason: 'capability-unsupported'
    })
    expect(queue.gaps().suppressed).toBe(1)

    // The platform declares the capability: delivery opens.
    delivery.noteCapabilities({ fileEvents: true })
    expect(submit({ eventType: 'file_copy', result: 'success' }).queued).toBe(true)
    expect(queue.gaps().suppressed).toBe(1)

    // An explicit downgrade suppresses again.
    delivery.noteCapabilities({ fileEvents: false })
    expect(submit({ eventType: 'file_copy', result: 'success' })).toEqual({
      queued: false,
      reason: 'capability-unsupported'
    })
    expect(queue.gaps().suppressed).toBe(2)
    expect(delivery.capabilities()).toEqual({ fileEvents: false })
  })

  it('非能力字段（旧平台响应缺字段/坏形态）读作未声明，不投递', () => {
    const queue = createCloudHostAuditQueue(true)
    const delivery = createCloudFileEventDelivery(queue)
    delivery.noteCapabilities(undefined)
    delivery.noteCapabilities('junk')
    delivery.noteCapabilities({ noFileEvents: true })
    expect(delivery.capabilities()).toBeNull()
    expect(delivery.audit({ eventType: 'file_copy', result: 'success' }, identity)).toEqual({
      queued: false,
      reason: 'capability-unsupported'
    })
    expect(queue.gaps().suppressed).toBe(1)
  })
})
