import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { FileActionTarget } from './mobile-file-actions'
import {
  buildMobileFileCopyEvent,
  MOBILE_COPY_CAPTURE_POINT,
  MOBILE_FILE_EVENT_METHOD,
  MOBILE_SAVE_CAPTURE_POINT,
  MOBILE_SAVE_METHOD,
  mobileSavedFileName,
  reportMobileFileCopy,
  reportMobileFileCopyFailure,
  reportMobileFileSave
} from './mobile-file-event-capture'

/** U66-4: AC-56 save-to-phone and AC-57 copy events over `audit.recordFileEvent`. */

const TARGET: FileActionTarget = {
  source: 'worktree',
  hostId: 'host-1',
  worktreeId: 'wt-1',
  relativePath: 'src/app.ts',
  name: 'app.ts',
  kind: 'text',
  previewable: true
}

function sender(result: unknown = { queued: true, acceptedSeq: 7 }) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const sendRequest = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this mock only receives the event bodies built by the module under test, which are objects.
    calls.push({ method, params: params as Record<string, unknown> })
    return { id: 'rpc-1', ok: true, result }
  })
  return { calls, sendRequest }
}

function metadataOf(call: { params: Record<string, unknown> }): Record<string, unknown> {
  return call.params.metadata as Record<string, unknown>
}

describe('reportMobileFileSave', () => {
  it('reports a confirmed SAF save and supplements savedName under the same trace', async () => {
    const s = sender()
    await reportMobileFileSave(s, {
      target: TARGET,
      outcome: 'saved',
      savedName: 'app.ts',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
      occurredAt: 1_800_000_000_000
    })

    expect(s.calls).toHaveLength(2)
    const [success, supplement] = s.calls
    expect(success.method).toBe(MOBILE_FILE_EVENT_METHOD)
    expect(success.params).toMatchObject({ eventType: 'file_download', result: 'success' })
    expect(metadataOf(success)).toMatchObject({
      fileName: 'app.ts',
      path: 'src/app.ts',
      method: MOBILE_SAVE_METHOD,
      kind: 'file',
      surface: 'mobile',
      capturePoint: MOBILE_SAVE_CAPTURE_POINT,
      captureConfidence: 'client-declared',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
      sha256Source: 'client',
      occurredAt: 1_800_000_000_000
    })
    expect(supplement.params.traceId).toBe(success.params.traceId)
    expect(supplement.params).toMatchObject({ eventType: 'file_download', result: 'success' })
    expect(metadataOf(supplement)).toEqual({ savedName: 'app.ts' })
  })

  it('never names a local file when the share sheet resolved', async () => {
    const s = sender()
    await reportMobileFileSave(s, {
      target: TARGET,
      outcome: 'shared',
      sizeBytes: 3,
      sha256: 'abc',
      occurredAt: 1
    })

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].params.result).toBe('success')
    expect(metadataOf(s.calls[0])).toMatchObject({
      reason: 'share_sheet',
      capturePoint: MOBILE_SAVE_CAPTURE_POINT
    })
    expect(metadataOf(s.calls[0]).savedName).toBeUndefined()
  })

  it('records a cancelled save as a failure with no savedName', async () => {
    const s = sender()
    await reportMobileFileSave(s, { target: TARGET, outcome: 'cancelled', occurredAt: 1 })

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].params.result).toBe('failure')
    expect(metadataOf(s.calls[0])).toMatchObject({ reason: 'client_cancelled' })
    expect(metadataOf(s.calls[0]).savedName).toBeUndefined()
  })

  it('records a failed save with the action failure code', async () => {
    const s = sender()
    await reportMobileFileSave(s, {
      target: TARGET,
      outcome: 'failed',
      reason: 'save_failed',
      occurredAt: 1
    })

    expect(s.calls[0].params.result).toBe('failure')
    expect(metadataOf(s.calls[0])).toMatchObject({ reason: 'save_failed' })
  })

  it('reports a terminal artifact as kind=artifact', async () => {
    const s = sender()
    await reportMobileFileSave(s, {
      target: {
        source: 'terminalArtifact',
        worktreeId: 'wt-1',
        absolutePath: '/tmp/out.txt',
        grantId: 'g-1',
        displayPath: 'out.txt',
        name: 'out.txt',
        kind: 'text'
      } satisfies FileActionTarget,
      outcome: 'saved',
      savedName: 'out.txt',
      sizeBytes: 2,
      occurredAt: 1
    })

    expect(metadataOf(s.calls[0]).kind).toBe('artifact')
  })

  it('stays silent when the host refuses or the RPC throws', async () => {
    const refused = sender({ queued: false, reason: 'non-cloud-session' })
    await expect(
      reportMobileFileSave(refused, { target: TARGET, outcome: 'saved', savedName: 'app.ts' })
    ).resolves.toBeUndefined()
    // Nothing to merge into: the refused success event is not supplemented.
    expect(refused.calls).toHaveLength(1)

    const broken = {
      sendRequest: vi.fn(async () => {
        throw new Error('offline')
      })
    }
    await expect(
      reportMobileFileSave(broken, { target: TARGET, outcome: 'saved', savedName: 'app.ts' })
    ).resolves.toBeUndefined()

    await expect(
      reportMobileFileSave(null, { target: TARGET, outcome: 'saved', savedName: 'app.ts' })
    ).resolves.toBeUndefined()
  })
})

