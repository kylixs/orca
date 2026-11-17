import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudHostEnrolmentFailure } from '../cloud-platform/cloud-host-enrollment'
import { startCloudRuntimeAdmission } from '../startup/cloud-runtime-admission'
import { enrollHostCredential } from '../startup/cloud-host-enrolment-startup'
import { awaitHostModeEnrolment, hostModeFailurePhase } from './host-mode-enrolment'
import { admitOrcadCloudRuntime } from './orcad-host-mode-startup'
import { resolveOrcadExitCode } from './orcad-exit-code'
import { beginHostModeState, recordHostModeEnrolmentFailure } from './orcad-host-mode-state'

function admission(ready: Promise<void>): { ready: Promise<void> } {
  return { ready }
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

describe('host mode enrolment classification', () => {
  let dir: string
  let context: ReturnType<typeof beginHostModeState>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-host-enrolment-exit-'))
    context = beginHostModeState({
      userDataPath: dir,
      pid: 1234,
      startedAt: 1_700_000_000_000,
      hostName: 'host-a',
      platformUrl: 'https://cloud.example.com'
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function readState(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readFileSync(context.statePath, 'utf-8'))
    if (!isRecord(parsed)) {
      throw new Error('host state file is not an object')
    }
    return parsed
  }

  function recordFailure(failure: CloudHostEnrolmentFailure): void {
    recordHostModeEnrolmentFailure(context, {
      code: failure.code,
      retryable: failure.retryable,
      phase: hostModeFailurePhase(failure.code)
    })
  }

  it('keeps running once admission is ready', async () => {
    await expect(awaitHostModeEnrolment(admission(Promise.resolve()))).resolves.toBeUndefined()
  })

  // Contract §3.3: the exit code and the state verdict come from one classification.
  it.each([
    {
      httpStatus: 401,
      code: 'host_token_invalid',
      retryable: false,
      exitCode: 78,
      phase: 'enrolment'
    },
    { httpStatus: 409, code: 'host_revoked', retryable: false, exitCode: 78, phase: 'enrolment' },
    {
      httpStatus: 400,
      code: 'host_name_required',
      retryable: false,
      exitCode: 78,
      phase: 'enrolment'
    },
    { httpStatus: 201, code: 'protocol', retryable: false, exitCode: 78, phase: 'enrolment' },
    { code: 'credential_write_failed', retryable: false, exitCode: 78, phase: 'enrolment' },
    { code: 'host_config_invalid', retryable: false, exitCode: 78, phase: 'config' },
    { code: 'runtime_unavailable', retryable: false, exitCode: 78, phase: 'runtime' },
    { code: 'profile_in_use', retryable: false, exitCode: 78, phase: 'enrolment' },
    {
      httpStatus: 403,
      code: 'register_failed',
      retryable: false,
      exitCode: 78,
      phase: 'enrolment'
    },
    { code: 'network', retryable: true, exitCode: 1, phase: 'enrolment' },
    { httpStatus: 503, code: 'http_5xx', retryable: true, exitCode: 1, phase: 'enrolment' },
    { code: 'heartbeat_failed', retryable: true, exitCode: 1, phase: 'enrolment' },
    {
      httpStatus: 401,
      code: 'heartbeat_unauthorized',
      retryable: false,
      exitCode: 78,
      phase: 'enrolment'
    }
  ])(
    'maps $code to exit $exitCode and persists errorCode/retryable',
    async ({ httpStatus, code, retryable, exitCode, phase }) => {
      const failure = new CloudHostEnrolmentFailure({ code, retryable, httpStatus })
      const onFailure = vi.fn(recordFailure)

      const thrown = await capture(
        awaitHostModeEnrolment(admission(Promise.reject(failure)), true, onFailure)
      )

      expect(thrown).toBe(failure)
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure)
      expect(resolveOrcadExitCode(thrown)).toBe(exitCode)
      expect(readState()).toMatchObject({
        status: 'error',
        phase,
        lastErrorCode: code,
        retryable
      })
    }
  )

  // P2-11: a 201 whose body is unreadable must stay protocol/enrolment, not runtime_unavailable.
  it('keeps a malformed 201 response as protocol/enrolment with exit 78', async () => {
    const enrolmentError = await capture(
      enrollHostCredential({
        apiUrl: 'https://cloud.example.com',
        hostToken: 'host-token',
        hostName: 'host-a',
        directAddrs: [],
        retry: {
          enabled: true,
          fetchImpl: async () => new Response('not-json', { status: 201 }),
          retryDelaysMs: [],
          sleep: () => Promise.resolve()
        }
      })
    )
    const onFailure = vi.fn(recordFailure)

    const thrown = await capture(
      awaitHostModeEnrolment(admission(Promise.reject(enrolmentError)), true, onFailure)
    )

    expect(thrown).toMatchObject({ code: 'protocol', retryable: false, httpStatus: 201 })
    expect(resolveOrcadExitCode(thrown)).toBe(78)
    expect(readState()).toMatchObject({
      status: 'error',
      phase: 'enrolment',
      lastErrorCode: 'protocol',
      retryable: false
    })
  })

  it('keeps actionable guidance for the terminal registration failures', async () => {
    const cases = [
      [401, 'host_token_invalid', /重新生成安装命令/],
      [409, 'host_revoked', /恢复.*主机名|更换主机名/],
      [400, 'host_name_required', /ORCA_CLOUD_HOST_NAME/]
    ] as const
    for (const [status, code, guidance] of cases) {
      const failure = new CloudHostEnrolmentFailure({ code, retryable: false, httpStatus: status })
      const thrown = await capture(awaitHostModeEnrolment(admission(Promise.reject(failure))))
      if (!(thrown instanceof Error)) {
        throw new Error('expected an enrolment error')
      }
      expect(thrown.message).toMatch(guidance)
    }
  })

  // Contract §3.3: the missing host name is thrown synchronously, before `ready`.
  it('maps a missing host name to exit 78 and persists the verdict', () => {
    let thrown: unknown
    try {
      admitOrcadCloudRuntime({
        create: () =>
          startCloudRuntimeAdmission({
            ORCA_CLOUD_API_URL: 'https://cloud.example.com',
            ORCA_CLOUD_HOST_TOKEN: 'host-token'
          }),
        state: context
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CloudHostEnrolmentFailure)
    expect(thrown).toMatchObject({ code: 'host_name_required', retryable: false })
    expect(resolveOrcadExitCode(thrown)).toBe(78)
    expect(readState()).toMatchObject({
      status: 'error',
      phase: 'enrolment',
      lastErrorCode: 'host_name_required',
      retryable: false
    })
  })

  it('treats a missing admission as a configuration fault', async () => {
    const onFailure = vi.fn(recordFailure)
    const thrown = await capture(awaitHostModeEnrolment(null, true, onFailure))

    expect(thrown).toBeInstanceOf(CloudHostEnrolmentFailure)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(resolveOrcadExitCode(thrown)).toBe(78)
    expect(readState()).toMatchObject({
      status: 'error',
      phase: 'config',
      lastErrorCode: 'host_config_invalid',
      retryable: false
    })
  })

  it('treats an unknown admission rejection as a retryable failure', async () => {
    const thrown = await capture(
      awaitHostModeEnrolment(admission(Promise.reject(new Error('boom'))), true, recordFailure)
    )

    expect(thrown).toMatchObject({ code: 'runtime_unavailable', retryable: false })
    expect(resolveOrcadExitCode(thrown)).toBe(78)
  })
})
