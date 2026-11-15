/**
 * Proof probe: the host allows terminal.* over the cloud link while the desktop
 * renderer's tab-create path uses session.tabs.createTerminal (denied by O1).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  EVIDENCE,
  fillLogin,
  launchDesktop,
  openLoginDialog,
  submitLogin,
  waitSignedIn
} from './desktop-harness.mjs'

const USER_DATA = '/tmp/orca-explore-r2/ud-main'
const WORKTREE_SELECTOR = 'path:/Users/gongdewei/orca-local-env/host2/projects/infra-tools'
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
  out.rpc = await page.evaluate(async ({ worktree }) => {
    const envs = await window.api.runtimeEnvironments.list()
    const env = envs.find((e) => e.name === 'infra-tools')
    const call = (method, params) =>
      window.api.runtimeEnvironments.call({ selector: env.id, method, params, timeoutMs: 20000 })
    const result = { envId: env.id }
    result.status = await call('status.get', {})
    result.created = await call('terminal.create', {
      worktree,
      clientMutationId: 'explore-r2-terminal-1'
    })
    const handle =
      result.created?.result?.terminal?.terminal ??
      result.created?.result?.terminal ??
      result.created?.terminal?.terminal ??
      result.created?.terminal ??
      (typeof result.created?.result === 'string' ? result.created.result : null)
    result.handle = typeof handle === 'string' ? handle : null
    result.list = await call('terminal.list', { worktree })
    if (result.handle) {
      result.send = await call('terminal.send', {
        terminal: result.handle,
        text: 'echo DIRECT_RPC_ECHO_OK && echo 中文直连回声',
        enter: true
      })
      await new Promise((r) => setTimeout(r, 2500))
      result.read = await call('terminal.read', { terminal: result.handle })
      result.sendLong = await call('terminal.send', {
        terminal: result.handle,
        text: 'for i in $(seq 1 200); do echo RPC_LONG_$i; done',
        enter: true
      })
      await new Promise((r) => setTimeout(r, 3000))
      result.readLong = await call('terminal.read', { terminal: result.handle })
      result.close = await call('terminal.close', { terminal: result.handle })
    }
    return result
  }, { worktree: WORKTREE_SELECTOR })
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 200)
  writeFileSync(path.join(EVIDENCE, 'terminal-rpc-probe.json'), JSON.stringify(out, null, 2))
  try { await app?.close() } catch {}
  console.log(
    JSON.stringify(
      {
        error: out.error,
        signedIn: out.signedIn,
        envId: out.rpc?.envId,
        statusOk: out.rpc?.status?.ok,
        created: out.rpc?.created,
        listOk: out.rpc?.list?.ok,
        sendOk: out.rpc?.send?.ok,
        readOk: out.rpc?.read?.ok,
        readTail: JSON.stringify(out.rpc?.read?.result ?? '').slice(-500),
        longTail: JSON.stringify(out.rpc?.readLong?.result ?? '').slice(-400),
        closeOk: out.rpc?.close?.ok,
        logs: out.logs
      },
      null,
      2
    )
  )
}
