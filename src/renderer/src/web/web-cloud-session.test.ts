import { describe, expect, it } from 'vitest'
import { parseConnectTicketReply } from '../../../shared/cloud-platform-reply'
import {
  cloudPairingOfferFromTicket,
  listCloudProjects,
  loginToCloud,
  requestCloudTicket,
  WebCloudSessionError,
  type WebCloudSession
} from './web-cloud-session'
import { requestCloudPairingOffer } from './web-cloud-connection-offer'
import { webRuntimeSubprotocols } from './web-pairing'

/** Standard base64 with `+`, `/` and padding, to prove canonicalisation. */
const DEVICE_KEY_B64 = Buffer.alloc(32, 0xfb).toString('base64')
const DEVICE_KEY_B64_URL = DEVICE_KEY_B64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const HOST_KEY_B64 = Buffer.alloc(32, 0x07).toString('base64')

const LOGIN_BODY = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  user: {
    id: 'user-1',
    username: 'zhangsan',
    displayName: '张三',
    dept: '支付',
    roles: ['developer'],
    permissions: ['read']
  },
  device: { id: 'device-1', name: 'm48-web' }
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(claims)}.signature`
}

const TICKET_CREDENTIAL = jwt({
  deviceToken: 'device-token-1',
  deviceId: 'device-1',
  devicePubKey: DEVICE_KEY_B64,
  host: 'host-1',
  perms: ['open', 'terminal', 'bogus']
})

/** A second, freshly signed ticket: the one a child socket would present. */
const SECOND_TICKET_CREDENTIAL = jwt({
  deviceToken: 'device-token-2',
  deviceId: 'device-1',
  devicePubKey: DEVICE_KEY_B64,
  host: 'host-1',
  perms: ['open', 'terminal']
})

function ticketBody(): Record<string, unknown> {
  return {
    credential: TICKET_CREDENTIAL,
    expiresIn: 300,
    host: {
      id: 'host-1',
      name: 'dev-m48',
      fingerprint: 'fp',
      tlsFingerprint: 'tf',
      e2eePublicKeyB64: HOST_KEY_B64,
      capabilities: ['terminal']
    },
    endpoints: {
      direct: [
        { priority: 2, url: 'wss://second.example' },
        { priority: 1, url: 'wss://first.example' }
      ],
      relay: [{ priority: 99, url: 'wss://relay.example', sni: 'relay.example' }]
    },
    workspace: { projectRoot: '/p', projectName: 'm48', workspaceRoot: '/w', defaultBranch: 'main' }
  }
}

function parsedTicket(body: Record<string, unknown>) {
  const ticket = parseConnectTicketReply(body)
  if (ticket === null) {
    throw new Error('fixture ticket is malformed')
  }
  return ticket
}

function signedInSession(): WebCloudSession {
  return {
    apiUrl: 'http://platform.test',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    user: {
      id: 'user-1',
      username: 'zhangsan',
      displayName: '张三',
      dept: null,
      roles: [],
      permissions: []
    },
    deviceId: 'device-1',
    obtainedAtMs: 0
  }
}

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function errorReply(code: string, status: number): Response {
  return jsonReply({ error: { code, message: `platform said ${code}` } }, status)
}

type ScriptedReply = Response | (() => Response)

function scriptedFetch(replies: ScriptedReply[]): {
  fetchImpl: typeof fetch
  calls: { url: string; method: string }[]
} {
  const calls: { url: string; method: string }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    const reply = replies.shift()
    if (!reply) {
      throw new Error(`unexpected request ${url}`)
    }
    return typeof reply === 'function' ? reply() : reply
  }
  return { fetchImpl, calls }
}

function loginInput(fetchImpl: typeof fetch, devicePublicKeyB64 = DEVICE_KEY_B64) {
  return {
    apiUrl: 'http://platform.test/',
    username: 'zhangsan',
    password: 'Passw0rd!',
    devicePublicKeyB64,
    deviceName: 'm48-web',
    fetchImpl,
    now: () => 1_700_000_000_000
  }
}

async function captureError(run: () => Promise<unknown>): Promise<WebCloudSessionError> {
  const error = await run().then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(WebCloudSessionError)
  if (!(error instanceof WebCloudSessionError)) {
    throw new Error('expected WebCloudSessionError')
  }
  return error
}

describe('browser cloud login, project list and ticket', () => {
  it('turns the real contract into a well-formed cloud offer', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonReply(LOGIN_BODY),
      jsonReply({
        projects: [
          {
            id: 'proj-1',
            key: 'm48',
            name: 'M48',
            hostName: 'dev-m48',
            hostStatus: 'online',
            permissions: ['open', 'terminal']
          },
          {
            id: 'proj-2',
            key: 'dl',
            name: 'Downloads',
            hostName: null,
            hostStatus: 'online',
            permissions: ['open', 'download']
          }
        ]
      }),
      jsonReply(ticketBody())
    ])

    const session = await loginToCloud(loginInput(fetchImpl))
    expect(session).toMatchObject({
      apiUrl: 'http://platform.test',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      deviceId: 'device-1',
      obtainedAtMs: 1_700_000_000_000
    })
    expect(session.user).toEqual({
      id: 'user-1',
      username: 'zhangsan',
      displayName: '张三',
      dept: '支付',
      roles: ['developer'],
      permissions: ['read']
    })

    const projects = await listCloudProjects(session, { fetchImpl })
    expect(projects).toEqual([
      {
        id: 'proj-1',
        key: 'm48',
        name: 'M48',
        hostName: 'dev-m48',
        hostStatus: 'online',
        downloadRestricted: true,
        status: null,
        provisioningError: null
      },
      {
        id: 'proj-2',
        key: 'dl',
        name: 'Downloads',
        hostName: null,
        hostStatus: 'online',
        downloadRestricted: false,
        status: null,
        provisioningError: null
      }
    ])

    const ticket = await requestCloudTicket(session, 'proj-1', DEVICE_KEY_B64_URL, { fetchImpl })
    expect(ticket.credential).toBe(TICKET_CREDENTIAL)
    expect(ticket.host.e2eePublicKeyB64).toBe(HOST_KEY_B64)

    const offer = cloudPairingOfferFromTicket(ticket, DEVICE_KEY_B64_URL)
    expect(offer).toMatchObject({
      v: 2,
      endpoint: 'wss://first.example',
      deviceToken: 'device-token-1',
      publicKeyB64: HOST_KEY_B64,
      pairedDeviceId: 'device-1',
      scope: 'runtime',
      cloud: { credential: TICKET_CREDENTIAL, devicePublicKeyB64: DEVICE_KEY_B64 }
    })

    expect(calls.map((call) => call.url)).toEqual([
      'http://platform.test/v1/auth/login',
      'http://platform.test/v1/projects',
      'http://platform.test/v1/projects/proj-1/connect'
    ])
  })

  it('yields exactly the credential and device subprotocols for the offer', async () => {
    const { fetchImpl } = scriptedFetch([jsonReply(ticketBody())])
    const ticket = await requestCloudTicket(signedInSession(), 'proj-1', DEVICE_KEY_B64, {
      fetchImpl
    })
    const offer = cloudPairingOfferFromTicket(ticket, DEVICE_KEY_B64)

    expect(webRuntimeSubprotocols(offer)).toEqual([
      'orca-runtime',
      `orca-cred.${TICKET_CREDENTIAL}`,
      `orca-device.${DEVICE_KEY_B64_URL}`
    ])
  })

  it('signs each offer from its own ticket: two calls, two connect requests', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonReply(ticketBody()),
      jsonReply({ ...ticketBody(), credential: SECOND_TICKET_CREDENTIAL })
    ])

    const first = await requestCloudPairingOffer(signedInSession(), 'proj-1', DEVICE_KEY_B64, {
      fetchImpl
    })
    const second = await requestCloudPairingOffer(signedInSession(), 'proj-1', DEVICE_KEY_B64, {
      fetchImpl
    })

    // A child socket signs its own short-lived ticket, so two subscriptions never
    // share a credential (the U14 replay failure).
    expect(first.cloud?.credential).toBe(TICKET_CREDENTIAL)
    expect(second.cloud?.credential).toBe(SECOND_TICKET_CREDENTIAL)
    expect(second.endpoint).toBe(first.endpoint)
    expect(second.deviceToken).not.toBe(first.deviceToken)
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST http://platform.test/v1/projects/proj-1/connect',
      'POST http://platform.test/v1/projects/proj-1/connect'
    ])
  })

  it('surfaces a platform ticket failure from the re-signing path', async () => {
    const { fetchImpl } = scriptedFetch([errorReply('SESSION_EXPIRED', 401)])
    const error = await captureError(() =>
      requestCloudPairingOffer(signedInSession(), 'proj-1', DEVICE_KEY_B64, { fetchImpl })
    )
    expect(error.code).toBe('SESSION_EXPIRED')
  })

  it('drops malformed project rows instead of failing the whole list', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonReply(LOGIN_BODY),
      jsonReply({
        projects: [
          { id: 'proj-1', key: 'one', name: 'One', hostName: null, hostStatus: 'online' },
          { id: 'proj-broken' },
          'not an object',
          { id: 'proj-2', key: 'two', name: 'Two', hostStatus: 'offline', permissions: [] }
        ]
      })
    ])
    const session = await loginToCloud(loginInput(fetchImpl))

    const projects = await listCloudProjects(session, { fetchImpl })
    expect(projects.map((project) => project.id)).toEqual(['proj-1', 'proj-2'])
    expect(projects[1]?.hostName).toBeNull()
    expect(projects[1]?.downloadRestricted).toBe(true)
  })

  it('a 401 refreshes once and retries the project list with the rotated token', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonReply({ ...LOGIN_BODY, expiresIn: 300 }),
      errorReply('SESSION_EXPIRED', 401),
      jsonReply({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 300 }),
      jsonReply({ projects: [] })
    ])
    const session = await loginToCloud(loginInput(fetchImpl))

    const projects = await listCloudProjects(session, { fetchImpl })
    expect(projects).toEqual([])
    expect(session.auth?.accessToken).toBe('access-2')
    expect(session.auth?.refreshToken).toBe('refresh-2')
    expect(calls.map((call) => call.url)).toEqual([
      'http://platform.test/v1/auth/login',
      'http://platform.test/v1/projects',
      'http://platform.test/v1/auth/refresh',
      'http://platform.test/v1/projects'
    ])
  })

  it('a second 401 after the refresh surfaces SESSION_EXPIRED without retrying again', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      jsonReply({ ...LOGIN_BODY, expiresIn: 300 }),
      errorReply('SESSION_EXPIRED', 401),
      jsonReply({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 300 }),
      errorReply('SESSION_EXPIRED', 401)
    ])
    const session = await loginToCloud(loginInput(fetchImpl))

    const error = await captureError(() => listCloudProjects(session, { fetchImpl }))
    expect(error.code).toBe('SESSION_EXPIRED')
    expect(error.status).toBe(401)
    expect(calls.filter((call) => call.url.endsWith('/v1/auth/refresh'))).toHaveLength(1)
  })

  it('surfaces INVALID_CREDENTIALS from login and returns no session', async () => {
    const { fetchImpl } = scriptedFetch([errorReply('INVALID_CREDENTIALS', 401)])
    const error = await captureError(() => loginToCloud(loginInput(fetchImpl)))
    expect(error.code).toBe('INVALID_CREDENTIALS')
    expect(error.status).toBe(401)
  })

  it.each([
    ['HOST_OFFLINE', 409],
    ['VERSION_UNSUPPORTED', 426],
    ['DEVICE_KEY_MISMATCH', 401],
    ['PROJECT_NOT_FOUND', 404]
  ])('surfaces the %s platform code from a ticket request', async (code, status) => {
    const { fetchImpl } = scriptedFetch([errorReply(code, status)])
    const error = await captureError(() =>
      requestCloudTicket(signedInSession(), 'proj-1', DEVICE_KEY_B64, { fetchImpl })
    )
    expect(error.code).toBe(code)
    expect(error.status).toBe(status)
  })

  it('throws malformed_reply for a 200 body that does not parse', async () => {
    const { fetchImpl } = scriptedFetch([
      () => new Response('<html>proxy page</html>', { status: 200 })
    ])
    const error = await captureError(() => loginToCloud(loginInput(fetchImpl)))
    expect(error.code).toBe('malformed_reply')
  })

  it('throws malformed_reply for a 200 ticket body missing contract fields', async () => {
    const { fetchImpl } = scriptedFetch([
      jsonReply({ credential: TICKET_CREDENTIAL, expiresIn: 300 })
    ])
    const error = await captureError(() =>
      requestCloudTicket(signedInSession(), 'proj-1', DEVICE_KEY_B64, { fetchImpl })
    )
    expect(error.code).toBe('malformed_reply')
  })

  it('throws no_endpoint when the ticket advertises none', async () => {
    const body = ticketBody()
    body.endpoints = { direct: [], relay: [] }
    const ticket = parsedTicket(body)

    const error = await captureError(async () =>
      cloudPairingOfferFromTicket(ticket, DEVICE_KEY_B64)
    )
    expect(error.code).toBe('no_endpoint')
  })

  it('rejects a device key that is not 32-byte base64', async () => {
    const ticket = parsedTicket(ticketBody())
    const error = await captureError(async () => cloudPairingOfferFromTicket(ticket, 'not-a-key'))
    expect(error.code).toBe('device_key_invalid')
  })
})
