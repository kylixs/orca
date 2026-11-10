import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  REMOTE_TERMINAL_LOAD_TIMING_KEY,
  beginSnapshotLoad,
  endSnapshotLoad,
  recordSnapshotApplied,
  recordSnapshotChunk,
  recordSnapshotRequested
} from './remote-terminal-load-timing'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

const emit = vi.mocked(recordRendererCrashBreadcrumb)

// The node test env has no DOM storage; the module reads localStorage behind a try/catch.
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear()
})

// Only `streamId`/`terminal`/`snapshotTarget` are read; the cast stands in for the full state.
function stream(snapshotTarget: 'initial' | 'request' | 'recovery' = 'initial'): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the module reads only these three fields; a full stream state is not constructible here.
  return { streamId: 7, terminal: 'term-1', snapshotTarget } as never
}

const phases = (): string[] => emit.mock.calls.map(([, data]) => String(data?.phase))

describe('remote-terminal-load-timing', () => {
  beforeEach(() => {
    emit.mockClear()
    storage.clear()
  })

  it('is inert while the localStorage switch is off', () => {
    const s = stream()
    recordSnapshotRequested(s)
    beginSnapshotLoad(s, 'initial', { scrollbackRows: 1000 })
    recordSnapshotChunk(s, 4096)
    endSnapshotLoad(s)
    recordSnapshotApplied(s, { seq: 1 }, 100)
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports subscribed → start → received → applied with byte and timing fields', () => {
    storage.set(REMOTE_TERMINAL_LOAD_TIMING_KEY, '1')
    const s = stream()
    recordSnapshotRequested(s)
    beginSnapshotLoad(s, 'initial', { scrollbackRows: 1000, cols: 200, rows: 50 })
    recordSnapshotChunk(s, 4096)
    recordSnapshotChunk(s, 4096)
    endSnapshotLoad(s)
    recordSnapshotApplied(s, { seq: 42, carriesHistory: true }, 8192)

    expect(phases()).toEqual(['subscribed', 'start', 'received', 'applied'])
    const received = emit.mock.calls.find(([, d]) => d?.phase === 'received')?.[1]
    expect(received).toMatchObject({ target: 'initial', chunks: 2, bytes: 8192 })
    expect(typeof received?.requestMs).toBe('number')
    expect(typeof received?.firstByteMs).toBe('number')
    expect(typeof received?.transferMs).toBe('number')
    const applied = emit.mock.calls.find(([, d]) => d?.phase === 'applied')?.[1]
    expect(applied).toMatchObject({ seq: 42, carriesHistory: true, chars: 8192 })
  })

  it('carries the host-declared depth and truncation on start', () => {
    storage.set(REMOTE_TERMINAL_LOAD_TIMING_KEY, '1')
    const s = stream()
    recordSnapshotRequested(s)
    beginSnapshotLoad(s, 'request', { scrollbackRows: 5000, truncated: true })
    const start = emit.mock.calls.find(([, d]) => d?.phase === 'start')?.[1]
    expect(start).toMatchObject({ target: 'request', scrollbackRows: 5000, truncated: true })
  })
})
