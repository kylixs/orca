import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { PreparedCachedFile } from './mobile-file-download-cache'
import type { FileActionTarget } from './mobile-file-actions'

const deps = vi.hoisted(() => ({
  prepare: vi.fn(),
  clipboardWrite: vi.fn(async () => {}),
  save: vi.fn(),
  open: vi.fn(async () => 'opened' as const),
  copyContent: vi.fn(),
  capabilities: { saveToPhone: true, openWith: true }
}))

vi.mock('expo-file-system', () => ({
  Directory: class {
    delete(): void {}
  },
  File: class {},
  Paths: { cache: '' }
}))
vi.mock('./mobile-file-prepare', () => ({ prepareFileForAction: deps.prepare }))
vi.mock('./mobile-file-save', () => ({ savePreparedFileToPhone: deps.save }))
vi.mock('../platform/open-file', () => ({ openPreparedFile: deps.open }))
vi.mock('./mobile-file-copy-content', () => ({ readFileContentForCopy: deps.copyContent }))
vi.mock('./file-action-capabilities', () => ({
  fileActionCapabilities: () => deps.capabilities
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: deps.clipboardWrite })
}))

import { useMobileFileActions } from './use-mobile-file-actions'
import {
  getFileReadFailure,
  recordFileReadFailure,
  resetFileReadFailures
} from './file-read-failures'
import { resetAllFileActionTasks, taskStateFor } from './mobile-file-action-tasks'
import { fileActionTargetKey } from './mobile-file-actions'
import { FileActionError } from './file-action-error'
import { MOBILE_FILE_EVENT_METHOD } from './mobile-file-event-capture'

const SCOPE = { hostId: 'host-1', worktreeId: 'wt-1' }
const TARGET: FileActionTarget = {
  source: 'worktree',
  hostId: 'host-1',
  worktreeId: 'wt-1',
  relativePath: 'src/app.ts',
  name: 'app.ts',
  kind: 'text',
  previewable: true
}

const PREPARED: PreparedCachedFile = {
  targetKey: fileActionTargetKey(TARGET),
  fileName: 'app.ts',
  uri: 'file:///cache/one/app.ts',
  directoryUri: 'file:///cache/one',
  size: 3,
  sha256: 'abc',
  mimeType: 'text/plain',
  uti: 'public.plain-text',
  createdAt: 1,
  usedAt: 1
}

type ActionsApi = ReturnType<typeof useMobileFileActions>
const latest: { api: ActionsApi | null } = { api: null }
const client = {
  sendRequest: vi.fn(async (_method: string, _params?: unknown): Promise<RpcResponse> => {
    throw new Error('unexpected RPC call')
  })
}

let activeClient: typeof client = client

function Harness() {
  latest.api = useMobileFileActions({ client: activeClient, target: TARGET, scope: SCOPE })
  return null
}

function auditSender(): typeof client {
  return {
    sendRequest: vi.fn(async (_method: string, _params?: unknown): Promise<RpcResponse> => ({
      id: 'rpc-1',
      ok: true,
      result: { queued: true, acceptedSeq: 1 }
    }))
  }
}

/** Body of the nth `audit.recordFileEvent` send; unknown on purpose, asserted structurally. */
function eventBody(sender: typeof client, index = 0): unknown {
  return sender.sendRequest.mock.calls[index]?.[1]
}

function eventTraceId(body: unknown): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: event bodies are the objects built by the module under test.
  return typeof body === 'object' && body !== null
    ? (body as { traceId?: unknown }).traceId
    : undefined
}

let tree: ReactTestRenderer | null = null

function currentActions(): ActionsApi {
  if (!latest.api) {
    throw new Error('actions hook did not render')
  }
  return latest.api
}

async function renderActions(): Promise<ActionsApi> {
  await act(async () => {
    tree = create(createElement(Harness))
  })
  return currentActions()
}

