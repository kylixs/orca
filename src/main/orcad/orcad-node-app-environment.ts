import type { AppEnvironment } from '../../shared/app-environment'
import { resolveOrcadInstallRoot, resolveOrcadPath } from './orcad-app-paths'
import { getOrcadCliLauncherPath } from './orcad-cli-launcher'

/** The Node stand-in for Electron's `app`, plus the quit-runner the entry stores. */
export function createNodeAppEnvironment(): {
  environment: AppEnvironment
  runQuitHandlers: () => void
} {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  const runQuitHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    // Why throw: a quit handler that failed may leave a writer running, which keeps the lock.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'orcad_quit_handlers_failed')
    }
  }
  return {
    runQuitHandlers,
    environment: {
      getPath: resolveOrcadPath,
      getAppPath: () => resolveOrcadInstallRoot(),
      getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
      // Why still true: consumers read this as "production build, not a dev checkout" —
      // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
      // hydration. Answering false to satisfy a path resolver would relax a security
      // posture. Layout questions must ask whether the app root is an asar archive
      // instead (see parcel-watcher-entry-path.ts).
      isPackaged: () => true,
      getCliLauncherPath: getOrcadCliLauncherPath,
      onWillQuit: (handler) => quitHandlers.push(handler),
      exit: (code = 0) => process.exit(code),
      // Why []: there are no Chromium processes on this host to measure.
      getAppMetrics: () => []
    }
  }
}
