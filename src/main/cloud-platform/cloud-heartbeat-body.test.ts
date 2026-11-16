import { describe, expect, it } from 'vitest'
import { cloudHeartbeatBody } from './cloud-heartbeat-body'

/** U147: the version the host is running, reported so the platform can show it. */

describe('宿主心跳版本上报', () => {
  it('来源有值时携带 orcaVersion', () => {
    const body = cloudHeartbeatBody({ orcaVersion: () => '1.4.178' }, [], [])
    expect(body.orcaVersion).toBe('1.4.178')
  })

  it('来源缺失、为空或为 null 时省略字段，心跳保持字节稳定', () => {
    expect(cloudHeartbeatBody({}, [], [])).not.toHaveProperty('orcaVersion')
    expect(cloudHeartbeatBody({ orcaVersion: () => null }, [], [])).not.toHaveProperty('orcaVersion')
    expect(cloudHeartbeatBody({ orcaVersion: () => '' }, [], [])).not.toHaveProperty('orcaVersion')
  })
})
