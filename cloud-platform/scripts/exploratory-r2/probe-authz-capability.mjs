/**
 * Capability probe: the ticket's permission bits must be what the host actually
 * enforces. Two hidden desktop sessions (no focus, ORCA_BACKGROUND_LAUNCH=1):
 *
 *   lisi   demo-app baseline = open + file:read      → read ok, write/terminal denied
 *   zhangsan demo-app baseline = full project bits   → read/write/terminal ok
 *
 * No authorization is changed by this probe; both are the seeded grant rows.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloudTestEnv,
  dismissOnboarding,
  EVIDENCE,
  fillLogin,
  launchDesktop,
  openLoginDialog,
  PLATFORM_URL,
  readShell,
  submitLogin,
  waitSignedIn
} from './desktop-harness.mjs'

const PROJECT = 'demo-app'
const PROJECT_ROOT = '/Users/gongdewei/orca-local-env/host/projects/demo-app'

const sessions = [
  {
    user: 'lisi',
    password: 'Passw0rd!',
    label: 'lisi: open+file:read (no terminal/file:write)',
    expect: { read: true, write: false, terminal: false }
  },
  {
    user: 'zhangsan',
    password: 'Passw0rd!',
    label: 'zhangsan: open+terminal+agent+file:read+file:write',
    expect: { read: true, write: true, terminal: true }
  }
]

const out = { generatedAt: new Date().toISOString(), platform: PLATFORM_URL, project: PROJECT, sessions: [] }

async function call(page, selector, method, params = {}) {
  return page.evaluate(
    async ({ selector, method, params }) => {
      try {
        return await window.api.runtimeEnvironments.call({ selector, method, params, timeoutMs: 20000 })
      } catch (error) {
        return { ok: false, thrown: String(error?.message ?? error) }
      }
    },
    { selector, method, params }
  )
}

async function runSession(spec) {
  const userDataDir = `/tmp/orca-explore-r2/cap-${spec.user}`
  mkdirSync(userDataDir, { recursive: true })
  const result = { ...spec, steps: [], rpc: {} }
  let app
  let page
  try {
    ;({ app, page } = await launchDesktop({ userDataDir, extraEnv: cloudTestEnv() }))
    await dismissOnboarding(page)
    await openLoginDialog(page)
    await fillLogin(page, { address: PLATFORM_URL, username: spec.user, password: spec.password })
    await submitLogin(page)
    result.signedIn = await waitSignedIn(page)
    if (!result.signedIn) {
      result.shell = await readShell(page)
      return result
    }
    // The sidebar registers cloud runtime environments after the project sync.
    let env = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const envs = await page.evaluate(async () => {
        try {
          return await window.api.runtimeEnvironments.list()
        } catch {
          return []
        }
      })
      env = envs.find((entry) => entry.name === PROJECT || entry.projectName === PROJECT) ?? null
      if (env) {
        result.env = { id: env.id, name: env.name, projectId: env.projectId ?? null }
        break
      }
      await page.waitForTimeout(1000)
    }
    if (!env) {
      result.steps.push({ step: 'env', ok: false, detail: 'demo-app environment not registered in 60s' })
      result.shell = await readShell(page)
      return result
    }
    const selector = env.id

    result.rpc.status = await call(page, selector, 'status.get')
    result.rpc.workspaceInfo = await call(page, selector, 'workspace.info')
    const info = result.rpc.workspaceInfo?.result ?? {}
    const projectRoot = info.projectRoot ?? info.projectRootPath ?? PROJECT_ROOT
    const workspaceRoot = info.workspaceRoot ?? info.workspaceRootPath ?? `${projectRoot}/.orca-worktrees/${spec.user}`
    // The runtime resolver wants a worktree selector, not a bare directory. The
    // workspace checkout (when one exists) is the registered worktree the cloud
    // session may write to; otherwise fall back to the workspace root path.
    const workspacePath = info.workspace?.path ?? null
    const writeWorktree = workspacePath ? `path:${workspacePath}` : `path:${workspaceRoot}`
    result.roots = { projectRoot, workspaceRoot, workspacePath, writeWorktree }

    result.rpc.read = await call(page, selector, 'files.read', {
      worktree: `path:${projectRoot}`,
      relativePath: 'README.md'
    })
    result.rpc.write = await call(page, selector, 'files.write', {
      worktree: writeWorktree,
      relativePath: 'r2-authz-capability.txt',
      content: `capability probe by ${spec.user} at ${new Date().toISOString()}\n`,
      // Cloud file mutations must name the checkout's execution host; the host
      // launched here is the local one (same field the cloud file panel sends).
      expectedExecutionHostId: 'local'
    })
    result.rpc.terminalCreate = await call(page, selector, 'terminal.create', {
      worktree: writeWorktree,
      clientMutationId: `cap-${spec.user}-${Date.now()}`
    })
    const created = result.rpc.terminalCreate?.result?.terminal ?? result.rpc.terminalCreate?.terminal
    const handle = created?.handle ?? created?.terminal ?? null
    result.terminalHandle = typeof handle === 'string' ? handle : null
    const handles = [
      ...(result.terminalHandle ? [result.terminalHandle] : []),
      ...String(process.env.ORCA_CAP_EXTRA_TERMINALS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    ]
    result.rpc.terminalClose = []
    for (const terminal of handles) {
      const closed = await call(page, selector, 'terminal.close', { terminal })
      result.rpc.terminalClose.push({ terminal, ok: closed?.ok === true })
    }
    if (result.rpc.write?.ok) {
      result.rpc.cleanup = await call(page, selector, 'files.delete', {
        worktree: writeWorktree,
        relativePath: 'r2-authz-capability.txt',
        expectedExecutionHostId: 'local'
      })
    }

    const ok = (rpc) => rpc?.ok === true
    result.observed = { read: ok(result.rpc.read), write: ok(result.rpc.write), terminal: ok(result.rpc.terminalCreate) }
    result.steps.push({
      step: 'capability',
      ok:
        result.observed.read === spec.expect.read &&
        result.observed.write === spec.expect.write &&
        result.observed.terminal === spec.expect.terminal,
      detail: result.observed
    })
    result.shell = await readShell(page)
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  } finally {
    try {
      await app?.close()
    } catch {}
  }
  return result
}

const failures = []
for (const spec of sessions) {
  const result = await runSession(spec)
  const capabilityStep = result.steps.find((step) => step.step === 'capability')
  if (!capabilityStep || !capabilityStep.ok) {
    failures.push({ user: spec.user, observed: result.observed, expected: spec.expect, error: result.error })
  }
  out.sessions.push(result)
  console.log(
    JSON.stringify({
      user: spec.user,
      signedIn: result.signedIn,
      env: result.env,
      observed: result.observed,
      expected: spec.expect,
      ok: capabilityStep?.ok ?? false,
      error: result.error
    })
  )
}

out.verdict = failures.length === 0 ? 'pass' : 'fail'
out.failures = failures
fsWrite()
function fsWrite() {
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(
    path.join(EVIDENCE, 'authz-api-combo-capability.json'),
    `${JSON.stringify(out, null, 2)}\n`
  )
}