beforeEach(() => {
  activeClient = client
  deps.prepare.mockReset()
  deps.prepare.mockResolvedValue(PREPARED)
  deps.clipboardWrite.mockReset()
  deps.clipboardWrite.mockResolvedValue(undefined)
  deps.save.mockReset()
  deps.save.mockResolvedValue({ kind: 'saved', path: 'Download/app.ts', sha256: 'abc' })
  deps.open.mockReset()
  deps.open.mockResolvedValue('opened')
  deps.copyContent.mockReset()
  deps.copyContent.mockResolvedValue({
    content: 'file body',
    truncated: false,
    byteLength: 9
  })
  deps.capabilities.saveToPhone = true
  deps.capabilities.openWith = true
})

afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = null
  latest.api = null
  resetAllFileActionTasks()
  resetFileReadFailures()
  vi.restoreAllMocks()
})

describe('useMobileFileActions', () => {
  it('does not clear an EACCES badge when only the path was copied', async () => {
    recordFileReadFailure(SCOPE, 'src/app.ts', 'EACCES')
    const actions = await renderActions()

    await act(async () => {
      await actions.copyPath()
    })

    expect(getFileReadFailure(SCOPE, 'src/app.ts')).toBeDefined()
    expect(latest.api?.notice).toMatchObject({ message: 'Copied path' })
  })

  it('copies the readable prefix and says so when the read was truncated', async () => {
    deps.copyContent.mockResolvedValue({ content: 'first', truncated: true, byteLength: 600_000 })
    const actions = await renderActions()

    await act(async () => {
      await actions.copyContent()
    })

    expect(deps.clipboardWrite).toHaveBeenCalledWith('first')
    expect(latest.api?.notice).toMatchObject({ tone: 'info', message: 'Copied first 512 KB' })
  })

  it('does not blame the file when the clipboard write fails after a successful read', async () => {
    deps.clipboardWrite.mockRejectedValue(new Error('clipboard unavailable'))
    const actions = await renderActions()

    await act(async () => {
      await actions.copyContent()
    })

    expect(deps.copyContent).toHaveBeenCalled()
    expect(getFileReadFailure(SCOPE, 'src/app.ts')).toBeUndefined()
    expect(latest.api?.notice).toMatchObject({ tone: 'error', message: 'clipboard unavailable' })
  })

  it('never reports a dismissed share sheet as Saved to phone', async () => {
    deps.save.mockResolvedValue({ kind: 'shared', path: 'app.ts', sha256: 'abc' })
    const actions = await renderActions()

    await act(async () => {
      await actions.save()
    })

    expect(latest.api?.saveResult).toBeNull()
    expect(latest.api?.notice).toMatchObject({
      tone: 'info',
      message: 'Shared. Check your Files app to confirm the save.'
    })
  })

  it('ignores a second Save while the first prepare is still running', async () => {
    let resolvePrepare: ((value: PreparedCachedFile) => void) | undefined
    deps.prepare.mockImplementation(
      () =>
        new Promise<PreparedCachedFile>((resolve) => {
          resolvePrepare = resolve
        })
    )
    const actions = await renderActions()

    await act(async () => {
      const first = actions.save()
      const second = actions.save()
      resolvePrepare?.(PREPARED)
      await Promise.all([first, second])
    })

    expect(deps.prepare).toHaveBeenCalledTimes(1)
    expect(deps.save).toHaveBeenCalledTimes(1)
  })

  it('re-prepares after Save used the bytes, so an edited file is read again', async () => {
    const actions = await renderActions()

    await act(async () => {
      await actions.save()
    })
    await act(async () => {
      await actions.save()
    })

    expect(deps.prepare).toHaveBeenCalledTimes(2)
    expect(deps.save).toHaveBeenCalledTimes(2)
    expect(taskStateFor(fileActionTargetKey(TARGET)).status).toBe('idle')
  })

  it('reports a completed Save as file_download and supplements savedName (AC-56)', async () => {
    const rpc = auditSender()
    activeClient = rpc
    const actions = await renderActions()

    await act(async () => {
      await actions.save()
    })

    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledTimes(2))
    const [success, supplement] = rpc.sendRequest.mock.calls
    expect(success[0]).toBe(MOBILE_FILE_EVENT_METHOD)
    expect(success[1]).toMatchObject({
      eventType: 'file_download',
      result: 'success',
      metadata: {
        fileName: 'app.ts',
        path: 'src/app.ts',
        method: 'mobile.saveToPhone',
        kind: 'file',
        surface: 'mobile',
        capturePoint: 'mobile-save',
        captureConfidence: 'client-declared',
        sizeBytes: 3
      }
    })
    expect(JSON.stringify(success[1])).not.toContain('savedName')
    expect(supplement[1]).toMatchObject({
      eventType: 'file_download',
      result: 'success',
      metadata: { savedName: 'app.ts' }
    })
    expect(eventTraceId(supplement[1])).toBe(eventTraceId(success[1]))
    expect(eventTraceId(supplement[1])).toEqual(expect.stringMatching(/^tr_/))
  })

  it('records a cancelled Save as failure and never as savedName (AC-56)', async () => {
    const rpc = auditSender()
    activeClient = rpc
    deps.save.mockRejectedValue(new FileActionError('cancelled', 'Save cancelled'))
    const actions = await renderActions()

    await act(async () => {
      await actions.save()
    })

    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledTimes(1))
    expect(eventBody(rpc)).toMatchObject({
      eventType: 'file_download',
      result: 'failure',
      metadata: { capturePoint: 'mobile-save', reason: 'client_cancelled' }
    })
    expect(JSON.stringify(eventBody(rpc))).not.toContain('savedName')
  })

  it('reports Copy content as file_copy with the copied length (AC-57)', async () => {
    const rpc = auditSender()
    activeClient = rpc
    const actions = await renderActions()

    await act(async () => {
      await actions.copyContent()
    })

    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledTimes(1))
    expect(eventBody(rpc)).toMatchObject({
      eventType: 'file_copy',
      result: 'success',
      metadata: {
        fileName: 'app.ts',
        path: 'src/app.ts',
        copyKind: 'content-whole',
        copiedChars: 9,
        copiedBytes: 9,
        surface: 'mobile',
        capturePoint: 'mobile-copy-content',
        captureConfidence: 'client-declared'
      }
    })
  })

  it('records a clipboard write failure as file_copy result=failure (AC-57)', async () => {
    const rpc = auditSender()
    activeClient = rpc
    deps.clipboardWrite.mockRejectedValue(new Error('clipboard unavailable'))
    const actions = await renderActions()

    await act(async () => {
      await actions.copyContent()
    })

    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledTimes(1))
    expect(eventBody(rpc)).toMatchObject({
      eventType: 'file_copy',
      result: 'failure',
      metadata: { reason: 'clipboard_write_failed', copiedChars: 0, copiedBytes: 0 }
    })
  })

  it('records a read failure as file_copy result=failure (AC-57)', async () => {
    const rpc = auditSender()
    activeClient = rpc
    deps.copyContent.mockRejectedValue(new FileActionError('read_failed', 'unreadable'))
    const actions = await renderActions()

    await act(async () => {
      await actions.copyContent()
    })

    await vi.waitFor(() => expect(rpc.sendRequest).toHaveBeenCalledTimes(1))
    expect(eventBody(rpc)).toMatchObject({
      eventType: 'file_copy',
      result: 'failure',
      metadata: { reason: 'read_failed' }
    })
  })

  it('never records Copy path as a file event', async () => {
    const rpc = auditSender()
    activeClient = rpc
    const actions = await renderActions()

    await act(async () => {
      await actions.copyPath()
    })

    expect(rpc.sendRequest).not.toHaveBeenCalled()
  })

  it('retries the action recorded in the shared task, not a local one', async () => {
    deps.prepare.mockRejectedValueOnce(new Error('read failed'))
    const actions = await renderActions()
    await act(async () => {
      await actions.save()
    })
    expect(taskStateFor(fileActionTargetKey(TARGET))).toMatchObject({
      status: 'failed',
      action: 'save'
    })

    // A fresh mount represents the preview screen: its local history is empty.
    await act(async () => tree?.unmount())
    latest.api = null
    await act(async () => {
      tree = create(createElement(Harness))
    })
    const previewActions = currentActions()
    await act(async () => {
      previewActions.retry()
    })

    expect(deps.prepare).toHaveBeenCalledTimes(2)
    expect(deps.save).toHaveBeenCalledTimes(1)
  })
})
