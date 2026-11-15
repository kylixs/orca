// @vitest-environment happy-dom
import * as React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudProjectPermission, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { ownEntries, readField } from '../../../shared/json-fields'
import {
  CLOUD_FILE_COPY_RATE_LIMIT,
  CLOUD_FILE_EVENT_METHOD,
  cloudFileAuditSurface,
  cloudFileBaseName,
  cloudFileUtf8Bytes,
  createCloudFileCopyReporter,
  recordFileDownload,
  type CloudFileAuditResult
} from './cloud-file-copy-audit'
import { CloudWorkspaceFileTab } from './cloud-workspace-file-tab'
import type { CloudWorkspaceEditorProps } from './cloud-workspace-monaco-editor'

/** U66-3: web copy capture → `audit.recordFileEvent`, privacy and rate control. */

type Call = { method: string; params?: Record<string, unknown> }

function mockRpc(
  reply: (method: string, params?: Record<string, unknown>) => CloudRpcOutcome = () => ({
    ok: true,
    result: { queued: true }
  })
): { rpc: CloudRpc; calls: Call[] } {
  const calls: Call[] = []
  const rpc: CloudRpc = async (method, params) => {
    calls.push({ method, params })
    return reply(method, params)
  }
  return { rpc, calls }
}

const hex = (): string => 'a'.repeat(64)

function metadataOf(call: Call | undefined): Record<string, unknown> {
  return Object.fromEntries(ownEntries(readField(call?.params, 'metadata')))
}

function reporterWith(rpc: CloudRpc | null, now?: () => number) {
  return createCloudFileCopyReporter(rpc, {
    sha256: async () => hex(),
    ...(now ? { now } : {})
  })
}

afterEach(() => {
  cleanup()
})

