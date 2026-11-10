import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyFileReadFailure,
  clearFileReadFailure,
  clearNetworkFileReadFailures,
  getFileReadFailure,
  recordFileReadFailure,
  resetFileReadFailures,
  subscribeFileReadFailures
} from './file-read-failures'

const SCOPE = { hostId: 'host-1', worktreeId: 'wt-1' }

afterEach(() => {
  resetFileReadFailures()
})

describe('file read failure registry', () => {
  it('classifies the errors a row badge distinguishes', () => {
    expect(classifyFileReadFailure('EACCES: permission denied')).toBe('permission')
    expect(classifyFileReadFailure('EPERM: operation not permitted')).toBe('permission')
    expect(classifyFileReadFailure('ENOENT: no such file or directory')).toBe('not-found')
    expect(classifyFileReadFailure('request timed out')).toBe('network')
    expect(classifyFileReadFailure('Waiting for desktop...')).toBe('network')
    expect(classifyFileReadFailure('Remote connection dropped')).toBe('network')
    expect(classifyFileReadFailure('something odd')).toBe('other')
  })

  it('records per host and worktree and clears on success', () => {
    recordFileReadFailure(SCOPE, 'src/app.ts', 'EACCES')
    expect(getFileReadFailure(SCOPE, 'src/app.ts')?.code).toBe('permission')
    expect(getFileReadFailure({ ...SCOPE, worktreeId: 'wt-2' }, 'src/app.ts')).toBeUndefined()
    clearFileReadFailure(SCOPE, 'src/app.ts')
    expect(getFileReadFailure(SCOPE, 'src/app.ts')).toBeUndefined()
  })

  it('leaves permission failures for Retry when the connection returns', () => {
    recordFileReadFailure(SCOPE, 'a.ts', 'EACCES')
    recordFileReadFailure(SCOPE, 'b.ts', 'ENOENT')
    recordFileReadFailure(SCOPE, 'c.ts', 'connection dropped')
    clearNetworkFileReadFailures(SCOPE)
    expect(getFileReadFailure(SCOPE, 'a.ts')?.code).toBe('permission')
    expect(getFileReadFailure(SCOPE, 'b.ts')?.code).toBe('not-found')
    expect(getFileReadFailure(SCOPE, 'c.ts')).toBeUndefined()
  })

  it('notifies the explorer so a preview failure becomes a row badge', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeFileReadFailures(listener)
    recordFileReadFailure(SCOPE, 'a.ts', 'EACCES')
    recordFileReadFailure(SCOPE, 'a.ts', 'EACCES')
    expect(listener).toHaveBeenCalledTimes(1)
    clearFileReadFailure(SCOPE, 'a.ts')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
