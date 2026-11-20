/**
 * Boundary stage: repeated/concurrent project open, then revoke the platform session
 * mid-operation and observe the desktop reaction.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  EVIDENCE,
  launchDesktop,
  PLATFORM_URL,
  readShell,
  shoot,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-main'
const SAVED = path.join(USER_DATA, 'orca-cloud-session.json')
const out = { probes: {} }
let app
let page
let logs
const wait = (ms) => page.waitForTimeout(ms)
try {
  ;({ app, page, logs } = await launchDesktop({
    userDataDir: USER_DATA,
    extraEnv: cloudTestEnv({ ORCA_CLOUD_API_URL: PLATFORM_URL })
  }))
  await dismissOnboarding(page)
  await wait(12000)
  out.probes.autoSignedIn = await waitSignedIn(page, 60_000)
  out.probes.shell = await readShell(page)

  // Repeated + concurrent opens.
  out.probes.opens = await page.evaluate(async () => {
    const bridge = window.api.cloud
    const state = await bridge.getState()
    const online = state.projects.filter((p) => p.hostStatus === 'online')
    const target = online.find((p) => p.key === 'infra-tools') ?? online[0]
    const other = online.find((p) => p.id !== target.id) ?? target
    const concurrent = await Promise.all([
      bridge.openWorkspace(target.id),
      bridge.openWorkspace(target.id)
    ])
    const different = await bridge.openWorkspace(other.id)
    const again = await bridge.openWorkspace(target.id)
    return {
      target: target.key,
      other: other.key,
      concurrent: concurrent.map((r) => ({
        ok: r.ok,
        code: r.code,
        workspacePath: r.workspacePath,
        route: r.route
      })),
      different: {
        ok: different.ok,
        code: different.code,
        workspacePath: different.workspacePath,
        route: different.route
      },
      again: {
        ok: again.ok,
        code: again.code,
        workspacePath: again.workspacePath,
        route: again.route
      }
    }
  })
  await wait(4000)
  out.probes.afterOpens = await readShell(page)
  await shoot(page, 'A0-repeated-opens.png')

  // Revoke the active platform session underneath the running desktop app.
  const saved = JSON.parse(readFileSync(SAVED, 'utf8'))
  out.probes.savedApiUrl = saved.apiUrl
  const revoke = await fetch(`${PLATFORM_URL}/v1/auth/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${saved.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({})
  })
  out.probes.revoke = { status: revoke.status, body: (await revoke.text()).slice(0, 300) }
  await wait(1000)

  // First operation after the session died.
  out.probes.afterRevokeCall = await page.evaluate(async () => {
    const bridge = window.api.cloud
    const result = {}
    try {
      result.state = await bridge.getState()
    } catch (e) {
      result.stateError = String(e?.message ?? e)
    }
    try {
      result.projects = await bridge.listProjects()
    } catch (e) {
      result.listError = String(e?.message ?? e)
    }
    try {
      result.open = await bridge.openWorkspace('proj_85ef155c')
    } catch (e) {
      result.openError = String(e?.message ?? e)
    }
    return result
  })
  await wait(6000)
  out.probes.afterRevoke = await readShell(page)
  await shoot(page, 'A1-after-session-revoke.png')
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 300)
  writeFileSync(path.join(EVIDENCE, 'boundary-stage.json'), JSON.stringify(out, null, 2))
  try {
    await app?.close()
  } catch {}
  console.log(
    JSON.stringify(
      {
        error: out.error,
        autoSignedIn: out.probes.autoSignedIn,
        opens: out.probes.opens,
        afterOpens: {
          alerts: out.probes.afterOpens?.alerts,
          body: (out.probes.afterOpens?.bodyText ?? '').slice(0, 400)
        },
        revoke: out.probes.revoke,
        afterRevokeCall: out.probes.afterRevokeCall,
        afterRevoke: {
          signedIn: out.probes.afterRevoke?.signedInSegment,
          statusBar: out.probes.afterRevoke?.statusBar,
          notices: out.probes.afterRevoke?.statuses,
          alerts: out.probes.afterRevoke?.alerts,
          body: (out.probes.afterRevoke?.bodyText ?? '').slice(0, 800)
        },
        logs: out.logs
      },
      null,
      2
    )
  )
}
