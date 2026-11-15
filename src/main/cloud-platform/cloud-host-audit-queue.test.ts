import { describe, expect, it } from 'vitest'
import { createCloudHostAuditQueue, MAX_EVENTS_PER_BEAT } from './cloud-host-audit'
import { cloudHeartbeatBody } from './cloud-heartbeat-body'

/** R-01/R-04: file events ride the queue with their own outcomes, the per-beat
 * split matches the platform's 100-report parse cap, and an overflow is counted
 * into the heartbeat's `auditGap` instead of dropped silently. */

const FILE_COPY = {
  eventType: 'file_copy',
  result: 'success',
  deviceId: 'dev-1',
  subject: 'user:zhangsan',
  projectId: 'proj-1',
  traceId: 'tr_a',
  metadata: { fileName: 'a.ts', path: 'src/a.ts', copyKind: 'content-whole' }
} as const

describe('createCloudHostAuditQueue（U66 文件事件 + auditGap）', () => {
  it('文件事件保留声明的 result 与 traceId/metadata，拒绝类事件仍默认 denied', () => {
    const queue = createCloudHostAuditQueue(true)
    queue(FILE_COPY)
    queue({ eventType: 'method_denied', deviceId: 'dev-1', method: 'settings.update' })
    const batch = queue.take()
    expect(batch.events).toHaveLength(2)
    expect(batch.events[0]).toMatchObject({
      eventType: 'file_copy',
      result: 'success',
      traceId: 'tr_a',
      metadata: { fileName: 'a.ts' }
    })
    expect(batch.events[1]).toMatchObject({ eventType: 'method_denied', result: 'denied' })
  })

  it('take 每拍最多 100 条，余量留在下一拍（修复 §1.3 的静默丢失）', () => {
    const queue = createCloudHostAuditQueue(true)
    for (let index = 0; index < 150; index += 1) {
      queue({ eventType: 'file_copy', result: 'success', traceId: `tr_${index}` })
    }
    const first = queue.take()
    expect(first.events).toHaveLength(MAX_EVENTS_PER_BEAT)
    queue.clearThrough(first.seq)
    expect(queue.pending()).toBe(50)
    const second = queue.take()
    expect(second.events).toHaveLength(50)
    queue.clearThrough(second.seq)
    expect(queue.pending()).toBe(0)
  })

  it('超限丢最旧时计入 dropped，auditGap 随心跳携带', () => {
    const queue = createCloudHostAuditQueue(true)
    for (let index = 0; index < 205; index += 1) {
      queue({ eventType: 'file_copy', result: 'success', traceId: `tr_${index}` })
    }
    expect(queue.pending()).toBe(200)
    const gaps = queue.gaps()
    expect(gaps.dropped).toBe(5)
    expect(gaps.bootId).not.toBe('')

    queue.noteRateLimited()
    queue.noteSuppressed(3)
    const body = cloudHeartbeatBody({}, [], [], queue.gaps())
    expect(body.auditGap).toMatchObject({ dropped: 5, rateLimited: 1, suppressed: 3 })
  })

  it('无缺口的心跳不带 auditGap 字段；未启用的队列静默丢弃且无计数', () => {
    const quiet = cloudHeartbeatBody({}, [], [])
    expect(quiet.auditGap).toBeUndefined()

    const disabled = createCloudHostAuditQueue(false)
    disabled(FILE_COPY)
    expect(disabled.pending()).toBe(0)
    expect(disabled.gaps().dropped).toBe(0)
  })

  it('mergeSavedName 合并到同 traceId 的待发下载；找不到时返回 false', () => {
    const queue = createCloudHostAuditQueue(true)
    queue({
      eventType: 'file_download',
      result: 'success',
      deviceId: 'dev-1',
      traceId: 'tr_dl',
      metadata: { path: 'src/app.ts' }
    })
    expect(queue.mergeSavedName('tr_dl', 'dev-1', 'app.ts')).toBe(true)
    expect(queue.take().events[0].metadata).toMatchObject({
      path: 'src/app.ts',
      savedName: 'app.ts'
    })

    const other = createCloudHostAuditQueue(true)
    expect(other.mergeSavedName('tr_none', 'dev-1', 'app.ts')).toBe(false)
  })
})
