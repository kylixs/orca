import { describe, expect, it } from 'vitest'
import { CloudHostEnrolmentFailure } from '../cloud-platform/cloud-host-enrollment'
import { awaitHostModeEnrolment } from './host-mode-enrolment'
import { resolveOrcadExitCode } from './orcad-exit-code'

function admission(ready: Promise<void>): { ready: Promise<void> } {
  return { ready }
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  )
}

describe('host mode enrolment classification', () => {
  it('keeps running once admission is ready', async () => {
    await expect(awaitHostModeEnrolment(admission(Promise.resolve()))).resolves.toBeUndefined()
  })

  it.each([
    [401, 'host_token_invalid', /重新生成安装命令/],
    [409, 'host_revoked', /恢复.*主机名|更换主机名/],
    [400, 'host_name_required', /ORCA_CLOUD_HOST_NAME/]
  ])('maps %i (%s) to exit 78 with actionable guidance', async (status, code, guidance) => {
    const failure = new CloudHostEnrolmentFailure({
      code,
      retryable: false,
      httpStatus: status
    })

    const thrown = await capture(awaitHostModeEnrolment(admission(Promise.reject(failure))))

    expect(thrown).toBe(failure)
    expect(thrown).toMatchObject({ code, retryable: false, httpStatus: status })
    expect((thrown as Error).message).toMatch(guidance)
    expect(resolveOrcadExitCode(thrown)).toBe(78)
  })

  it('keeps network exhaustion retryable and exits 1', async () => {
    const failure = new CloudHostEnrolmentFailure({ code: 'network', retryable: true })

    const thrown = await capture(awaitHostModeEnrolment(admission(Promise.reject(failure))))

    expect(thrown).toMatchObject({ code: 'network', retryable: true })
    expect(resolveOrcadExitCode(thrown)).toBe(1)
  })

  it('treats a missing admission as a configuration fault', async () => {
    const thrown = await capture(awaitHostModeEnrolment(null))

    expect(thrown).toBeInstanceOf(CloudHostEnrolmentFailure)
    expect(resolveOrcadExitCode(thrown)).toBe(78)
  })
})
