// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type {
  CloudProjectPermission,
  CloudProjectSummary,
  CloudRpcOutcome
} from '../../../shared/cloud-platform-ipc'
import { CloudProjectWorkspace } from './cloud-project-workspace'
import type { CloudSessionView } from './use-cloud-session'

/**
 * The lazy terminal chunk's third failure mode (W5a MIN-3): a redeploy 404s the
 * chunk the browser still holds, and the workspace must degrade only the
 * terminal slot — with a retry — instead of unmounting into a white page.
 * Own file because the failure has to hit this suite's first import of the
 * module; the shared workspace suite imports it successfully up front.
 */

const panelModule = vi.hoisted(() => ({ failuresLeft: 1 }))

vi.mock('./cloud-terminal-panel', () => {
  if (panelModule.failuresLeft > 0) {
    panelModule.failuresLeft -= 1
    throw new Error('Failed to fetch dynamically imported module: cloud-terminal-panel chunk')
  }
  return {
    CloudTerminalPanel: () =>
      React.createElement('div', { 'data-testid': 'cloud-terminal-panel-lazy' })
  }
})

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

function session(permissions: CloudProjectPermission[]): CloudSessionView {
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
      permissions,
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
    closeProject: async () => undefined
  }
}

function recordingRpc(replies: Record<string, CloudRpcOutcome>) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const rpc = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<CloudRpcOutcome> => {
    calls.push({ method, params })
    return replies[method] ?? { ok: false, code: 'method_not_found' }
  }
  return { rpc, calls }
}

const streamSeam = () => vi.fn(async () => ({ ok: false as const, code: 'NOT_USED_HERE' }))

afterEach(() => {
  cleanup()
  panelModule.failuresLeft = 0
})

describe('工作区终端 chunk 加载失败（W5a MIN-3）', () => {
  it('chunk 404 只降级终端区并可重试，页面其余部分不白屏', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const host = recordingRpc({
      'status.get': { ok: true, result: { runtimeId: 'rt-1' } },
      'files.readDir': {
        ok: true,
        result: [{ name: 'README.md', isDirectory: false, isSymlink: false }]
      }
    })

    try {
      render(
        <CloudProjectWorkspace
          session={session(['open', 'terminal', 'file:read'])}
          project={PROJECT}
          rpc={host.rpc}
          subscribe={streamSeam()}
        />
      )

      expect(await screen.findByTestId('cloud-terminal-chunk-failed')).toBeTruthy()
      // The page survives: the file pane and the workspace chrome are still there.
      expect(screen.getByTestId('cloud-file-entry-README.md')).toBeTruthy()
      expect(screen.getByTestId('cloud-workspace-path')).toBeTruthy()

      // A stale chunk 404 clears once the page refetches, so the retry re-runs the import.
      fireEvent.click(screen.getByTestId('cloud-terminal-chunk-retry'))
      expect(await screen.findByTestId('cloud-terminal-panel-lazy')).toBeTruthy()
      expect(screen.queryByTestId('cloud-terminal-chunk-failed')).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })
})
