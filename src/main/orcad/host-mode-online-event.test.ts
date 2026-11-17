import { describe, expect, it } from 'vitest'
import { formatHostModeOnlineEvent } from './host-mode-online-event'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

describe('orca_host_online event line', () => {
  it('formats exactly the four H8b fields and nothing credential-bearing', () => {
    const line = formatHostModeOnlineEvent({
      hostId: 'host_abc',
      platformUrl: 'https://cloud.example.com',
      lastHeartbeatAt: 1_700_000_010_000
    })

    expect(line).toBe(
      '{"event":"orca_host_online","hostId":"host_abc","platformUrl":"https://cloud.example.com","lastHeartbeatAt":1700000010000}'
    )
    const parsed: unknown = JSON.parse(line)
    expect(parsed).toEqual({
      event: 'orca_host_online',
      hostId: 'host_abc',
      platformUrl: 'https://cloud.example.com',
      lastHeartbeatAt: 1_700_000_010_000
    })
    if (!isRecord(parsed)) {
      throw new Error('event line is not a JSON object')
    }
    expect(Object.keys(parsed)).toEqual([
      'event',
      'hostId',
      'platformUrl',
      'lastHeartbeatAt'
    ])
  })
})
