import { generateKeyPairSync } from 'node:crypto'
import { isEntryModule } from '../../login-lockout/src/entry-module.ts'

export type AgentOptions = {
  apiUrl: string
  hostName: string
  directAddr: string
  relayTarget: string
  orcaVersion: string
  /** One-time registration token; not needed once a host credential is supplied. */
  registrationToken?: string
  hostCredential?: string
  heartbeatSeconds?: number
  onHeartbeat?: (body: HeartbeatResponse) => void
}

export type HeartbeatResponse = {
  policyVersion: number
  revoked: {
    users: { id: string; since: number }[]
    projects: { id: string; since: number }[]
    jtis: string[]
  }
  maintenance: { reason: string } | null
  serverTime: number
}

export type AgentHandle = {
  hostId: string
  stop: () => void
  lastHeartbeat: () => HeartbeatResponse | null
}

function devicePublicKey(): string {
  const { publicKey } = generateKeyPairSync('x25519')
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

export async function startAgent(options: AgentOptions): Promise<AgentHandle> {
  const { apiUrl, hostName } = options
  let hostId = ''
  let credential = options.hostCredential ?? ''
  let last: HeartbeatResponse | null = null

  if (!credential) {
    if (!options.registrationToken) throw new Error('registrationToken or hostCredential required')
    const res = await fetch(`${apiUrl}/v1/hosts/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.registrationToken}`
      },
      body: JSON.stringify({
        name: hostName,
        fingerprint: `sha256:${hostName}`,
        e2eePublicKeyB64: devicePublicKey(),
        orcaVersion: options.orcaVersion,
        protocolVersion: 3,
        networkZone: 'intranet',
        directAddrs: [options.directAddr],
        relayTarget: options.relayTarget,
        relayRoute: hostName,
        runtimeCapabilities: ['pty', 'files', 'git', 'managed-credential']
      })
    })
    if (!res.ok) throw new Error(`register failed: ${await res.text()}`)
    const body = (await res.json()) as { hostId: string; credential: string }
    hostId = body.hostId
    credential = body.credential
  }

  const intervalMs = (options.heartbeatSeconds ?? 5) * 1000
  let timer: ReturnType<typeof setInterval> | null = null

  async function beat(): Promise<void> {
    try {
      const res = await fetch(`${apiUrl}/v1/hosts/${hostId || 'host_dev001'}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify({
          status: 'online',
          orcaVersion: options.orcaVersion,
          directAddrs: [options.directAddr],
          sessions: 0,
          load: { cpu: 0.12, memory: 0.34 }
        })
      })
      if (!res.ok) return
      last = (await res.json()) as HeartbeatResponse
      options.onHeartbeat?.(last)
    } catch {
      // Platform unreachable: keep the agent alive and retry on the next tick.
    }
  }

  await beat()
  timer = setInterval(() => void beat(), intervalMs)

  return {
    hostId,
    lastHeartbeat: () => last,
    stop: () => {
      if (timer) clearInterval(timer)
    }
  }
}

if (isEntryModule(import.meta.url, process.argv[1])) {
  const agent = await startAgent({
    apiUrl: process.env.API_URL ?? 'http://127.0.0.1:18787',
    hostName: process.env.HOST_NAME ?? 'dev-001',
    directAddr: process.env.DIRECT_ADDR ?? '127.0.0.1:16768',
    relayTarget: process.env.RELAY_TARGET ?? '127.0.0.1:16768',
    orcaVersion: process.env.ORCA_VERSION ?? '1.5.0',
    registrationToken: process.env.REGISTRATION_TOKEN,
    hostCredential: process.env.HOST_CREDENTIAL,
    heartbeatSeconds: Number(process.env.HEARTBEAT_SECONDS ?? 5),
    onHeartbeat: (body) => {
      if (body.maintenance) console.log(`[agent] maintenance: ${body.maintenance.reason}`)
      const revoked = body.revoked.projects.length + body.revoked.users.length
      if (revoked > 0) console.log(`[agent] revocations active=${revoked}`)
    }
  })
  console.log(`[agent] ${process.env.HOST_NAME ?? 'dev-001'} registered as ${agent.hostId}`)
}
