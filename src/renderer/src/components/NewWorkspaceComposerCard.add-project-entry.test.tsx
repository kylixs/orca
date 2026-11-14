// @vitest-environment happy-dom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'

// Mutable per-test: each case stages the active workspace's owning runtime environment,
// and the card judges the add-project entry against exactly that environment.
const storeState: {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  runtimeEnvironments: PublicKnownRuntimeEnvironment[]
} = {
  activeWorktreeId: null,
  activeWorkspaceExecutionHostId: null,
  runtimeEnvironments: []
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: vi.fn(),
        openModal: vi.fn(),
        openSettingsPage: vi.fn(),
        openSettingsTarget: vi.fn(),
        setRuntimeEnvironmentStatus: vi.fn(),
        activeModal: 'new-workspace-composer',
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        updateSettings: vi.fn(),
        projects: [],
        repos: [],
        worktreesByRepo: {},
        activeWorktreeId: storeState.activeWorktreeId,
        activeWorkspaceExecutionHostId: storeState.activeWorkspaceExecutionHostId,
        runtimeEnvironments: storeState.runtimeEnvironments
      }),
    { getState: () => ({}) }
  )
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button type="button">Agent picker</button>
}))

vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({
  default: () => null
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

// Why: the entry has two surfaces — the toolbar button and the picker's pinned row —
// so the stub reports whether the picker still received the add-project action.
vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: ({ onAddProject }: { onAddProject?: () => void }) => (
    <div
      data-testid="project-combobox"
      data-add-project-entry={onAddProject ? 'shown' : 'hidden'}
    />
  )
}))

vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: () => null
}))

const cloudProject = {
  projectId: 'proj_1',
  projectKey: 'payment',
  hostId: 'host_1',
  registeredAt: 1
}

function environmentRow(
  id: string,
  extras: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 100,
    updatedAt: 100,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: 7,
    endpoints: [
      { id: `ws-${id}`, kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }
    ],
    preferredEndpointId: `ws-${id}`,
    ...extras
  }
}

/** The web row carries its spent-ticket marker outside the shared row type (web-runtime-environment). */
function cloudTicketRow(
  row: PublicKnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment & { cloudLoginRequired: true } {
  return { ...row, cloudLoginRequired: true }
}

function expectEntry(container: HTMLDivElement, present: boolean): void {
  const button = container.querySelector('[aria-label="Add project"]')
  if (present) {
    expect(button).toBeTruthy()
  } else {
    expect(button).toBeNull()
  }
  const combobox = container.querySelector('[data-testid="project-combobox"]')
  expect(combobox?.getAttribute('data-add-project-entry')).toBe(present ? 'shown' : 'hidden')
}

describe('NewWorkspaceComposerCard add-project entry', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      unmountCard(container)
      container = null
    }
    storeState.activeWorktreeId = null
    storeState.activeWorkspaceExecutionHostId = null
    storeState.runtimeEnvironments = []
  })

  it('hides both add-project surfaces when the active workspace is a cloud session', async () => {
    storeState.activeWorktreeId = 'repo-payment::/srv/payment'
    storeState.activeWorkspaceExecutionHostId = 'runtime:env-cloud'
    storeState.runtimeEnvironments = [
      environmentRow('env-cloud', { name: 'Payment', cloudProject })
    ]

    container = await renderCard()
    expectEntry(container, false)
  })

  it('keeps the entry for a native workspace beside a registered cloud environment', async () => {
    storeState.activeWorktreeId = 'repo-a::/repo-a'
    storeState.activeWorkspaceExecutionHostId = 'runtime:env-native'
    storeState.runtimeEnvironments = [
      environmentRow('env-cloud', { cloudProject }),
      environmentRow('env-native')
    ]

    container = await renderCard()
    expectEntry(container, true)
  })

  it('hides the entry for a web cloud row saved from a spent ticket', async () => {
    storeState.activeWorktreeId = 'repo-payment::/srv/payment'
    storeState.activeWorkspaceExecutionHostId = 'runtime:env-web'
    storeState.runtimeEnvironments = [
      cloudTicketRow(environmentRow('env-web', { name: 'Orca Web' }))
    ]

    container = await renderCard()
    expectEntry(container, false)
  })

  it('keeps the entry when no workspace is active yet', async () => {
    storeState.runtimeEnvironments = [environmentRow('env-cloud', { cloudProject })]

    container = await renderCard()
    expectEntry(container, true)
  })
})
