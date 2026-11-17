import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock, showErrorBoxMock, exitMock, whenReadyMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  showErrorBoxMock: vi.fn(),
  exitMock: vi.fn(),
  whenReadyMock: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  app: { exit: exitMock, whenReady: whenReadyMock },
  dialog: { showMessageBox: showMessageBoxMock, showErrorBox: showErrorBoxMock }
}))

vi.mock('./main-process-state', () => ({
  mainProcessState: {
    isServeMode: false,
    desktopActivationGate: null,
    profileStateAdmission: undefined
  }
}))

vi.mock('./single-instance-lock', () => ({
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE: 42
}))

import { promptForGpuFallbackRecoveredLaunch } from '../crash-reporting/gpu-fallback-recovered-launch'
import { promptForGpuFallbackRestart } from '../crash-reporting/gpu-fallback-restart-prompt'
import { handleMainProcessPreflightFailure } from './main-process-preflight-failure'
import {
  isNonInteractiveLaunch,
  showUserErrorBox,
  showUserMessageBox
} from './non-interactive-launch'

const ENV_KEYS = [
  'ORCA_BACKGROUND_LAUNCH',
  'ORCA_E2E_HEADLESS',
  'ORCA_SUPPRESS_DIALOGS',
  'ELECTRON_RUN_AS_NODE'
] as const

function setLaunchEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  Object.assign(process.env, values)
}

let consoleWarn: ReturnType<typeof vi.spyOn>
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  showMessageBoxMock.mockResolvedValue({ response: 0, checkboxChecked: false })
  setLaunchEnv()
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  setLaunchEnv()
  vi.restoreAllMocks()
})

describe('isNonInteractiveLaunch', () => {
  it.each(ENV_KEYS)('is true when %s requests a non-interactive launch', (key) => {
    expect(isNonInteractiveLaunch({ [key]: '1' })).toBe(true)
  })

  it.each(ENV_KEYS)('is false when %s is only "0"', (key) => {
    expect(isNonInteractiveLaunch({ [key]: '0' })).toBe(false)
  })

  it('is false for an ordinary interactive launch', () => {
    expect(isNonInteractiveLaunch({})).toBe(false)
    expect(isNonInteractiveLaunch({ ORCA_E2E_FOREGROUND: '1' })).toBe(false)
  })

  it('defaults to the process environment', () => {
    setLaunchEnv({ ORCA_E2E_HEADLESS: '1' })
    expect(isNonInteractiveLaunch()).toBe(true)
  })
})

describe('showUserMessageBox', () => {
  it('logs and answers the first button without touching the dialog off-screen', async () => {
    setLaunchEnv({ ORCA_BACKGROUND_LAUNCH: '1' })

    await expect(
      showUserMessageBox({ title: 'Safe Graphics Mode is Active', message: 'Recovered.' })
    ).resolves.toEqual({ response: 0, checkboxChecked: false })

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith('[dialogs] suppressed: Safe Graphics Mode is Active')
  })

  it('keeps only the first line of the suppressed message in the log', async () => {
    setLaunchEnv({ ORCA_SUPPRESS_DIALOGS: '1' })

    await showUserMessageBox({ message: 'First line\nSecond line' })

    expect(consoleWarn).toHaveBeenCalledWith('[dialogs] suppressed: First line')
  })

  it('can answer with a safer non-default button', async () => {
    setLaunchEnv({ ORCA_E2E_HEADLESS: '1' })

    await expect(showUserMessageBox({ message: 'Upload?' }, undefined, 1)).resolves.toEqual({
      response: 1,
      checkboxChecked: false
    })
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('delegates to the dialog with the parent window when interactive', async () => {
    const options = { type: 'question' as const, message: 'Continue?' }
    const parentWindow = { id: 1 }
    const expected = { response: 1, checkboxChecked: false }
    showMessageBoxMock.mockResolvedValue(expected)

    await expect(showUserMessageBox(options, parentWindow as never)).resolves.toBe(expected)
    expect(showMessageBoxMock).toHaveBeenCalledExactlyOnceWith(parentWindow, options)
  })

  it('delegates to the parentless dialog when interactive', async () => {
    const options = { type: 'error' as const, message: 'Failed' }

    await showUserMessageBox(options)

    expect(showMessageBoxMock).toHaveBeenCalledExactlyOnceWith(options)
  })
})

describe('showUserErrorBox', () => {
  it('only logs when non-interactive', () => {
    setLaunchEnv({ ELECTRON_RUN_AS_NODE: '1' })

    showUserErrorBox('Orca could not start', 'profile is locked')

    expect(showErrorBoxMock).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith(
      '[dialogs] suppressed: Orca could not start: profile is locked'
    )
  })

  it('forwards the exact text when interactive', () => {
    showUserErrorBox('Orca could not start', 'profile is locked')

    expect(showErrorBoxMock).toHaveBeenCalledExactlyOnceWith(
      'Orca could not start',
      'profile is locked'
    )
  })
})

describe('handleMainProcessPreflightFailure', () => {
  it('logs and exits without a dialog in a non-interactive launch', () => {
    setLaunchEnv({ ORCA_BACKGROUND_LAUNCH: '1' })

    handleMainProcessPreflightFailure(new Error('profile is locked'))

    expect(showErrorBoxMock).not.toHaveBeenCalled()
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(1)
    expect(consoleError).toHaveBeenCalledWith('[startup] Orca could not start: profile is locked')
  })

  it('shows the dialog before exiting in an interactive launch', () => {
    handleMainProcessPreflightFailure(new Error('profile is locked'))

    expect(showErrorBoxMock).toHaveBeenCalledExactlyOnceWith(
      'Orca could not start',
      'profile is locked'
    )
    expect(exitMock).toHaveBeenCalledExactlyOnceWith(1)
    expect(showErrorBoxMock.mock.invocationCallOrder[0]).toBeLessThan(
      exitMock.mock.invocationCallOrder[0]
    )
  })
})

describe('GPU fallback prompts', () => {
  it('keeps safe graphics without showing the recovered-launch prompt', async () => {
    setLaunchEnv({ ORCA_BACKGROUND_LAUNCH: '1' })

    await expect(promptForGpuFallbackRecoveredLaunch()).resolves.toBe('keep-safe')
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('continues without showing the restart prompt', async () => {
    setLaunchEnv({ ORCA_BACKGROUND_LAUNCH: '1' })

    await expect(promptForGpuFallbackRestart()).resolves.toBe('continue')
    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })
})
