import * as React from 'react'
import { toast } from 'sonner'
import { errorCodeOf } from '../../../shared/json-fields'
import type { CloudOpenResult, CloudProjectEnvironment } from '../../../shared/cloud-platform-ipc'
import { selectCloudInitialWorktreeId } from '../../../shared/cloud-initial-worktree'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { translate } from '@/i18n/i18n'
import { CloudLoginPanel } from './cloud-login-panel'
import {
  cloudProjectRepoTarget,
  signOutCloudProjectRepos,
  syncCloudProjectRepos,
  type CloudProjectRepoPorts
} from './cloud-project-repos'
import { useCloudSession, type CloudBridge, type CloudSessionView } from './use-cloud-session'

/**
 * Native cloud entry: a cloud build signs in here and then lands in the ordinary
 * workspace shell, with every signed-in project registered as a sidebar repo.
 * The custom cloud pages are only for the admin browser surface (M54).
 */

function useCloudBridge(): CloudBridge | null {
  return React.useMemo(() => window.api?.cloud ?? null, [])
}

function rendererRepoPorts(bridge: CloudBridge): CloudProjectRepoPorts {
  const state = () => useAppStore.getState()
  return {
    // The canonical runtime-repo add: main routes `repo.add` to the environment's host.
    addRepo: (target) =>
      state().addRepoPath(target.path, 'git', {
        runtimeEnvironmentId: target.environmentId,
        displayName: target.displayName
      }),
    // Why renderer-only: `repo.update` is not open to cloud sessions, and the
    // platform name is what the sidebar should show.
    renameRepo: ({ repo, displayName }) => {
      const identity = getRepoHostIdentity(repo)
      useAppStore.setState((s) => ({
        repos: s.repos.map((entry) =>
          getRepoHostIdentity(entry) === identity ? { ...entry, displayName } : entry
        )
      }))
    },
    purgeRepos: (environmentIds) => state().purgeStaleRuntimeHostState(environmentIds),
    signOut: async () => {
      await bridge.logout()
      // Why: main retired every cloud environment; this re-read also publishes
      // the removal so host pickers stop offering them.
      await state().hydrateRuntimeEnvironmentStatuses()
    }
  }
}

function entryFailureCode(error: unknown): string {
  return errorCodeOf(error) ?? (error instanceof Error ? error.message : String(error))
}

/**
 * Lands a signed-in user on their own checkout: the host opened (or created) a
 * worktree, and the sidebar knows that worktree by `<repoId>::<path>`.
 */
async function selectInitialWorktree(args: {
  opened: CloudOpenResult
  environments: readonly CloudProjectEnvironment[]
  projectId: string
  isCancelled: () => boolean
}): Promise<void> {
  const workspacePath = args.opened.ok ? args.opened.workspacePath : undefined
  if (!workspacePath) {
    // Why: older sidecars may not record a checkout; leave the default view alone.
    return
  }
  const environment = args.environments.find((entry) => entry.projectId === args.projectId)
  if (!environment) {
    return
  }
  const target = cloudProjectRepoTarget(environment)
  const state = () => useAppStore.getState()
  const repo = state().repos.find(
    (row) => getRepoExecutionHostId(row) === target.executionHostId && row.path === target.path
  )
  if (!repo) {
    return
  }
  const select = (): string | null =>
    selectCloudInitialWorktreeId({
      workspacePath,
      repo,
      worktrees: state().worktreesByRepo[repo.id] ?? []
    })
  let worktreeId = select()
  if (worktreeId === null) {
    // Why: the repo row was just added, so its sidebar worktrees are not loaded yet.
    await state().fetchWorktrees(repo.id)
    if (args.isCancelled()) {
      return
    }
    worktreeId = select()
  }
  if (worktreeId !== null) {
    state().setActiveWorktree(worktreeId, target.executionHostId)
  }
}

export type CloudWorkspaceEntryState = {
  /** First failure while entering the workspace, as the platform's error code. */
  entryError: string | null
  signOut: () => Promise<void>
}

function useCloudWorkspaceEntry(
  bridge: CloudBridge,
  session: CloudSessionView
): CloudWorkspaceEntryState {
  const enteredFor = React.useRef<string | null>(null)
  const environments = React.useRef<readonly CloudProjectEnvironment[]>([])
  const [entryError, setEntryError] = React.useState<string | null>(null)
  const projects = session.projects
  const sessionKey =
    session.status === 'signed-in' ? projects.map((project) => project.id).join('\u0000') : null

  React.useEffect(() => {
    if (sessionKey === null) {
      // Why: a later sign-in is a new entry, even when the platform returns the same projects.
      enteredFor.current = null
      environments.current = []
      setEntryError(null)
      return
    }
    if (enteredFor.current === sessionKey) {
      return
    }
    enteredFor.current = sessionKey
    let cancelled = false

    const fail = (code: string): void => {
      setEntryError(code)
      toast.error(translate('auto.cloud.enterFailed', 'Could not open the cloud project'), {
        description: code
      })
    }

    void (async () => {
      try {
        const registered = await bridge.registerProjects()
        if (cancelled) {
          return
        }
        environments.current = registered
        // Why fire-and-forget: the sidebar needs the host rows, but a slow status
        // probe must not hold the shell hostage.
        void useAppStore.getState().hydrateRuntimeEnvironmentStatuses()
        const result = await syncCloudProjectRepos({
          environments: registered,
          repos: useAppStore.getState().repos,
          ports: rendererRepoPorts(bridge)
        })
        if (cancelled) {
          return
        }
        for (const failed of result.failed) {
          console.warn('[cloud] could not register repo', failed.projectId)
        }
        const first = projects[0]
        if (!first) {
          return
        }
        const opened = await bridge.openWorkspace(first.id)
        if (cancelled) {
          return
        }
        if (!opened.ok) {
          fail(opened.code)
          return
        }
        await selectInitialWorktree({
          opened,
          environments: registered,
          projectId: first.id,
          isCancelled: () => cancelled
        })
      } catch (error) {
        if (!cancelled) {
          fail(entryFailureCode(error))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [bridge, sessionKey, projects])

  const signOut = React.useCallback(async () => {
    const registered = environments.current
    await signOutCloudProjectRepos({
      environments: registered,
      repos: useAppStore.getState().repos,
      ports: {
        signOut: () => rendererRepoPorts(bridge).signOut(),
        purgeRepos: (environmentIds) =>
          useAppStore.getState().purgeStaleRuntimeHostState(environmentIds)
      }
    })
    environments.current = []
  }, [bridge])

  return { entryError, signOut }
}

function CloudWorkspaceSession({
  bridge,
  children
}: {
  bridge: CloudBridge
  children: React.ReactNode
}): React.JSX.Element {
  const session = useCloudSession(bridge)
  useCloudWorkspaceEntry(bridge, session)

  if (session.status === 'signed-in') {
    return <>{children}</>
  }
  if (session.status === 'loading') {
    // Why: the cloud build must not flash the local shell before the session is known.
    return <div className="flex h-full w-full items-center justify-center bg-background" />
  }
  return (
    <CloudLoginPanel
      submitting={session.status === 'signing-in'}
      error={session.error}
      onSignIn={(username, password) => void session.signIn(username, password)}
    />
  )
}

export function CloudWorkspaceEntry({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const bridge = useCloudBridge()
  // Ordinary desktop builds have no cloud bridge: nothing here may affect them.
  if (!bridge) {
    return <>{children}</>
  }
  return <CloudWorkspaceSession bridge={bridge}>{children}</CloudWorkspaceSession>
}
