// End-to-end checks for the local reseed: relay reachability, identity matrix, handoff.
import { httpsJson, waitFor } from './local-env-daemon-control.mjs'

/**
 * A healthy environment is one the browser can already reach end to end. The
 * platform's relay route is not exposed over the API and does not follow a host
 * that changed address, so the relay probe is the authoritative check. Only the
 * primary host gates a platform restart; additional hosts are ensured separately.
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

const PROJECT_MATRIX = ['demo-app', 'infra-tools', 'zhangsan-demo', 'zhangsan-lab']

function handoffEntry(result) {
  const url = typeof result.json?.url === 'string' ? new URL(result.json.url) : null
  return {
    status: result.status,
    urlHost: url?.host ?? null,
    path: url?.pathname ?? null,
    apiParam: url?.searchParams.get('api') ?? null,
    hasHandoffCode: url?.hash.startsWith('#handoff=') ?? false
  }
}

export async function verify(api, tokens, projects, context) {
  const { hosts, advertiseHost, internalToken } = context
  const keysFor = async (token) =>
    ((await api('GET', '/v1/projects', { token })).json?.projects ?? [])
      .map((project) => project.key)
      .sort()
  const visibility = {
    admin: await keysFor(tokens.admin.accessToken),
    zhangsan: await keysFor(tokens.dev.accessToken),
    lisi: await keysFor(tokens.limited.accessToken)
  }
  const handoff = {}
  for (const key of ['demo-app', 'infra-tools']) {
    const result = await api('POST', `/v1/projects/${projects[key].project.id}/web-handoff`, {
      token: tokens.admin.accessToken
    })
    handoff[key] = { ...handoffEntry(result), expectedHost: projects[key].hostName }
  }
  const routeResult = await api('GET', '/v1/internal/relay-routes', {
    headers: { 'x-internal-token': internalToken }
  })
  const routes = routeResult.json?.routes ?? []
  const routeKeys = routes.map((route) => route.routeKey).sort()
  const hostChecks = hosts.map((entry) => {
    const record = entry.record
    return {
      name: entry.name,
      id: record?.id ?? null,
      online: record?.online === true,
      directAddrs: record?.directAddrs ?? [],
      relayRoute: record?.relayRoute ?? null,
      tlsFingerprint: record?.tlsFingerprint ?? null,
      advertisedPrefix: (record?.directAddrs ?? []).every((addr) =>
        addr.startsWith(`${advertiseHost}:`)
      )
    }
  })
  const hostPorts = hostChecks.map((host) => host.directAddrs[0]?.split(':').pop() ?? null)
  const failures = [
    ['admin sees all four projects', PROJECT_MATRIX.every((key) => visibility.admin.includes(key))],
    [
      'zhangsan sees both hosts projects',
      PROJECT_MATRIX.every((key) => visibility.zhangsan.includes(key))
    ],
    ['lisi sees demo-app on host 1', visibility.lisi.includes('demo-app')],
    ['lisi cannot see host 1 zhangsan-demo', !visibility.lisi.includes('zhangsan-demo')],
    ['lisi cannot see host 2 infra-tools', !visibility.lisi.includes('infra-tools')],
    ['lisi cannot see host 2 zhangsan-lab', !visibility.lisi.includes('zhangsan-lab')],
    ['two hosts registered', hostChecks.length === 2],
    ['both hosts online', hostChecks.every((host) => host.online)],
    [
      'both hosts advertise under the shared IP',
      hostChecks.every((host) => host.directAddrs.length > 0 && host.advertisedPrefix)
    ],
    ['hosts bind distinct ports', new Set(hostPorts).size === hostPorts.length],
    ['relay routes synced for both hosts', routes.length === 2],
    ['relay route keys are the host names', hosts.every((entry) => routeKeys.includes(entry.name))],
    [
      'relay route targets are the advertised addresses',
      routes.every((route) => route.target.startsWith(`${advertiseHost}:`))
    ],
    ['admin web-handoff host 1 201', handoff['demo-app'].status === 201],
    ['admin web-handoff host 2 201', handoff['infra-tools'].status === 201],
    [
      'host 1 handoff routes through its relay key',
      handoff['demo-app'].path === `/h/${projects['demo-app'].hostName}/web-index.html`
    ],
    [
      'host 2 handoff routes through its relay key',
      handoff['infra-tools'].path === `/h/${projects['infra-tools'].hostName}/web-index.html`
    ]
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  return {
    confirmations: {
      visibility,
      hosts: hostChecks,
      hostPorts,
      handoff,
      relayRoutes: { count: routes.length, keys: routeKeys, routes }
    },
    failures
  }
}

export async function relayProbe(api, token, options, hostNames = [options.hostName]) {
  const relays = (await api('GET', '/v1/relays', { token })).json?.relays ?? []
  const relay = relays.find((candidate) => candidate.online)
  if (!relay) {
    return { online: false, status: 0, url: null, hosts: {} }
  }
  const entries = {}
  for (const name of hostNames) {
    const url = `https://${relay.browserHost}/h/${name}/web-index.html`
    const result = await waitFor(
      `relay browser entry ${name}`,
      async () => {
        try {
          const res = await httpsJson(url, { rejectUnauthorized: false })
          return res.status === 200 ? { status: res.status, url } : null
        } catch {
          return null
        }
      },
      60000,
      2000
    ).catch(() => null)
    entries[name] = result ?? { status: 0, url }
  }
  const primary = entries[options.hostName] ?? { status: 0, url: null }
  return { online: true, status: primary.status, url: primary.url, hosts: entries }
}
