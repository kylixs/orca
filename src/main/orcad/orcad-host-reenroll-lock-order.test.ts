import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    acquire: vi.fn(() => {
      order.push('lock')
      return {
        path: '/data/orcad.lock',
        record: {
          pid: 1,
          startedAtMs: null,
          identity: 'me',
          version: '1',
          acquiredAt: new Date(0).toISOString(),
          nonce: 'n'
        },
        release: vi.fn()
      }
    }),
    beginReenrollment: vi.fn(() => {
      order.push('reenroll')
      return { rollback: vi.fn() }
    })
  }
})

vi.mock('./orcad-instance-lock', () => ({ acquireOrcadInstanceLock: calls.acquire }))
vi.mock('./host-credential-reenrollment', () => ({
  beginHostCredentialReenrollment: calls.beginReenrollment
}))
vi.mock('../persistence/profile-state/profile-state-access', () => ({
  acquireProfileStateRuntimeAdmission: () => ({ release: vi.fn() })
}))
vi.mock('./orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))
vi.mock('../runtime/runtime-browser-commands-factory', () => ({
  setRuntimeBrowserCommandsFactory: vi.fn()
}))

import { startOrcadWithHost } from './orcad-lifecycle'

describe('--reenroll runs inside the orcad instance lock', () => {
  beforeEach(() => {
    calls.order.length = 0
    vi.clearAllMocks()
  })

  it('takes the lock before it reads or renames any credential', async () => {
    calls.order.length = 0
    await startOrcadWithHost(
      '/data',
      async () => {
        calls.order.push('start')
        return { readiness: 'ready' }
      },
      () => {},
      { reenroll: true }
    )

    expect(calls.order).toEqual(['lock', 'reenroll', 'start'])
  })

  it('never touches the credential when the flag is absent', async () => {
    calls.order.length = 0
    await startOrcadWithHost(
      '/data',
      async () => ({ readiness: 'ready' }),
      () => {}
    )

    expect(calls.acquire).toHaveBeenCalled()
    expect(calls.beginReenrollment).not.toHaveBeenCalled()
  })

  it('rolls the credential back when startup after re-enrolment fails', async () => {
    const rollback = vi.fn()
    calls.beginReenrollment.mockReturnValueOnce({ rollback })

    await expect(
      startOrcadWithHost(
        '/data',
        async () => {
          throw new Error('registration failed')
        },
        () => {},
        { reenroll: true }
      )
    ).rejects.toThrow('registration failed')

    expect(rollback).toHaveBeenCalledOnce()
  })
})