describe('reportMobileFileCopy', () => {
  it('reports copiedChars/copiedBytes for the text that reached the clipboard', async () => {
    const s = sender()
    await reportMobileFileCopy(s, { target: TARGET, content: 'file body', occurredAt: 1 })

    expect(s.calls).toHaveLength(1)
    expect(s.calls[0].method).toBe(MOBILE_FILE_EVENT_METHOD)
    expect(s.calls[0].params).toMatchObject({ eventType: 'file_copy', result: 'success' })
    const metadata = metadataOf(s.calls[0])
    expect(metadata).toMatchObject({
      fileName: 'app.ts',
      path: 'src/app.ts',
      copyKind: 'content-whole',
      copiedChars: 9,
      copiedBytes: 9,
      surface: 'mobile',
      capturePoint: MOBILE_COPY_CAPTURE_POINT,
      captureConfidence: 'client-declared'
    })
    expect(metadata.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(metadata.sha256Source).toBe('client')
  })

  it('counts the truncated text that was actually copied', async () => {
    const report = buildMobileFileCopyEvent({
      target: TARGET,
      content: 'first',
      occurredAt: 1,
      traceId: 'tr_1'
    })
    expect(report.metadata).toMatchObject({ copiedChars: 5, copiedBytes: 5 })
  })

  it('counts UTF-8 bytes rather than code units', async () => {
    const report = buildMobileFileCopyEvent({
      target: TARGET,
      content: 'é',
      occurredAt: 1,
      traceId: 'tr_1'
    })
    expect(report.metadata).toMatchObject({ copiedChars: 1, copiedBytes: 2 })
  })

  it('records clipboard write failure as file_copy failure', async () => {
    const s = sender()
    await reportMobileFileCopyFailure(s, {
      target: TARGET,
      reason: 'clipboard_write_failed',
      occurredAt: 1
    })

    expect(s.calls[0].params).toMatchObject({ eventType: 'file_copy', result: 'failure' })
    expect(metadataOf(s.calls[0])).toMatchObject({
      copyKind: 'content-whole',
      copiedChars: 0,
      copiedBytes: 0,
      capturePoint: MOBILE_COPY_CAPTURE_POINT,
      reason: 'clipboard_write_failed'
    })
  })

  it('records a read failure as file_copy failure', async () => {
    const s = sender()
    await reportMobileFileCopyFailure(s, { target: TARGET, reason: 'read_failed' })

    expect(metadataOf(s.calls[0])).toMatchObject({ reason: 'read_failed' })
  })

  it('stays silent when the RPC throws', async () => {
    const broken = {
      sendRequest: vi.fn(async () => {
        throw new Error('offline')
      })
    }
    await expect(
      reportMobileFileCopy(broken, { target: TARGET, content: 'x' })
    ).resolves.toBeUndefined()
  })
})

describe('mobileSavedFileName', () => {
  it('takes the basename of the SAF visible path and falls back to the prepared name', () => {
    expect(mobileSavedFileName('Download/app (1).ts', 'app.ts')).toBe('app (1).ts')
    expect(mobileSavedFileName('', 'app.ts')).toBe('app.ts')
  })
})
