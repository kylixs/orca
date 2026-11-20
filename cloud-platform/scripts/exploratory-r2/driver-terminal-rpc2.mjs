/** Proof probe 2: openWorkspace → per-user checkout → terminal.create/send/read over cloud link. */
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
  out.rpc = await page.evaluate(async () => {
    const bridge = window.api.cloud
    const state = await bridge.getState()
    const project = state.projects.find((p) => p.key === 'infra-tools')
    const opened = await bridge.openWorkspace(project.id)
    const envs = await window.api.runtimeEnvironments.list()
    const env = envs.find((e) => e.name === 'infra-tools')
    const call = (method, params) =>
      window.api.runtimeEnvironments.call({ selector: env.id, method, params, timeoutMs: 25000 })
    const result = { projectId: project.id, opened, envId: env.id }
    if (!opened.ok) return result
    const worktree = `path:${opened.workspacePath}`
    result.worktree = worktree
    result.created = await call('terminal.create', {
      worktree,
      clientMutationId: 'explore-r2-terminal-2'
    })
    const handle =
      result.created?.result?.terminal?.handle ??
      result.created?.result?.terminal?.terminal ??
      result.created?.result?.terminal ??
      result.created?.terminal?.terminal ??
      result.created?.terminal ??
      (typeof result.created?.result === 'string' ? result.created.result : null)
    result.handle = typeof handle === 'string' ? handle : null
    if (result.handle) {
      result.send = await call('terminal.send', {
        terminal: result.handle,
        text: 'pwd && echo DIRECT_RPC_ECHO_OK && echo 中文直连回声',
        enter: true
      })
      await new Promise((r) => setTimeout(r, 3000))
      result.read = await call('terminal.read', { terminal: result.handle })
      result.sendLong = await call('terminal.send', {
        terminal: result.handle,
        text: 'for i in $(seq 1 300); do echo RPC_LONG_$i; done',
        enter: true
      })
      await new Promise((r) => setTimeout(r, 4000))
      result.readLong = await call('terminal.read', { terminal: result.handle, limit: 200000 })
      result.close = await call('terminal.close', { terminal: result.handle })
    }
    return result
  })
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(0, 200)
  writeFileSync(path.join(EVIDENCE, 'terminal-rpc2-probe.json'), JSON.stringify(out, null, 2))
  try {
    await app?.close()
  } catch {}
  const readText =
    typeof out.rpc?.read?.result === 'string'
      ? out.rpc.read.result
      : JSON.stringify(out.rpc?.read?.result ?? '')
  const longText =
    typeof out.rpc?.readLong?.result === 'string'
      ? out.rpc.readLong.result
      : JSON.stringify(out.rpc?.readLong?.result ?? '')
  console.log(
    JSON.stringify(
      {
        error: out.error,
        signedIn: out.signedIn,
        opened: out.rpc?.opened,
        created: out.rpc?.created,
        handle: out.rpc?.handle,
        sendOk: out.rpc?.send?.ok,
        readOk: out.rpc?.read?.ok,
        echoSeen: readText.slice(-800),
        chineseSeen: readText.includes('中文直连回声'),
        longTailSeen: longText.includes('RPC_LONG_300'),
        closeOk: out.rpc?.close?.ok,
        logs: out.logs
      },
      null,
      2
    )
  )
}