describe('cloud file copy audit', () => {
  it('reports file_copy with the §2.3 fields and never the copied body', async () => {
    const { rpc, calls } = mockRpc()
    const reporter = reporterWith(rpc)
    const text = 'const SECRET_MARKER = 42\n'

    const result = await reporter.report({
      path: 'src/config/app.ts',
      text,
      copyKind: 'content-whole',
      capturePoint: 'web-clipboard-api',
      sizeBytes: cloudFileUtf8Bytes(text),
      isBinary: false,
      surface: 'web'
    })

    expect(result).toEqual({ reported: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe(CLOUD_FILE_EVENT_METHOD)
    const body = calls[0].params ?? {}
    expect(body.eventType).toBe('file_copy')
    expect(body.result).toBe('success')
    expect(String(body.traceId)).toMatch(/^tr_/)
    const metadata = metadataOf(calls[0])
    expect(metadata).toMatchObject({
      fileName: 'app.ts',
      path: 'src/config/app.ts',
      copyKind: 'content-whole',
      copiedChars: text.length,
      copiedBytes: cloudFileUtf8Bytes(text),
      sizeBytes: cloudFileUtf8Bytes(text),
      surface: 'web',
      capturePoint: 'web-clipboard-api',
      captureConfidence: 'client-declared',
      sha256: hex(),
      sha256Source: 'client',
      isBinary: false
    })
    expect(typeof metadata.occurredAt).toBe('number')
    expect(metadata).not.toHaveProperty('excerpt')
    expect(metadata).not.toHaveProperty('excerptBytes')
    // AC-53: the body itself must not reach the wire.
    expect(JSON.stringify(calls[0].params)).not.toContain('SECRET_MARKER')
  })

  it('records clipboard failure without a body', async () => {
    const { rpc, calls } = mockRpc()
    const reporter = reporterWith(rpc)

    await reporter.reportFailure({
      path: 'src/a.ts',
      copyKind: 'content-whole',
      capturePoint: 'web-clipboard-api',
      reason: 'clipboard_denied'
    })

    const body = calls[0].params ?? {}
    expect(body.result).toBe('failure')
    const metadata = metadataOf(calls[0])
    expect(metadata.reason).toBe('clipboard_denied')
    expect(metadata.copiedChars).toBe(0)
    expect(metadata.copiedBytes).toBe(0)
    expect(metadata).not.toHaveProperty('excerpt')
  })

  it('drops events after the client-side minute budget instead of hammering', async () => {
    const { rpc, calls } = mockRpc()
    const reporter = reporterWith(rpc, () => 1_000)

    const outcomes: CloudFileAuditResult[] = []
    for (let index = 0; index < CLOUD_FILE_COPY_RATE_LIMIT + 5; index += 1) {
      outcomes.push(
        await reporter.report({
          path: `src/a${index}.ts`,
          text: 'x',
          copyKind: 'content-whole',
          capturePoint: 'web-clipboard-api'
        })
      )
    }

    expect(calls).toHaveLength(CLOUD_FILE_COPY_RATE_LIMIT)
    expect(outcomes.at(-1)).toEqual({ reported: false, reason: 'rate-limited' })
  })

  it('is a no-op without a cloud session and never retries a host refusal', async () => {
    const withoutSession = reporterWith(null)
    expect(
      await withoutSession.report({
        path: 'src/a.ts',
        text: 'x',
        copyKind: 'content-whole',
        capturePoint: 'web-clipboard-api'
      })
    ).toEqual({ reported: false, reason: 'non-cloud-session' })

    const refused = mockRpc(() => ({
      ok: true,
      result: { queued: false, reason: 'non-cloud-session' }
    }))
    const reporter = reporterWith(refused.rpc)
    expect(
      await reporter.report({
        path: 'src/a.ts',
        text: 'x',
        copyKind: 'content-whole',
        capturePoint: 'web-clipboard-api'
      })
    ).toEqual({ reported: false, reason: 'host-rejected' })
    expect(refused.calls).toHaveLength(1)

    const offline = mockRpc(() => ({ ok: false, code: 'rate_limited' }))
    const offlineReporter = reporterWith(offline.rpc)
    expect(
      await offlineReporter.report({
        path: 'src/b.ts',
        text: 'y',
        copyKind: 'content-whole',
        capturePoint: 'web-clipboard-api'
      })
    ).toEqual({ reported: false, reason: 'rpc-failed' })
    expect(offline.calls).toHaveLength(1)
  })

  it('reserves a download wrapper with the file_download metadata shape', async () => {
    const { rpc, calls } = mockRpc()
    const result = await recordFileDownload(rpc, {
      fileName: 'app.ts',
      path: 'src/app.ts',
      sizeBytes: 4096,
      method: 'files.readChunk',
      kind: 'file',
      result: 'success',
      surface: 'web'
    })
    expect(result).toEqual({ reported: true })
    const body = calls[0].params ?? {}
    expect(body.eventType).toBe('file_download')
    expect(body.metadata).toMatchObject({
      fileName: 'app.ts',
      path: 'src/app.ts',
      method: 'files.readChunk',
      kind: 'file',
      surface: 'web',
      capturePoint: 'download-runtime-client',
      captureConfidence: 'client-declared'
    })
  })

  it('derives the surface and basename helpers', () => {
    expect(cloudFileAuditSurface('?embed=1&project=p1')).toBe('admin-embed')
    expect(cloudFileAuditSurface('?project=p1')).toBe('web')
    expect(cloudFileBaseName('src/config/app.ts')).toBe('app.ts')
  })
})

describe('cloud workspace file tab copy capture', () => {
  const ALL: CloudProjectPermission[] = ['open', 'terminal', 'file:read', 'file:write']

  function FakeEditor({ value }: CloudWorkspaceEditorProps): React.JSX.Element {
    return <textarea data-testid="fake-editor-input" readOnly value={value} />
  }

  function renderTab(rpc: CloudRpc) {
    render(
      <CloudWorkspaceFileTab
        tab={{ id: 'file:src/a.ts', kind: 'editor', title: 'a.ts', path: 'src/a.ts' }}
        active
        dispatch={() => undefined}
        rpc={rpc}
        workspacePath="/srv/wt"
        permissions={ALL}
        editor={FakeEditor}
      />
    )
  }

  function readRpc(): { rpc: CloudRpc; calls: Call[] } {
    return mockRpc((method) => {
      if (method === 'files.read') {
        return {
          ok: true,
          result: { content: 'const secret = "SECRET_MARKER"', truncated: false, byteLength: 31 }
        }
      }
      if (method === CLOUD_FILE_EVENT_METHOD) {
        return { ok: true, result: { queued: true } }
      }
      return { ok: false, code: 'method_denied' }
    })
  }

  it('reports the in-app copy button through the web clipboard capture point', async () => {
    const { rpc, calls } = readRpc()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    renderTab(rpc)

    const button = await screen.findByTestId('cloud-workspace-file-copy')
    await userEvent.click(button)

    await waitFor(() =>
      expect(calls.some((call) => call.method === CLOUD_FILE_EVENT_METHOD)).toBe(true)
    )
    const auditCall = calls.find((call) => call.method === CLOUD_FILE_EVENT_METHOD)
    const body = auditCall?.params ?? {}
    expect(writeText).toHaveBeenCalledWith('const secret = "SECRET_MARKER"')
    expect(body.eventType).toBe('file_copy')
    const metadata = metadataOf(auditCall)
    expect(metadata.copyKind).toBe('content-whole')
    expect(metadata.capturePoint).toBe('web-clipboard-api')
    expect(metadata.captureConfidence).toBe('client-declared')
    expect(metadata.path).toBe('src/a.ts')
    expect(metadata.fileName).toBe('a.ts')
    expect(JSON.stringify(body)).not.toContain('SECRET_MARKER')
  })

  it('captures a DOM copy selection as content-selection', async () => {
    const { rpc, calls } = readRpc()
    renderTab(rpc)
    await screen.findByTestId('cloud-workspace-file-copy')

    fireEvent.copy(screen.getByTestId('fake-editor-input'), {
      clipboardData: { getData: () => 'selected code' }
    })

    await waitFor(() =>
      expect(calls.some((call) => call.method === CLOUD_FILE_EVENT_METHOD)).toBe(true)
    )
    const metadata = metadataOf(calls.find((call) => call.method === CLOUD_FILE_EVENT_METHOD))
    expect(metadata.copyKind).toBe('content-selection')
    expect(metadata.capturePoint).toBe('dom-copy-listener')
    expect(metadata.copiedChars).toBe('selected code'.length)
  })
})
