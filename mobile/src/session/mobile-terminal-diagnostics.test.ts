import { describe, expect, it, vi } from 'vitest'
import {
  getMobileTerminalDiagnosticErrorName,
  logMobileTerminalDiagnostic,
  MobileTerminalDiagnostics,
  shortenMobileTerminalDiagnosticId
} from './mobile-terminal-diagnostics'

function loggedElapsedMs(call: readonly unknown[] | undefined): unknown {
  const details = call?.[2]
  return details != null && typeof details === 'object' && 'elapsedMs' in details
    ? details.elapsedMs
    : undefined
}

describe('mobile terminal diagnostics', () => {
  it('keeps only the correlatable suffix of identifiers', () => {
    expect(shortenMobileTerminalDiagnosticId('terminal-secret-prefix-12345678')).toBe('12345678')
    expect(shortenMobileTerminalDiagnosticId('short')).toBe('short')
    expect(shortenMobileTerminalDiagnosticId(null)).toBeNull()
  })

  it('reports thrown error types without copying potentially sensitive messages', () => {
    expect(getMobileTerminalDiagnosticErrorName(new TypeError('/private/worktree failed'))).toBe(
      'TypeError'
    )
    expect(getMobileTerminalDiagnosticErrorName('raw failure')).toBe('string')
  })

  it('uses one filterable structured log tag', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    logMobileTerminalDiagnostic('stream-armed', { handle: '12345678', seq: 2 })

    expect(log).toHaveBeenCalledWith('[terminal-diagnostic]', 'stream-armed', {
      handle: '12345678',
      seq: 2
    })
    log.mockRestore()
  })

  it('forgets first-event state when a terminal unsubscribes', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()

    diagnostics.firstStreamEvent('terminal-1', 1, 'subscribed')
    diagnostics.terminalUnsubscribed('terminal-1')
    diagnostics.firstStreamEvent('terminal-1', 1, 'subscribed')

    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })

  it('times each phase of the load cycle from the subscribe mark', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()

    diagnostics.streamArmed('terminal-1', 3, { cols: 47, rows: 40 })
    diagnostics.firstStreamEvent('terminal-1', 3, 'scrollback')
    diagnostics.scrollbackReceived('terminal-1', 3, 512)
    diagnostics.scrollbackApplied('terminal-1', 3)
    diagnostics.firstDataAfterHydration('terminal-1', 3)

    const events = log.mock.calls.map(([, event]) => event)
    expect(events).toEqual([
      'stream-armed',
      'stream-first-event',
      'stream-scrollback-received',
      'stream-scrollback-applied',
      'stream-first-data'
    ])
    // Every phase after the mark carries an elapsed offset from it.
    for (const call of log.mock.calls.slice(1)) {
      expect(typeof loggedElapsedMs(call)).toBe('number')
    }
    log.mockRestore()
  })

  it('ends the load cycle after the first post-hydration data chunk', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()

    diagnostics.streamArmed('terminal-1', 3, null)
    diagnostics.firstDataAfterHydration('terminal-1', 3)
    diagnostics.scrollbackApplied('terminal-1', 3)

    expect(loggedElapsedMs(log.mock.calls.at(-1))).toBeNull()
    log.mockRestore()
  })

  it('ignores a stale seq that no longer matches the armed load', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostics = new MobileTerminalDiagnostics()

    diagnostics.streamArmed('terminal-1', 3, null)
    diagnostics.scrollbackApplied('terminal-1', 2)

    expect(loggedElapsedMs(log.mock.calls.at(-1))).toBeNull()
    log.mockRestore()
  })
})
