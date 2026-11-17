import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { closeElectronAppForE2E } from './electron-process-shutdown'

export const E2E_STARTUP_TIMEOUT_MS = 120_000

export type E2ELaunchEnv = Record<string, string | undefined>

type ElectronLaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>
type ElectronLauncher = (options: ElectronLaunchOptions) => Promise<ElectronApplication>

// Why: a native dialog on the test desktop blocks startup and waits for a user
// who will never click; background launch also keeps test windows off-focus.
const BASE_E2E_LAUNCH_ENV = {
  ORCA_SUPPRESS_DIALOGS: '1',
  ORCA_BACKGROUND_LAUNCH: '1'
} as const

/** Defaults first so a spec's explicit value (e.g. ORCA_BACKGROUND_LAUNCH=0) wins. */
export function withE2ELaunchEnv(env: E2ELaunchEnv = {}): Record<string, string> {
  const merged: Record<string, string> = { ...BASE_E2E_LAUNCH_ENV }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged
}

// Why: firstWindow() runs in a later fixture/scoped call than launch(), so the
// overall startup budget has to travel with the app handle.
const startupDeadlines = new WeakMap<ElectronApplication, number>()

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    // SAFETY: Node timers expose unref(); this config's DOM timer typing reports a number.
    const unrefTimer = timer as unknown as { unref?: () => void }
    unrefTimer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function startupError(reason: string, hadApp: boolean): Error {
  const cleanup = hadApp ? '已强制关闭实例' : '启动未完成，无可关闭的实例'
  return new Error(`startup failed: ${reason}；${cleanup}`)
}

async function closeAppAfterStartupFailure(app: ElectronApplication): Promise<void> {
  try {
    // closeElectronAppForE2E already wraps app.close() in a timeout and falls
    // back to forceKillProcessTree, so a hung quit cannot outlive the test.
    await closeElectronAppForE2E(app)
  } catch {
    /* best effort: the startup failure is the useful error */
  }
}

export type ElectronStartupGuardOptions = {
  timeoutMs?: number
  launcher?: ElectronLauncher
}

/**
 * Launch an Electron app with an overall startup budget. On timeout or launch
 * error the app (including one that resolves after the deadline) is closed or
 * force-killed before a `startup failed: ...` error is thrown.
 */
export async function launchElectronAppWithStartupGuard(
  options: ElectronLaunchOptions,
  { timeoutMs = E2E_STARTUP_TIMEOUT_MS, launcher }: ElectronStartupGuardOptions = {}
): Promise<ElectronApplication> {
  const deadlineAt = Date.now() + timeoutMs
  const launch = launcher ?? ((launchOptions) => electron.launch(launchOptions))
  let pending: Promise<ElectronApplication>
  try {
    pending = launch({ ...options, env: withE2ELaunchEnv(options.env) })
  } catch (error) {
    throw startupError(toReason(error), false)
  }

  let app: ElectronApplication | null = null
  try {
    app = await withTimeout(pending, timeoutMs, `electron.launch exceeded ${timeoutMs}ms`)
    startupDeadlines.set(app, deadlineAt)
    return app
  } catch (error) {
    if (app) {
      await closeAppAfterStartupFailure(app)
    } else {
      // Why: a launch that resolves after the deadline must not leave a window.
      pending.then(
        (lateApp) => closeAppAfterStartupFailure(lateApp),
        () => undefined
      )
    }
    throw startupError(toReason(error), app !== null)
  }
}

/**
 * Await the first window inside the startup budget registered by the guarded
 * launch. A failure closes/force-kills the app before rethrowing.
 */
export async function firstWindowWithStartupGuard(
  app: ElectronApplication,
  { timeout }: { timeout?: number } = {}
): Promise<Page> {
  const deadlineAt = startupDeadlines.get(app) ?? Date.now() + E2E_STARTUP_TIMEOUT_MS
  const remaining = Math.max(
    1,
    Math.min(deadlineAt - Date.now(), timeout ?? E2E_STARTUP_TIMEOUT_MS)
  )
  try {
    return await withTimeout(
      app.firstWindow({ timeout: remaining }),
      remaining,
      `firstWindow exceeded ${remaining}ms`
    )
  } catch (error) {
    await closeAppAfterStartupFailure(app)
    throw startupError(toReason(error), true)
  }
}
