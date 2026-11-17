import { describe, expect, it, vi } from 'vitest'
import type { AttachableCloudAdmission } from '../startup/cloud-runtime-attach'
import {
  ensureOrcadAppVersion,
  startOrcadRpc,
  type OrcadAdmissionAttach
} from './orcad-cloud-admission'

function fakeAdmission(): AttachableCloudAdmission {
  return { bindRuntime: vi.fn(), client: null, ready: Promise.resolve() }
}

describe('orcad cloud admission wiring', () => {
  it('attaches admission once before the RPC transport starts', async () => {
    const events: string[] = []
    const admission = fakeAdmission()
    const attach: OrcadAdmissionAttach = vi.fn(() => {
      events.push('attach')
    })
    const start = vi.fn(async () => {
      events.push('start')
    })

    await startOrcadRpc({ start }, admission, attach)

    expect(attach).toHaveBeenCalledExactlyOnceWith(admission)
    expect(start).toHaveBeenCalledOnce()
    expect(events).toEqual(['attach', 'start'])
  })

  it('starts without a cloud admission exactly as before', async () => {
    const attach: OrcadAdmissionAttach = vi.fn()
    const start = vi.fn(async () => {})

    await startOrcadRpc({ start }, null, attach)

    expect(attach).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledOnce()
  })
})

describe('orcad app version', () => {
  it('fills ORCA_APP_VERSION from ORCA_VERSION when unset', () => {
    const env: NodeJS.ProcessEnv = { ORCA_VERSION: '1.2.3-orcad' }

    ensureOrcadAppVersion(env)

    expect(env.ORCA_APP_VERSION).toBe('1.2.3-orcad')
  })

  it('keeps an existing ORCA_APP_VERSION', () => {
    const env: NodeJS.ProcessEnv = { ORCA_APP_VERSION: '9.9.9', ORCA_VERSION: '1.2.3-orcad' }

    ensureOrcadAppVersion(env)

    expect(env.ORCA_APP_VERSION).toBe('9.9.9')
  })

  it('falls back to the orcad placeholder when neither is set', () => {
    const env: NodeJS.ProcessEnv = {}

    ensureOrcadAppVersion(env)

    expect(env.ORCA_APP_VERSION).toBe('0.0.0-orcad')
  })
})
