import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock } = vi.hoisted(() => ({ showMessageBoxMock: vi.fn() }))

vi.mock('electron', () => ({ dialog: { showMessageBox: showMessageBoxMock } }))

import {
  chooseProfileStateCopy,
  presentProfileStateStartupRecoveryDialog,
  showProfileStateCopyMessageBox,
  showProfileStateRecoveryMessageBox
} from './profile-state-startup-recovery-dialog'

describe('profile state startup recovery dialog', () => {
  it('offers a copyable offline export command and does not mutate state', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 })
    const copyToClipboard = vi.fn()

    await presentProfileStateStartupRecoveryDialog({
      message: 'SQLite state is unreadable.\nSQLite path: /tmp/profile-state.db',
      recoveryCommand: 'orca profile state exports',
      showMessageBox,
      copyToClipboard
    })

    expect(showMessageBox).toHaveBeenCalledWith({
      type: 'error',
      buttons: ['Copy recovery command', 'Quit'],
      defaultId: 1,
      cancelId: 1,
      title: 'Orca profile state cannot be opened',
      message: 'Orca cannot safely open this profile.',
      detail:
        'SQLite state is unreadable.\nSQLite path: /tmp/profile-state.db\n\nCopy the recovery command, then run it after Orca closes.'
    })
    expect(copyToClipboard).toHaveBeenCalledWith('orca profile state exports')
  })

  it('leaves the clipboard untouched when the user quits', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 1 })
    const copyToClipboard = vi.fn()

    await presentProfileStateStartupRecoveryDialog({
      message: 'ambiguous profile state',
      recoveryCommand: 'orca profile state exports',
      showMessageBox,
      copyToClipboard
    })

    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it('does not offer rollback for an authority ambiguity', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 0 })
    const copyToClipboard = vi.fn()

    await presentProfileStateStartupRecoveryDialog({
      message: 'both profile authorities are present',
      showMessageBox,
      copyToClipboard
    })

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Quit'],
        defaultId: 0,
        cancelId: 0,
        detail:
          'both profile authorities are present\n\nQuit Orca and resolve the profile-state authority before retrying.'
      })
    )
    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it.each([
    [0, 'current-sqlite'],
    [1, 'current-json'],
    [2, undefined]
  ] as const)('maps choice button %i to %s', async (response, expected) => {
    const showMessageBox = vi.fn().mockResolvedValue({ response })
    await expect(
      chooseProfileStateCopy({
        sqliteSavedAt: new Date(1),
        jsonSavedAt: new Date(2),
        formatTime: (time) => `t${time.getTime()}`,
        showMessageBox
      })
    ).resolves.toBe(expected)
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['Use SQLite (Recommended)', 'Use JSON', 'Quit'],
        defaultId: 0,
        cancelId: 2
      })
    )
    const { detail } = showMessageBox.mock.calls[0][0]
    expect(detail).toContain('Last saved t1.')
    expect(detail).toContain('Last saved t2.')
  })

  it('omits save times it could not read', async () => {
    const showMessageBox = vi.fn().mockResolvedValue({ response: 2 })
    await chooseProfileStateCopy({ showMessageBox })
    expect(showMessageBox.mock.calls[0][0].detail).not.toContain('Last saved')
  })
})

describe('non-interactive profile state answers', () => {
  beforeEach(() => {
    process.env.ORCA_SUPPRESS_DIALOGS = '1'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    delete process.env.ORCA_SUPPRESS_DIALOGS
    vi.restoreAllMocks()
    showMessageBoxMock.mockReset()
  })

  it('answers the copy prompt with Quit, never choosing a copy to apply', async () => {
    await expect(
      showProfileStateCopyMessageBox({
        buttons: ['Use SQLite (Recommended)', 'Use JSON', 'Quit'],
        defaultId: 0,
        cancelId: 2,
        title: 'Choose profile state',
        message: 'This profile has two saved copies that don’t match.'
      })
    ).resolves.toEqual({ response: 2, checkboxChecked: false })
    expect(showMessageBoxMock).not.toHaveBeenCalled()

    // Quit maps to no choice, so index.ts skips the destructive relaunch.
    await expect(
      chooseProfileStateCopy({ showMessageBox: showProfileStateCopyMessageBox })
    ).resolves.toBeUndefined()
  })

  it('answers the recovery prompt with its Quit button, not the copy command', async () => {
    await expect(
      showProfileStateRecoveryMessageBox({
        buttons: ['Copy recovery command', 'Quit'],
        defaultId: 1,
        cancelId: 1,
        title: 'Orca profile state cannot be opened',
        message: 'Orca cannot safely open this profile.'
      })
    ).resolves.toEqual({ response: 1, checkboxChecked: false })

    const copyToClipboard = vi.fn()
    await presentProfileStateStartupRecoveryDialog({
      message: 'SQLite state is unreadable.',
      recoveryCommand: 'orca profile state exports',
      showMessageBox: showProfileStateRecoveryMessageBox,
      copyToClipboard
    })
    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it('answers the single-button recovery prompt with Quit', async () => {
    await expect(
      showProfileStateRecoveryMessageBox({
        buttons: ['Quit'],
        defaultId: 0,
        cancelId: 0,
        title: 'Orca profile state cannot be opened',
        message: 'Orca cannot safely open this profile.'
      })
    ).resolves.toEqual({ response: 0, checkboxChecked: false })
  })
})
