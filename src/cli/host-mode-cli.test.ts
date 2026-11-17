import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  preflightHostModeRuntimeMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  preflightHostModeRuntimeMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    preflightHostModeRuntimeMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import {
  HOST_MODE_EXIT_CONFIGURATION,
  HOST_MODE_EXIT_OK,
  HOST_MODE_REQUIRED_ENV
} from '../shared/host-mode-contract'

const CLOUD_ENV = {
  ORCA_CLOUD_API_URL: 'https://cloud.example.com',
  ORCA_CLOUD_HOST_TOKEN: 'token',
  ORCA_CLOUD_HOST_NAME: 'host-a'
} as const

function serveArgs(): Record<string, unknown> {
  expect(serveOrcaAppMock).toHaveBeenCalledOnce()
  return serveOrcaAppMock.mock.calls[0]?.[0] as Record<string, unknown>
}

describe('host mode CLI entry', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  const priorExitCode = process.exitCode
  let errors: string[]
  let stderr: string[]
  let stdout: string[]

  beforeEach(() => {
    process.exitCode = 0
    serveOrcaAppMock.mockResolvedValue(0)
    preflightHostModeRuntimeMock.mockReset()
    preflightHostModeRuntimeMock.mockResolvedValue({
      id: 'runtime',
      ok: true,
      detail: 'orcad 0.1.0 on pinned Node 24.21.0'
    })
    errors = []
    stderr = []
    stdout = []
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '))
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    process.exitCode = priorExitCode
    vi.unstubAllGlobals()
    for (const name of HOST_MODE_REQUIRED_ENV) {
      delete process.env[name]
    }
  })

  it('promotes the top-level alias to the same serve invocation', async () => {
    await main(['--host-mode'], '/tmp/repo')
    const topLevel = serveArgs()
    expect(topLevel).toMatchObject({ hostMode: true, noPairing: true })

    serveOrcaAppMock.mockClear()
    await main(['serve', '--host-mode'], '/tmp/repo')
    expect(serveArgs()).toEqual(topLevel)
  })

  it('keeps --preflight side-effect free: no serve launch, no HTTP, token untouched', async () => {
    Object.assign(process.env, CLOUD_ENV)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await main(['--host-mode', '--preflight'], '/tmp/repo')

    expect(process.exitCode).toBe(HOST_MODE_EXIT_OK)
    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect(preflightHostModeRuntimeMock).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(process.env.ORCA_CLOUD_HOST_TOKEN).toBe('token')
    expect(errors.join('')).toBe('')
    expect(stderr.join('')).toBe('')
    expect(JSON.parse(stdout.join(''))).toEqual({
      ok: true,
      checks: [
        { id: 'config', ok: true, detail: null },
        { id: 'runtime', ok: true, detail: 'orcad 0.1.0 on pinned Node 24.21.0' }
      ]
    })
  })

  it('reports missing host configuration from preflight as a configuration exit', async () => {
    await main(['--host-mode', '--preflight'], '/tmp/repo')

    expect(process.exitCode).toBe(HOST_MODE_EXIT_CONFIGURATION)
    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    // Why not called: a broken config already decides the exit; the slot must not be materialized.
    expect(preflightHostModeRuntimeMock).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('ORCA_CLOUD_API_URL')
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: false,
      checks: [{ id: 'config', ok: false, detail: expect.stringContaining('ORCA_CLOUD_API_URL') }]
    })
  })

  it('reports an unavailable orcad slot as a configuration exit', async () => {
    Object.assign(process.env, CLOUD_ENV)
    preflightHostModeRuntimeMock.mockResolvedValue({
      id: 'runtime',
      ok: false,
      detail: 'this Orca install carries no orcad template'
    })

    await main(['--host-mode', '--preflight'], '/tmp/repo')

    expect(process.exitCode).toBe(HOST_MODE_EXIT_CONFIGURATION)
    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('no orcad template')
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: false,
      checks: [
        { id: 'config', ok: true },
        { id: 'runtime', ok: false, detail: 'this Orca install carries no orcad template' }
      ]
    })
  })

  it('prints usage plus valid flags for an unknown host-mode flag', async () => {
    await main(['--host-mode', '--bogus'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('Unknown flag --bogus')
    expect(errors.join('')).toContain('Valid flags:')
    expect(errors.join('')).toContain('--host-mode')
  })

  it('refuses interactive pairing flags in host mode', async () => {
    await main(['--host-mode', '--mobile-pairing'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('--mobile-pairing is not available in host mode')
  })

  it('requires --host-mode for --preflight', async () => {
    await main(['serve', '--preflight'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('--preflight requires --host-mode')
  })
})
