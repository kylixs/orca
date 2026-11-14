// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeList from '../../WorktreeList'

const cloudScope = vi.hoisted(() => ({ active: false }))
vi.mock('@/web/web-cloud-session-scope', () => ({
  isActiveWebClientCloudSession: () => cloudScope.active,
  resetWebCloudSessionScope: () => {
    cloudScope.active = false
  }
}))

function stubWindowApi(): void {
  const namespaces = new Map<string, object>()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(
      {},
      {
        get: (_target, namespace) => {
          const key = String(namespace)
          let stub = namespaces.get(key)
          if (!stub) {
            stub = new Proxy(
              {},
              {
                get: (_t, method) => {
                  if (typeof method === 'string' && method.startsWith('on')) {
                    return () => () => undefined
                  }
                  return () => Promise.resolve()
                }
              }
            )
            namespaces.set(key, stub)
          }
          return stub
        }
      }
    )
  })
}

function renderWorktreeList(): void {
  render(
    <TooltipProvider delayDuration={400}>
      <ConfirmationDialogProvider>
        <WorktreeList scrollOffsetRef={{ current: 0 }} scrollAnchorRef={{ current: null }} />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  stubWindowApi()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  cloudScope.active = false
})

describe('WorktreeList empty state under a cloud session', () => {
  it('shows the cloud-scope notice instead of the native empty list', () => {
    cloudScope.active = true
    renderWorktreeList()
    expect(screen.getByText('Cloud project session')).toBeTruthy()
    expect(screen.queryByText('No workspaces found')).toBeNull()
  })

  it('keeps the native empty list when the client is not a cloud session', () => {
    cloudScope.active = false
    renderWorktreeList()
    expect(screen.getByText('No workspaces found')).toBeTruthy()
    expect(screen.queryByText('Cloud project session')).toBeNull()
  })
})
