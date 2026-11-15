/** Probe: after manual login, compare cloud bridge RPC vs runtimeEnvironment RPC. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  EVIDENCE,
  fillLogin,
  launchDesktop,
  openLoginDialog,
  readShell,
  submitLogin,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-main'
const out = {}
let app
let page
let logs
try {
  ;({ app, page, logs } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  await openLoginDialog(page)
  await fillLogin(page, { password: 'Passw0rd!' })
  await submitLogin(page)
  out.signedIn = await waitSignedIn(page)
  await page.waitForTimeout(9000)
  out.shell = await readShell(page)
  out.probe = await page.evaluate(async () => {
    const bridge = window.api.cloud
    const state = await bridge.getState()
    const projects = state.projects ?? []
    const target = projects.find((p) => p.key === 'zhangsan-demo') ?? projects[0]
    const envs = await window.api.runtimeEnvironments.list()
    const env = envs.find((e) => e.name === 'zhangsan-demo') ?? envs[0]
    const result = { state, target: target ?? null, envs: envs.map((e) => ({ id: e.id, name: e.name, cloud: Boolean(e.cloudProject), endpoints: e.endpoints?.length ?? 0 })), env: env ?? null }
    try {
      result.bridgeRpc = await bridge.rpc('status.get', {}, target.id)
    } catch (e) {
      result.bridgeRpcError = String(e?.message ?? e)
    }
    try {
      result.runtimeCall = await window.api.runtimeEnvironments.call({ selector: env.id, method: 'status.get', params: {} })
    } catch (e) {
      result.runtimeCallError = String(e?.message ?? e)
    }
    try {
      result.connect = await window.api.runtimeEnvironments.connect({ selector: env.id, timeoutMs: 15000 })
    } catch (e) {
      result.connectError = String(e?.message ?? e)
    }
    try {
      result.status = await window.api.runtimeEnvironments.getStatus({ selector: env.id, timeoutMs: 15000 })
    } catch (e) {
      result.statusError = String(e?.message ?? e)
    }
    return result
  })
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.slice(0, 200) ?? []
  writeFileSync(path.join(EVIDENCE, 'runtime-probe.json'), JSON.stringify(out, null, 2))
  try { await app?.close() } catch {}
  console.log(JSON.stringify({ error: out.error, signedIn: out.signedIn, probe: out.probe, logs: out.logs?.filter((l) => !l.includes('Electron Security Warning')) }, null, 2))
}
