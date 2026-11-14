// End-to-end checks for the local reseed: relay reachability, identity matrix, handoff.
import { httpsJson, waitFor } from './local-env-daemon-control.mjs'

/**
 * A healthy environment is one the browser can already reach end to end. The
 * platform's relay route is not exposed over the API and does not follow a host
 * that changed address, so the relay probe is the authoritative check.
 */
export async function probeEnvironment(api, token, options) {
  const hosts = (await api('GET', '/v1/hosts', { token })).json?.hosts ?? []
  const host = hosts.find(
    (candidate) =>
      candidate.name === options.hostName &&
      candidate.online &&
      (candidate.directAddrs ?? []).some((addr) => addr.startsWith(`${options.advertiseHost}:`))
  )
  if (!host) {
    return { healthy: false, reason: 'host offline' }
  }
  const relays = (await api('GET', '/v1/relays', { token })).json?.relays ?? []
  const relay = relays.find((candidate) => candidate.online)
  if (!relay) {
    return { healthy: false, reason: 'relay offline' }
  }
  const url = `https://${relay.browserHost}/h/${options.hostName}/web-index.html`
  const reachable = await waitFor(
    'existing relay route',
    async () => {
      try {
        return (await httpsJson(url, { rejectUnauthorized: false })).status === 200
      } catch {
        return false
      }
    },
    20000,
    2000
  ).catch(() => false)
  return reachable
    ? { healthy: true, host, relay, url }
    : { healthy: false, reason: 'relay route stale', host, relay, url }
}

export async function verify(api, tokens, projects) {
  const projectKeys = async (token) =>
    ((await api('GET', '/v1/projects', { token })).json?.projects ?? [])
      .map((project) => project.key)
      .sort()
  const adminKeys = await projectKeys(tokens.admin.accessToken)
  const devKeys = await projectKeys(tokens.dev.accessToken)
  const limitedKeys = await projectKeys(tokens.limited.accessToken)
  const handoff = await api('POST', `/v1/projects/${projects.demo.project.id}/web-handoff`, {
    token: tokens.admin.accessToken
  })
  const url = typeof handoff.json?.url === 'string' ? new URL(handoff.json.url) : null
  const confirmations = {
    admin: adminKeys,
    zhangsan: devKeys,
    lisi: limitedKeys,
    adminHandoff: {
      status: handoff.status,
      urlHost: url?.host ?? null,
      path: url?.pathname ?? null,
      projectParam: url?.searchParams.get('project') ?? null,
      hasHandoffCode: url?.hash.startsWith('#handoff=') ?? false
    }
  }
  const failures = [
    ['admin sees demo-app', adminKeys.includes('demo-app')],
    ['zhangsan sees demo-app', devKeys.includes('demo-app')],
    ['zhangsan sees zhangsan-demo', devKeys.includes('zhangsan-demo')],
    ['lisi sees demo-app', limitedKeys.includes('demo-app')],
    ['lisi cannot see zhangsan-demo', !limitedKeys.includes('zhangsan-demo')],
    ['admin web-handoff 201', handoff.status === 201]
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  return { confirmations, failures }
}

export async function relayProbe(api, token, options) {
  const relays = (await api('GET', '/v1/relays', { token })).json?.relays ?? []
  const relay = relays.find((candidate) => candidate.online)
  if (!relay) {
    return { online: false, status: 0, url: null }
  }
  const url = `https://${relay.browserHost}/h/${options.hostName}/web-index.html`
  const result = await waitFor(
    'relay browser entry',
    async () => {
      try {
        const res = await httpsJson(url, { rejectUnauthorized: false })
        return res.status === 200 ? { online: true, status: res.status, url } : null
      } catch {
        return null
      }
    },
    60000,
    2000
  ).catch(() => null)
  return result ?? { online: true, status: 0, url }
}
