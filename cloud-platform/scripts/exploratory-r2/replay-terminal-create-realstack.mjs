#!/usr/bin/env node
/**
 * P0 U55① real-stack half: over a real cloud link, terminal.create must spawn a
 * PTY on the host. Combined with the renderer suites that prove every UI create
 * entry routes a cloud session to client-owned terminal creation, this is the
 * approved substitute for driving the stale desktop build.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  fillLogin,
  launchDesktop,
  openLoginDialog,
  submitLogin,
  waitSignedIn
} from './desktop-harness.mjs'

const OUT = path.resolve('cloud-platform/evidence/r-fixes-verify')
const USER_DATA = '/tmp/orca-rfix-verify/ud-terminal'
const ADDRESS = 'https://127.0.0.1:18787'
const out = { check: 'U55① P0 real-stack terminal.create over cloud link', address: ADDRESS }
let app
let page
let logs
try {
  ;({ app, page, logs } = await launchDesktop({ userDataDir: USER_DATA, extraEnv: cloudTestEnv() }))
  await dismissOnboarding(page)
  const signedAlready = await page.evaluate(() => !document.querySelector('[data-status-bar] [data-cloud-login-entry]'))
  if (!signedAlready) {
    await openLoginDialog(page)
    await fillLogin(page, { address: ADDRESS, username: 'zhangsan', password: 'Passw0rd!' })
    await submitLogin(page)
  }
  out.signedIn = signedAlready || (await waitSignedIn(page))
  await page.waitForTimeout(10000)
  out.rpc = await page.evaluate(async () => {
    const bridge = window.api.cloud
    const state = await bridge.getState()
    const project = state.projects.find((p) => p.key === 'infra-tools') ?? state.projects.find((p) => p.key === 'demo-app')
    if (!project) return { projectKeys: state.projects.map((p) => p.key) }
    const opened = await bridge.openWorkspace(project.id)
    const envs = await window.api.runtimeEnvironments.list()
    const env = envs.find((e) => e.name === project.key) ?? envs.find((e) => e.name === 'infra-tools') ?? envs.find((e) => e.name === 'demo-app')
    if (!env) return { projectId: project.id, opened, envNames: envs.map((e) => e.name) }
    const call = (method, params) =>
      window.api.runtimeEnvironments.call({ selector: env.id, method, params, timeoutMs: 25000 })
    const result = { projectId: project.id, opened, envId: env.id, envName: env.name }
    if (!opened.ok) return result
    result.status = await call('status.get', {})
    const worktree = `path:${opened.workspacePath}`
    result.worktree = worktree
    result.created = await call('terminal.create', {
      worktree,
      clientMutationId: `rfix-verify-${Date.now()}`
    })
    const handle =
      result.created?.result?.terminal?.terminal ??
      result.created?.result?.terminal?.handle ??
      result.created?.result?.terminal ??
      result.created?.terminal?.terminal ??
      result.created?.terminal ??
      (typeof result.created?.result === 'string' ? result.created.result : null)
    result.handle = typeof handle === 'string' ? handle : null
    if (result.handle) {
      result.send = await call('terminal.send', {
        terminal: result.handle,
        text: 'echo RFIX_TERMINAL_CREATE_OK && pwd',
        enter: true
      })
      await new Promise((r) => setTimeout(r, 3000))
      result.read = await call('terminal.read', { terminal: result.handle })
      result.close = await call('terminal.close', { terminal: result.handle })
    }
    return result
  })
  const readText = JSON.stringify(out.rpc?.read?.result ?? '')
  out.echoSeen = readText.includes('RFIX_TERMINAL_CREATE_OK')
  out.pass = out.rpc?.status?.ok === true && out.rpc?.created?.ok === true && Boolean(out.rpc?.handle) && out.echoSeen
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  out.pass = false
} finally {
  out.logs = logs?.filter((l) => !l.includes('Electron Security Warning')).slice(-120)
  out.generatedAt = new Date().toISOString()
  writeFileSync(path.join(OUT, 'p0-terminal-create-realstack.json'), JSON.stringify(out, null, 2))
  try { await app?.close() } catch {}
  console.log(`${out.pass ? 'PASS' : 'FAIL'} terminal-create ${JSON.stringify({
    signedIn: out.signedIn,
    env: out.rpc?.envName,
    statusOk: out.rpc?.status?.ok,
    createdOk: out.rpc?.created?.ok,
    handle: out.rpc?.handle,
    echoSeen: out.echoSeen,
    error: out.error
  })}`)
}
