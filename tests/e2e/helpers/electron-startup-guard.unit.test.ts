import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  firstWindowWithStartupGuard,
  launchElectronAppWithStartupGuard,
  withE2ELaunchEnv
} from './electron-startup-guard'

function fakeApp(options: { close?: () => Promise<void> } = {}) {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    stdio: [new PassThrough(), new PassThrough(), new PassThrough()]
  })
  const close = vi.fn(
    options.close ??
      (async () => {
        proc.exitCode = 0
        proc.emit('exit', 0, null)
      })
  )
  const firstWindow = vi.fn(() => new Promise<never>(() => {}))
  // SAFETY: test double implements the ElectronApplication members the guard reads.
  const app = {
    process: () => proc as unknown as ChildProcess,
    close,
    firstWindow
  } as unknown as ElectronApplication
  return { app, proc, close, firstWindow }
}

afterEach(() => vi.useRealTimers())

describe('e2e launch env', () => {
  it('injects dialog suppression and background launch defaults', () => {
    expect(withE2ELaunchEnv()).toMatchObject({
      ORCA_SUPPRESS_DIALOGS: '1',
      ORCA_BACKGROUND_LAUNCH: '1'
    })
  })

  it('does not override an explicit value', () => {
    const env = withE2ELaunchEnv({ ORCA_BACKGROUND_LAUNCH: '0', ORCA_E2E_HEADLESS: '1' })
    expect(env).toMatchObject({
      ORCA_BACKGROUND_LAUNCH: '0',
      ORCA_SUPPRESS_DIALOGS: '1',
      ORCA_E2E_HEADLESS: '1'
    })
  })

  it('launches with the merged env', async () => {
    const { app } = fakeApp()
    let captured: Record<string, string | undefined> = {}
    const launched = await launchElectronAppWithStartupGuard(
      { args: [], env: { ORCA_BACKGROUND_LAUNCH: '0' } },
      {
        launcher: async (options) => {
          captured = options.env ?? {}
          return app
        }
      }
    )
    expect(launched).toBe(app)
    expect(captured).toMatchObject({
      ORCA_SUPPRESS_DIALOGS: '1',
      ORCA_BACKGROUND_LAUNCH: '0'
    })
  })
})

describe('electron startup guard', () => {
  it('reports launch failures with the underlying reason', async () => {
    await expect(
      launchElectronAppWithStartupGuard(
        { args: [] },
        {
          launcher: async () => {
            throw new Error('bad main bundle')
          }
        }
      )
    ).rejects.toThrow('startup failed: bad main bundle')
  })

  it('times out a hung launch and reports the reason', async () => {
    vi.useFakeTimers()
    const pending = launchElectronAppWithStartupGuard(
      { args: [] },
      { timeoutMs: 100, launcher: () => new Promise<never>(() => {}) }
    )
    const assertion = expect(pending).rejects.toThrow(
      'startup failed: electron.launch exceeded 100ms'
    )
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('closes a hung first window and marks the instance force-closed', async () => {
    vi.useFakeTimers()
    const { app, close } = fakeApp()
    await launchElectronAppWithStartupGuard({ args: [] }, { launcher: async () => app })
    const pending = firstWindowWithStartupGuard(app, { timeout: 100 })
    const assertion = expect(pending).rejects.toThrow(
      'startup failed: firstWindow exceeded 100ms；已强制关闭实例'
    )
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a launch that settles after the deadline', async () => {
    vi.useFakeTimers()
    const { app, close } = fakeApp()
    let resolveLaunch: (value: ElectronApplication) => void = () => {}
    const pending = launchElectronAppWithStartupGuard(
      { args: [] },
      {
        timeoutMs: 100,
        launcher: () =>
          new Promise<ElectronApplication>((resolve) => {
            resolveLaunch = resolve
          })
      }
    )
    const assertion = expect(pending).rejects.toThrow(
      'startup failed: electron.launch exceeded 100ms'
    )
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    resolveLaunch(app)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
  })
})
