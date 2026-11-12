import { describe, expect, it } from 'vitest'
import { createCloudAccessGuard } from './cloud-access-guard'
import {
  DEFAULT_READ_RATE,
  downloadAllowed,
  parseCloudPolicies,
  readRateFor,
  type CloudPolicies
} from './cloud-policies'

/**
 * Design §9.3: the policy pack is deny-by-default and arrives over the heartbeat.
 * A malformed pack must be treated as "not understood", never as "no limits" —
 * that distinction is what these cases pin.
 */

const pack = (overrides: Partial<Record<string, unknown>> = {}): unknown => ({
  downloadDefault: 'deny',
  projectOverrides: {},
  readRatePerHour: { calls: 10, bytes: 1024 },
  rateOverrides: {},
  ...overrides
})

describe('平台策略包解析', () => {
  it('完整策略包按字段解析', () => {
    const parsed = parseCloudPolicies(
      pack({
        projectOverrides: { proj_a: 'allow' },
        rateOverrides: { proj_a: { calls: 2, bytes: 4 } }
      })
    )
    expect(parsed).toEqual({
      downloadDefault: 'deny',
      projectDownloadOverrides: { proj_a: 'allow' },
      readRatePerHour: { calls: 10, bytes: 1024 },
      projectReadRateOverrides: { proj_a: { calls: 2, bytes: 4 } }
    })
  })

  it('缺少下载判定 → 整包不可用（而不是当作 allow）', () => {
    expect(parseCloudPolicies(pack({ downloadDefault: undefined }))).toBeNull()
    expect(parseCloudPolicies(pack({ downloadDefault: 'maybe' }))).toBeNull()
    expect(parseCloudPolicies(null)).toBeNull()
    expect(parseCloudPolicies('deny')).toBeNull()
  })

  it('非法限速回落到默认有界值，而不是无限', () => {
    const parsed = parseCloudPolicies(pack({ readRatePerHour: { calls: 0, bytes: -1 } }))
    expect(parsed?.readRatePerHour).toEqual(DEFAULT_READ_RATE)
    const partial = parseCloudPolicies(pack({ rateOverrides: { p: { calls: 'x' } } }))
    expect(partial?.projectReadRateOverrides).toEqual({})
  })

  it('项目覆盖优先于全局默认', () => {
    const policies: CloudPolicies = {
      downloadDefault: 'allow',
      projectDownloadOverrides: { proj_no: 'deny' },
      readRatePerHour: { calls: 10, bytes: 1024 },
      projectReadRateOverrides: { proj_tight: { calls: 1, bytes: 8 } }
    }
    expect(downloadAllowed(policies, 'proj_other')).toBe(true)
    expect(downloadAllowed(policies, 'proj_no')).toBe(false)
    expect(readRateFor(policies, 'proj_tight')).toEqual({ calls: 1, bytes: 8 })
    expect(readRateFor(policies, 'proj_other')).toEqual({ calls: 10, bytes: 1024 })
  })
})

describe('读取限速记账', () => {
  it('没有策略包时仍然有界，并且下载关闭', () => {
    const guard = createCloudAccessGuard(() => ({ policies: null }))
    expect(guard.downloadAllowed('proj_a')).toBe(false)
    expect(guard.usage('proj_a').rate).toEqual(DEFAULT_READ_RATE)
  })

  it('次数用尽后拒绝，窗口滑过后恢复', () => {
    let clock = 0
    const policies: CloudPolicies = {
      downloadDefault: 'deny',
      projectDownloadOverrides: {},
      readRatePerHour: { calls: 2, bytes: 1_000 },
      projectReadRateOverrides: {}
    }
    const guard = createCloudAccessGuard(() => ({ policies }), { now: () => clock })
    expect(guard.consumeRead('p')).toBe(true)
    expect(guard.consumeRead('p')).toBe(true)
    expect(guard.consumeRead('p')).toBe(false)

    clock += 59 * 60 * 1000
    expect(guard.consumeRead('p')).toBe(false)
    clock += 2 * 60 * 1000
    // The two early reads have aged out of the rolling hour.
    expect(guard.consumeRead('p')).toBe(true)
  })

  it('字节预算在回复后记账，并在下一次读取时生效', () => {
    const policies: CloudPolicies = {
      downloadDefault: 'deny',
      projectDownloadOverrides: {},
      readRatePerHour: { calls: 100, bytes: 10 },
      projectReadRateOverrides: {}
    }
    const guard = createCloudAccessGuard(() => ({ policies }))
    expect(guard.consumeRead('p')).toBe(true)
    guard.accountReply('p', 12)
    expect(guard.usage('p')).toEqual({ calls: 1, bytes: 12, rate: { calls: 100, bytes: 10 } })
    expect(guard.consumeRead('p')).toBe(false)
  })

  it('项目之间互不占用配额', () => {
    const policies: CloudPolicies = {
      downloadDefault: 'deny',
      projectDownloadOverrides: {},
      readRatePerHour: { calls: 1, bytes: 1_000 },
      projectReadRateOverrides: {}
    }
    const guard = createCloudAccessGuard(() => ({ policies }))
    expect(guard.consumeRead('a')).toBe(true)
    expect(guard.consumeRead('a')).toBe(false)
    expect(guard.consumeRead('b')).toBe(true)
  })
})
