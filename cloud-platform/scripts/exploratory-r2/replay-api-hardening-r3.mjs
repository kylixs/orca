#!/usr/bin/env node
/** Direct replay of U57①③④ against a fresh current-code platform (no stale process). */
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE || 'http://127.0.0.1:18790'
const OUT = path.resolve('cloud-platform/evidence/r-fixes-verify')
const out = { check: 'U57①③④ API hardening replay', base: BASE }
let adminToken = ''
async function api(p, { method = 'GET', body, token = adminToken } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}
try {
  const login = await fetch(BASE + '/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', devicePubKey: 'rfix-verify-key', deviceName: 'replay' })
  })
  const loginBody = await login.json()
  out.login = { status: login.status }
  adminToken = loginBody.accessToken

  // ---- U57① bad heartbeat ----
  const tokenRes = await api('/v1/hosts/tokens', { method: 'POST' })
  const hostToken = tokenRes.body.token
  const regRes = await fetch(BASE + '/v1/hosts/register', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({
      name: `rfix-verify-${Date.now()}`, fingerprint: 'sha256:rfix-verify', e2eePublicKeyB64: 'rfix-key',
      orcaVersion: '1.5.0', protocolVersion: 3, networkZone: 'intranet',
      directAddrs: ['127.0.0.1:19101'], relayTarget: '127.0.0.1:19101', runtimeCapabilities: ['pty', 'files']
    })
  })
  const host = await regRes.json()
  const badBeat = await fetch(`${BASE}/v1/hosts/${host.hostId}/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
    body: JSON.stringify({ directAddrs: [123] })
  })
  const projectsAfterBadBeat = await api('/v1/projects')
  const hostsAfterBadBeat = await api('/v1/hosts')
  const storedHost = hostsAfterBadBeat.body.hosts.find((h) => h.id === host.hostId)
  out.badHeartbeat = {
    status: badBeat.status,
    projectsStatus: projectsAfterBadBeat.status,
    projectCount: projectsAfterBadBeat.body.projects?.length ?? null,
    storedDirectAddrs: storedHost?.directAddrs ?? null,
    pass: badBeat.status === 400 && projectsAfterBadBeat.status === 200 && JSON.stringify(storedHost?.directAddrs) === JSON.stringify(['127.0.0.1:19101'])
  }

  // ---- U57③ malformed permissions keeps the row ----
  const beforeGrants = await api('/v1/projects/proj_payment/grants')
  const beforeRow = beforeGrants.body.grants.find((g) => g.subjectType === 'group' && g.subjectId === 'team-payment')
  const badPut = await api('/v1/projects/proj_payment/grants', {
    method: 'PUT', body: { subjectType: 'group', subjectId: 'team-payment', permissions: 'open' }
  })
  const afterGrants = await api('/v1/projects/proj_payment/grants')
  const afterRow = afterGrants.body.grants.find((g) => g.subjectType === 'group' && g.subjectId === 'team-payment')
  out.grantPermissions = {
    putStatus: badPut.status,
    before: beforeRow?.permissions ?? null,
    after: afterRow?.permissions ?? null,
    pass: badPut.status === 400 && JSON.stringify(beforeRow?.permissions) === JSON.stringify(afterRow?.permissions)
  }

  // ---- U57④ audit limit page ----
  const auditDefault = await api('/v1/audit/events?limit=50')
  const auditBad = await api('/v1/audit/events?limit=abc')
  const auditZero = await api('/v1/audit/events?limit=0')
  const auditNegative = await api('/v1/audit/events?limit=-1')
  const available = auditDefault.body.events?.length ?? null
  out.auditLimit = {
    availableEvents: available,
    default50: available,
    abc: auditBad.body.events?.length ?? null,
    zero: auditZero.body.events?.length ?? null,
    negative: auditNegative.body.events?.length ?? null,
    statuses: [auditDefault.status, auditBad.status, auditZero.status, auditNegative.status],
    pass:
      auditBad.status === 200 && auditZero.status === 200 && auditNegative.status === 200 &&
      (auditBad.body.events?.length ?? 0) <= 50 && (auditZero.body.events?.length ?? 0) <= 50 && (auditNegative.body.events?.length ?? 0) <= 50
  }
  out.pass = out.badHeartbeat.pass && out.grantPermissions.pass && out.auditLimit.pass
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  out.pass = false
} finally {
  out.generatedAt = new Date().toISOString()
  fs.writeFileSync(path.join(OUT, 'p1-api-hardening.json'), JSON.stringify(out, null, 2))
  console.log(`${out.pass ? 'PASS' : 'FAIL'} api-hardening ${JSON.stringify({
    badHeartbeat: out.badHeartbeat, grantPermissions: out.grantPermissions, auditLimit: out.auditLimit, error: out.error
  })}`)
}
