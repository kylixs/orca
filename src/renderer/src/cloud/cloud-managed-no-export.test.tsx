// @vitest-environment happy-dom
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudProjectSummary, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CloudFilePanel } from './cloud-file-panel'
import { CloudProjectWorkspace } from './cloud-project-workspace'
import type { CloudSessionView } from './use-cloud-session'

/**
 * M92 (AC-10): the managed UI offers no download or export entry at all — not
 * hidden behind a permission, not present and then refused. Clicking every
 * control in the workspace and the file pane must never emit a download-family
 * RPC, and no interactive element may be labelled with one.
 *
 * The host's own refusal is proven separately (M35-1); this is the UI half.
 */

const EXPORT_METHODS = [
  'files.download',
  'files.downloadFolder',
  'terminal.exportArtifact',
  'browser.download',
  'browser.savePage'
]

const ENTRY_WORDS = /下载|导出|另存|download|export|save\s*as/i

function saveEvidence(file: string, content: unknown): void {
  const dir = join(process.cwd(), 'cloud-platform', 'evidence', 'm92-managed-no-export')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), JSON.stringify(content, null, 2))
}

type Call = { method: string; params?: Record<string, unknown> }

function recordingRpc(
  replies: Record<string, (params?: Record<string, unknown>) => CloudRpcOutcome>
) {
  const calls: Call[] = []
  const rpc = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<CloudRpcOutcome> => {
    calls.push({ method, params })
    const reply = replies[method]
    return reply ? reply(params) : { ok: false, code: 'method_not_found' }
  }
  return { rpc, calls }
}

const PROJECT: CloudProjectSummary = {
  id: 'proj_1',
  key: 'payment-service',
  name: 'Payment Service',
  hostName: 'dev-001',
  hostStatus: 'online',
  downloadRestricted: true,
  status: 'ready',
  provisioningError: null
}

function session(overrides: Partial<CloudSessionView> = {}): CloudSessionView {
  return {
    status: 'signed-in',
    displayName: '张三',
    loginContext: null,
    projects: [PROJECT],
    openProjectId: PROJECT.id,
    opened: {
      projectId: PROJECT.id,
      workspaceRoot: '/srv/checkout',
      workspacePath: '/srv/checkout',
      capabilities: ['pty', 'files'],
      permissions: ['open', 'terminal', 'file:read'],
      route: 'direct'
    },
    route: 'direct',
    notice: null,
    error: null,
    hostKeyMismatch: null,
    connectFailure: null,
    retryConnect: async () => null,
    dismissConnectFailure: () => undefined,
    confirmHostKey: async () => null,
    dismissHostKeyMismatch: () => undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    openProject: async () => null,
    closeProject: async () => undefined,
    ...overrides
  }
}

/** Every control the user can press, across both surfaces. */
function interactiveLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button, a[href], [role="button"], [role="menuitem"]')]
    .map((element) => (element.textContent ?? '').trim())
    .filter((label) => label !== '')
}

afterEach(cleanup)

describe('受管云端 UI 无下载/导出入口（AC-10）', () => {
  it('M92-1 工作区与文件面板没有任何下载/导出控件；完整走一遍文件浏览只发出读取类 RPC', async () => {
    const host = recordingRpc({
      'status.get': () => ({ ok: true, result: { runtimeId: 'rt-1' } }),
      'files.readDir': (params) =>
        params?.relativePath === 'docs'
          ? { ok: true, result: [{ name: 'logo.png', isDirectory: false, isSymlink: false }] }
          : {
              ok: true,
              result: [
                { name: 'docs', isDirectory: true, isSymlink: false },
                { name: 'README.md', isDirectory: false, isSymlink: false }
              ]
            },
      'files.readPreview': (params) =>
        params?.relativePath === 'docs/logo.png'
          ? {
              ok: true,
              result: {
                content: 'iVBORw0KGgo=',
                isBinary: true,
                isImage: true,
                mimeType: 'image/png'
              }
            }
          : { ok: true, result: { content: '# payment-service', isBinary: false } }
    })

    const { container } = render(
      <CloudProjectWorkspace session={session()} project={PROJECT} rpc={host.rpc} />
    )

    await screen.findByTestId('cloud-file-entry-README.md')

    // ---- no control is labelled like a download or export ----
    const labels = interactiveLabels(container)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.filter((label) => ENTRY_WORDS.test(label))).toEqual([])
    expect(screen.queryByRole('button', { name: ENTRY_WORDS })).toBeNull()
    expect(screen.queryByRole('link', { name: ENTRY_WORDS })).toBeNull()

    // ---- the real user flow: text preview, then a directory, then an image ----
    await userEvent.click(screen.getByTestId('cloud-file-entry-README.md'))
    await waitFor(() => expect(screen.getByTestId('cloud-file-content')).toBeTruthy())

    await userEvent.click(screen.getByTestId('cloud-file-entry-docs'))
    await userEvent.click(await screen.findByTestId('cloud-file-entry-logo.png'))
    await waitFor(() => expect(screen.getByText(/image\/png/)).toBeTruthy())

    // ---- and no export-family method was ever emitted ----
    const methods = host.calls.map((call) => call.method)
    expect(methods.filter((method) => EXPORT_METHODS.includes(method))).toEqual([])
    expect([...new Set(methods)].sort()).toEqual([
      'files.readDir',
      'files.readPreview',
      'status.get'
    ])

    // The image note may say downloads are unavailable, but must not send the
    // user to a download control that managed mode does not offer.
    const imageNote = screen.getByText(/image\/png/).textContent ?? ''
    expect(imageNote).toContain('不提供')
    expect(imageNote).not.toMatch(/请使用[^。]*下载|下载文件|另存/)

    saveEvidence('managed-no-export.json', {
      controls: labels,
      downloadLikeControls: [],
      rpcMethods: [...new Set(methods)].sort(),
      exportMethodsEmitted: [],
      imageNote
    })
  }, 30_000)

  it('M92-2 文件面板只调用 readDir/readPreview，二进制文件也没有导出入口', async () => {
    const host = recordingRpc({
      'files.readDir': () => ({
        ok: true,
        result: [
          { name: 'bin.dat', isDirectory: false, isSymlink: false },
          { name: 'src', isDirectory: true, isSymlink: false }
        ]
      }),
      'files.readPreview': () => ({
        ok: true,
        result: { content: 'AAECAwQ=', isBinary: true, mimeType: 'application/octet-stream' }
      })
    })
    const { container } = render(<CloudFilePanel rpc={host.rpc} workspacePath="/srv/checkout" />)

    await screen.findByTestId('cloud-file-entry-bin.dat')
    expect(interactiveLabels(container).filter((label) => ENTRY_WORDS.test(label))).toEqual([])

    await userEvent.click(screen.getByTestId('cloud-file-entry-bin.dat'))
    await waitFor(() => expect(screen.getByText(/application\/octet-stream/)).toBeTruthy())

    const methods = [...new Set(host.calls.map((call) => call.method))].sort()
    expect(methods).toEqual(['files.readDir', 'files.readPreview'])
    expect(methods.filter((method) => EXPORT_METHODS.includes(method))).toEqual([])
  }, 30_000)
})
