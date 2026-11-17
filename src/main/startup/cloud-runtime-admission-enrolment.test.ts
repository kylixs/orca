import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CloudHostEnrolmentFailure,
  CLOUD_HOST_CREDENTIAL_FILENAME,
  readStoredHostCredential,
  storeHostCredential
} from '../cloud-platform/cloud-host-enrollment'
import { resolveOrcadExitCode } from '../orcad/orcad-exit-code'
import { startCloudRuntimeAdmission } from './cloud-runtime-admission'

const ENV: NodeJS.ProcessEnv = {
  ORCA_CLOUD_API_URL: 'https://platform.test',
  ORCA_CLOUD_HOST_TOKEN: 'one-time-token',
  ORCA_CLOUD_HOST_NAME: 'host-a'
}

const CREDENTIAL = {
  hostId: 'host_1',
  hostName: 'host-a',
  credential: 'cred_1',
  registeredAt: 1_000
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function heartbeatOk(): Response {
  return json(200, {
    policyVersion: 1,
    policies: {},
    revoked: {},
    maintenance: null,
    hostRevoked: false,
    provisionAssignments: [],
    auditCapabilities: { fileEvents: false }
  })
}

type RegisterAnswer = () => Response

function fakePlatform(register: RegisterAnswer): {
  fetchImpl: typeof fetch
  registerCalls: () => number
  heartbeatCalls: () => number
  urls: () => string[]
} {
  let registerCalls = 0
  let heartbeatCalls = 0
  const urls: string[] = []
  return {
    fetchImpl: async (input) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith('/v1/hosts/register')) {
        registerCalls += 1
        return register()
      }
      if (url.endsWith('/v1/jwks')) {
        return json(200, { keys: [] })
      }
      if (url.includes('/heartbeat')) {
        heartbeatCalls += 1
        return heartbeatOk()
      }
      throw new Error(`unexpected request: ${url}`)
    },
    registerCalls: () => registerCalls,
    heartbeatCalls: () => heartbeatCalls,
    urls: () => urls
  }
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  )
}

const dirs: string[] = []

function userDataPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-enrolment-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('host-mode registration wiring', () => {
  it('registers with no credential, persists the 201 credential and spends the token', async () => {
    let tokenUsed = false
    const platform = fakePlatform(() => {
      if (tokenUsed) {
        return json(401, { error: { code: 'HOST_TOKEN_INVALID' } })
      }
      tokenUsed = true
      return json(201, { hostId: CREDENTIAL.hostId, credential: CREDENTIAL.credential })
    })
    const dir = userDataPath()

    const admission = startCloudRuntimeAdmission(ENV, {
      userDataPath: dir,
      fetchImpl: platform.fetchImpl
    })
    expect(admission).not.toBeNull()
    await admission!.ready

    expect(platform.registerCalls()).toBe(1)
    expect(tokenUsed).toBe(true)
    expect(readStoredHostCredential(dir)).toMatchObject({
      hostId: CREDENTIAL.hostId,
      credential: CREDENTIAL.credential
    })
    if (process.platform !== 'win32') {
      const credentialPath = join(dir, CLOUD_HOST_CREDENTIAL_FILENAME)
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600)
    }
    admission!.stop()
  })

  it('maps a 401 to a non-retryable configuration failure without writing a credential', async () => {
    const platform = fakePlatform(() => json(401, { error: { code: 'HOST_TOKEN_INVALID' } }))
    const dir = userDataPath()

    const admission = startCloudRuntimeAdmission(ENV, {
      userDataPath: dir,
      retryEnrolment: true,
      retryDelaysMs: [0, 0],
      fetchImpl: platform.fetchImpl
    })
    const thrown = await capture(admission!.ready)

    expect(thrown).toBeInstanceOf(CloudHostEnrolmentFailure)
    expect(thrown).toMatchObject({
      code: 'host_token_invalid',
      retryable: false,
      httpStatus: 401
    })
    expect(platform.registerCalls()).toBe(1)
    expect(readStoredHostCredential(dir)).toBeNull()
    expect(resolveOrcadExitCode(thrown)).toBe(78)
  })

  it('retries network failures a bounded number of times, then exits 1', async () => {
    const platform = fakePlatform(() => {
      throw new Error('connect ECONNREFUSED')
    })
    const dir = userDataPath()

    const admission = startCloudRuntimeAdmission(ENV, {
      userDataPath: dir,
      retryEnrolment: true,
      retryDelaysMs: [0, 0],
      fetchImpl: platform.fetchImpl
    })
    const thrown = await capture(admission!.ready)

    expect(platform.registerCalls()).toBe(3)
    expect(thrown).toMatchObject({ code: 'network', retryable: true })
    expect(resolveOrcadExitCode(thrown)).toBe(1)
    expect(readStoredHostCredential(dir)).toBeNull()
  })

  it('reuses a stored credential and makes zero registration calls', async () => {
    const dir = userDataPath()
    storeHostCredential(dir, CREDENTIAL)
    const platform = fakePlatform(() => {
      throw new Error('registration must not run with a stored credential')
    })

    const admission = startCloudRuntimeAdmission(ENV, {
      userDataPath: dir,
      retryEnrolment: true,
      retryDelaysMs: [0],
      fetchImpl: platform.fetchImpl
    })
    await admission!.ready

    expect(platform.registerCalls()).toBe(0)
    expect(platform.heartbeatCalls()).toBe(1)
    expect(admission!.host()?.hostId).toBe(CREDENTIAL.hostId)
    admission!.stop()
  })
})
