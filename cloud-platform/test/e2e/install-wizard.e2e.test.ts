import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M114b2 (FR-4.11): adding a host or a relay is a wizard, not a runbook — the
 * admin copies one `bash <(curl …)` line, and the script that answers carries
 * the platform address and the secret. So the endpoint must refuse everyone but
 * an admin, refuse a tokenless host request, and the web command must match it.
 */

const EVIDENCE = 'm114-relay-page'
const INTERNAL_TOKEN = 'm114-wizard-token'
const WEB_SOURCE = join(new URL('../../', import.meta.url).pathname, 'apps/web')

let api: Service
let adminToken = ''
let devToken = ''

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function mintHostToken(): Promise<string> {
  const res = await fetch(`${api.url}/v1/hosts/tokens`, { method: 'POST', headers: auth(adminToken) })
  assert.equal(res.status, 201)
  return ((await res.json()) as { token: string }).token
}

type AuditEvent = { eventType: string; actor: string | null; result: string; metadata: unknown }

async function auditEvents(query: string): Promise<AuditEvent[]> {
  const res = await fetch(`${api.url}/v1/audit/events?${query}`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: AuditEvent[] }).events
}

/**
 * Loads the real front-end into a DOM whose fetch goes to the real platform and
 * whose `location.origin` is the platform URL — the same origin the wizard puts
 * into its one-liner, which is what makes the command copy-paste correct.
 */
