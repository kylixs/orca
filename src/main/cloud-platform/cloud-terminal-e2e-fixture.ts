import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { readString } from '../../shared/json-fields'
import { DEFAULT_INTERNAL_TOKEN, REPO_ROOT } from './cloud-session-e2e-harness'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/**
 * Real-process pieces for the terminal end-to-end tests: an actual relay child
 * process and an actual shell behind node-pty. Nothing here fakes the data path
 * a developer would use.
 */

export type RelayProcess = { port: number; logs: () => string; stop: () => Promise<void> }

export async function startRelayProcess(apiUrl: string): Promise<RelayProcess> {
  const proc = spawn(process.execPath, ['cloud-platform/apps/relay/src/relay.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: '0',
      API_URL: apiUrl,
      INTERNAL_TOKEN: DEFAULT_INTERNAL_TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  const append = (chunk: Buffer): void => {
    out += chunk.toString()
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${out}`)), 15_000)
    const tick = (): void => {
      const match = out.match(/\[relay\] listening on :(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
        return
      }
      if (proc.exitCode !== null) {
        clearTimeout(timer)
        reject(new Error(`relay exited early: ${out}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
  return {
    port,
    logs: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve()
          return
        }
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
      })
  }
}

/** A real shell: node-pty spawns it, and its output feeds the runtime's own path. */
export function installRealPtyController(service: OrcaRuntimeService): void {
  const terminals = new Map<string, { write(data: string): void; kill(): void }>()
  let seq = 0
  service.setPtyController({
    spawn: async (opts) => {
      const nodePty = await import('node-pty')
      const id = `pty-e2e-${++seq}`
      const term = nodePty.spawn(process.env.SHELL ?? '/bin/sh', [], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? process.cwd(),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          TERM: 'xterm-256color',
          PS1: '$ '
        }
      })
      term.onData((data) => service.onPtyData(id, data, Date.now()))
      // Why: the host retires a handle only from the provider's exit callback; without
      // it a real kill leaves the row "running" and close-retirement cannot be observed.
      term.onExit(({ exitCode }) =>
        service.onPtyExit(id, exitCode, undefined, { providerExitObserved: true })
      )
      terminals.set(id, { write: (data) => term.write(data), kill: () => term.kill() })
      return { id, pid: term.pid }
    },
    write: (ptyId, data) => {
      terminals.get(ptyId)?.write(data)
      return true
    },
    kill: (ptyId) => {
      terminals.get(ptyId)?.kill()
      return true
    },
    getForegroundProcess: async () => null
  })
}

export function waitForEvent(
  events: readonly unknown[],
  predicate: (event: unknown) => boolean,
  timeoutMs = 20_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (events.some(predicate)) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for a stream event; saw ${JSON.stringify(events)}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

export function isDataContaining(needle: string): (event: unknown) => boolean {
  return (event) =>
    readString(event, 'type') === 'data' && (readString(event, 'chunk') ?? '').includes(needle)
}