function loadWizard(platformUrl: string) {
  const window = new Window({ url: `${platformUrl}/` })
  window.document.documentElement.innerHTML = readFileSync(join(WEB_SOURCE, 'index.html'), 'utf8')
    // The markup's script tags point at the server; app.js is injected by hand.
    .replace(/<script[\s\S]*?<\/script>/g, '')

  const realFetch = globalThis.fetch
  const fetchToPlatform: typeof fetch = (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    return realFetch(`${platformUrl}${path}`, init)
  }
  const source = readFileSync(join(WEB_SOURCE, 'app.js'), 'utf8')
  new Function(
    'document',
    'localStorage',
    'fetch',
    'window',
    'navigator',
    'location',
    'confirm',
    'console',
    'setTimeout',
    'clearTimeout',
    'Date',
    'URL',
    'JSON',
    'Promise',
    source
  )(
    window.document,
    window.localStorage,
    fetchToPlatform,
    window,
    window.navigator,
    window.location,
    () => true,
    console,
    window.setTimeout.bind(window),
    window.clearTimeout.bind(window),
    Date,
    URL,
    JSON,
    Promise
  )

  const wait = async (selector: string): Promise<string> => {
    for (let round = 0; round < 200; round += 1) {
      const found = window.document.querySelector(selector)
      if (found) return found.textContent ?? ''
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${selector}`)
  }
  const click = async (selector: string, waitFor: string): Promise<string> => {
    const button = window.document.querySelector<HTMLElement>(selector)
    if (!button) throw new Error(`missing ${selector}`)
    button.click()
    return wait(waitFor)
  }
  const login = async (): Promise<void> => {
    window.document.querySelector<HTMLInputElement>('#username')!.value = 'admin'
    window.document.querySelector<HTMLInputElement>('#password')!.value = 'Adm1n!'
    window.document
      .querySelector<HTMLFormElement>('#loginForm')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    for (let round = 0; round < 200; round += 1) {
      if (!window.document.querySelector<HTMLDivElement>('#view-app')?.hidden) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const nav = async (route: string, waitFor: string): Promise<string> => {
    const button = window.document.querySelector<HTMLElement>(`.nav-item[data-route="${route}"]`)
    if (!button) throw new Error(`no nav item for ${route}`)
    button.click()
    return wait(waitFor)
  }
  return { window, login, click, nav, text: (selector: string) => wait(selector) }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-install-wizard'
  )
  adminToken = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm114-wizard' })
  }).then((res) => res.json().then((body: { accessToken: string }) => body.accessToken))
  assert.notEqual(adminToken, '')
  devToken = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'zhangsan', password: 'Passw0rd!', deviceName: 'm114-wizard-dev' })
  }).then((res) => res.json().then((body: { accessToken: string }) => body.accessToken))
  assert.notEqual(devToken, '')
}, 120_000)

after(async () => {
  await api?.stop()
})

describe('M114b2 向导式添加：脚本端点与 Web 命令', () => {
  test('管理员拉取 relay.sh：内嵌平台地址与内部控制令牌', async () => {
    const res = await fetch(`${api.url}/install/relay.sh`, { headers: auth(adminToken) })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/x-shellscript/)
    const script = await res.text()
    assert.match(script, /^#!\/usr\/bin\/env bash/)
    assert.ok(script.includes(`ORCA_CLOUD_API_URL=${api.url}`), 'platform address must be embedded')
    assert.ok(script.includes(`ORCA_CLOUD_INTERNAL_TOKEN=${INTERNAL_TOKEN}`), 'internal token must be embedded')
    assert.match(script, /RELAY_PUBLIC_HOST/)
    assert.match(script, /node cloud-platform\/apps\/relay\/src\/relay\.ts/)
    saveEvidence(EVIDENCE, 'install-relay-script.txt', script)
  })

  test('管理员拉取 host.sh：缺令牌 400，有效令牌内嵌 env 与自签证书步骤', async () => {
    const missing = await fetch(`${api.url}/install/host.sh`, { headers: auth(adminToken) })
    assert.equal(missing.status, 400)
    assert.equal(((await missing.json()) as { error?: { code: string } }).error?.code, 'INSTALL_TOKEN_REQUIRED')

    const used = await fetch(`${api.url}/install/host.sh?token=not-a-real-token`, {
      headers: auth(adminToken)
    })
    assert.equal(used.status, 401)

    const token = await mintHostToken()
    const res = await fetch(`${api.url}/install/host.sh?token=${token}`, { headers: auth(adminToken) })
    assert.equal(res.status, 200)
    const script = await res.text()
    assert.ok(script.includes(`ORCA_CLOUD_API_URL=${api.url}`))
    assert.ok(script.includes(`HOST_TOKEN=${token}`), 'the one-time token must be embedded')
    for (const variable of ['HOST_NAME=', 'ADVERTISE_HOST=', 'PROJECTS_ROOT=']) {
      assert.ok(script.includes(variable), `${variable} must be written`)
    }
    assert.match(script, /openssl req -x509/)
    assert.match(script, /systemd|orca --host-mode/)
    saveEvidence(EVIDENCE, 'install-host-script.txt', script)
    saveEvidence(EVIDENCE, 'install-token-required.json', { missing: missing.status, invalid: used.status })
  })

  test('开发者拉取脚本 403，拒绝与成功都写入 install_script 审计且不含令牌明文', async () => {
    const token = await mintHostToken()
    for (const path of [`/install/host.sh?token=${token}`, '/install/relay.sh']) {
      const res = await fetch(`${api.url}${path}`, { headers: auth(devToken) })
      assert.equal(res.status, 403, path)
      assert.equal(((await res.json()) as { error?: { code: string } }).error?.code, 'PERMISSION_DENIED')
    }

    const events = await auditEvents('eventType=install_script&limit=50')
    assert.ok(
      events.some((event) => event.actor === 'zhangsan' && event.result === 'denied'),
      'the refused attempt must be recorded'
    )
    const successes = events.filter((event) => event.result === 'success')
    assert.ok(successes.length >= 2, 'both script kinds must record their own disclosure')
    assert.deepEqual(
      successes.map((event) => (event.metadata as { type: string }).type).sort(),
      ['host', 'relay']
    )
    assert.ok(
      successes.every((event) => !JSON.stringify(event.metadata).includes(token)),
      'no token plaintext in the audit metadata'
    )
    assert.ok(
      successes.every((event) => typeof (event.metadata as { tokenEmbedded: boolean }).tokenEmbedded === 'boolean')
    )
    saveEvidence(EVIDENCE, 'install-wizard.json', {
      admin: { relayScript: 200, hostScript: 200, missingToken: 400, invalidToken: 401 },
      developer: { status: 403, errorCode: 'PERMISSION_DENIED' },
      audit: { deniedRecorded: true, successTypes: ['host', 'relay'], tokenPlaintextRecorded: false }
    })
  })

  test('Web 向导命令与端点一致：主机与中继的一行命令都能拉到脚本', async () => {
    const wizard = loadWizard(api.url)
    await wizard.login()
    assert.equal(wizard.window.location.origin, api.url)

    const hostCmd = await wizard.nav('hosts', '#registerHostBtn').then(() =>
      wizard.click('#registerHostBtn', '#installCmd')
    )
    const token = /token=([\w-]+)/.exec(hostCmd)?.[1] ?? ''
    assert.notEqual(token, '', 'the wizard must embed a token')
    assert.equal(hostCmd, `bash <(curl -fsSL ${api.url}/install/host.sh?token=${token})`)
    // The exact command the admin copies must work as-is on the target machine.
    // Why not \S+: the trailing `)` of the process substitution is not part of the URL.
    const hostUrl = /curl -fsSL ([^)\s]+)/.exec(hostCmd)?.[1] ?? ''
    assert.equal(hostUrl, `${api.url}/install/host.sh?token=${token}`)
    const hostFetch = await fetch(hostUrl, { headers: auth(adminToken) })
    assert.equal(hostFetch.status, 200)
    assert.ok((await hostFetch.text()).includes(`HOST_TOKEN=${token}`))

    await wizard.nav('relays', '#addRelayBtn')
    const relayCmd = await wizard.click('#addRelayBtn', '#relayInstallCmd')
    assert.equal(relayCmd, `bash <(curl -fsSL ${api.url}/install/relay.sh)`)
    assert.doesNotMatch(relayCmd, /token=/, 'the internal token must not travel in the URL')
    const relayUrl = /curl -fsSL ([^)\s]+)/.exec(relayCmd)?.[1] ?? ''
    assert.equal(relayUrl, `${api.url}/install/relay.sh`)
    const relayFetch = await fetch(relayUrl, { headers: auth(adminToken) })
    assert.equal(relayFetch.status, 200)
    assert.ok((await relayFetch.text()).includes(`ORCA_CLOUD_INTERNAL_TOKEN=${INTERNAL_TOKEN}`))

    saveEvidence(EVIDENCE, 'install-wizard-web.json', {
      origin: api.url,
      hostCmd,
      relayCmd,
      hostScriptFetched: 200,
      relayScriptFetched: 200
    })
  }, 120_000)
})
