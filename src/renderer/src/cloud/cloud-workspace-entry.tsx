import * as React from 'react'
import { toast } from 'sonner'
import { errorCodeOf } from '../../../shared/json-fields'
import type {
  CloudArchiveProjectResult,
  CloudCreateProjectResult,
  CloudProjectEnvironment,
  CloudProjectFailure
} from '../../../shared/cloud-platform-ipc'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { CloudLoginEntryProvider } from './cloud-login-entry'
import {
  CloudProjectFailureBanner,
  NewCloudProjectButton,
  PreparingCloudProjectBanner
} from './cloud-workspace-banners'
import {
  openCreatedCloudProject,
  rendererRepoPorts,
  selectInitialWorktree
} from './cloud-entry-workspace-sync'
import { createdProjectFailure } from './cloud-created-project-failure'
import { signOutCloudProjectRepos, syncCloudProjectRepos } from './cloud-project-repos'
import { useCloudSession, type CloudBridge, type CloudSessionView } from './use-cloud-session'

/**
 * Native cloud entry: the ordinary workspace shell always renders, and the
 * cloud platform joins it as an additive channel — a persistent sign-in chip
 * (W11) whose projects land in the sidebar as extra repos next to the native
 * ones. The custom cloud pages are only for the admin browser surface (M54).
 */

function useCloudBridge(): CloudBridge | null {
  return React.useMemo(() => window.api?.cloud ?? null, [])
}

function entryFailureCode(error: unknown): string {
  return errorCodeOf(error) ?? (error instanceof Error ? error.message : String(error))
}

export type CloudWorkspaceEntryState = {
  /** First failure while entering the workspace, as the platform's error code. */
  entryError: string | null
  /** True while the host clones/verifies the project and the checkout is created. */
  preparing: boolean
  /** Projects that did not register; the user can retry after an admin fix. */
  failures: CloudProjectFailure[]
  retrying: boolean
  retryFailures: () => Promise<void>
  registerCreatedProject: (result: CloudCreateProjectResult) => Promise<void>
  archiveProject: (projectId: string) => Promise<CloudArchiveProjectResult>
  signOut: () => Promise<void>
}

export function useCloudWorkspaceEntry(
  bridge: CloudBridge,
  session: CloudSessionView
): CloudWorkspaceEntryState {
  const enteredFor = React.useRef<string | null>(null)
  const environments = React.useRef<readonly CloudProjectEnvironment[]>([])
  const [entryError, setEntryError] = React.useState<string | null>(null)
  const [preparing, setPreparing] = React.useState(false)
  const [failures, setFailures] = React.useState<CloudProjectFailure[]>([])
  const [retrying, setRetrying] = React.useState(false)
  const projects = session.projects
  const sessionKey =
    session.status === 'signed-in' ? projects.map((project) => project.id).join('\u0000') : null

  React.useEffect(() => {
    if (sessionKey === null) {
      // Why: a later sign-in is a new entry, even when the platform returns the same projects.
      enteredFor.current = null
      environments.current = []
      setEntryError(null)
      setPreparing(false)
      setFailures([])
      return
    }
    if (enteredFor.current === sessionKey) {
      return
    }
    enteredFor.current = sessionKey
    setPreparing(true)
    setFailures([])
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
        const preparedEnvironments = registered.environments
        environments.current = preparedEnvironments
        setFailures(registered.failures)
        if (registered.removedEnvironmentIds.length > 0) {
          useAppStore.getState().purgeStaleRuntimeHostState(registered.removedEnvironmentIds)
        }
        // Why fire-and-forget: the sidebar needs the host rows, but a slow status
        // probe must not hold the shell hostage.
        void useAppStore.getState().hydrateRuntimeEnvironmentStatuses()
        const result = await syncCloudProjectRepos({
          environments: preparedEnvironments,
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
          environments: preparedEnvironments,
          projectId: first.id,
          isCancelled: () => cancelled
        })
      } catch (error) {
        if (!cancelled) {
          fail(entryFailureCode(error))
        }
      } finally {
        if (!cancelled) {
          setPreparing(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [bridge, sessionKey, projects])

  const retryFailures = React.useCallback(async () => {
    if (retrying) {
      return
    }
    setRetrying(true)
    const recovered: CloudProjectEnvironment[] = []
    const remaining: CloudProjectFailure[] = []
    try {
      for (const failure of failures) {
        try {
          const result = await bridge.retryPrepare(failure.projectId)
          if (!result.ok) {
            remaining.push({
              ...failure,
              code: result.code,
              ...(result.message !== undefined ? { message: result.message } : {})
            })
            continue
          }
          recovered.push(result.environment)
        } catch (error) {
          remaining.push({ ...failure, code: entryFailureCode(error) })
        }
      }
      if (recovered.length > 0) {
        environments.current = [...environments.current, ...recovered]
        for (const environment of recovered) {
          try {
            await syncCloudProjectRepos({
              environments: [environment],
              repos: useAppStore.getState().repos,
              ports: rendererRepoPorts(bridge)
            })
          } catch (error) {
            console.warn('[cloud] could not register recovered repo', entryFailureCode(error))
          }
        }
        void useAppStore.getState().hydrateRuntimeEnvironmentStatuses()
      }
    } finally {
      setFailures(remaining)
      setRetrying(false)
    }
  }, [bridge, failures, retrying])

  const registerCreatedProject = React.useCallback(
    async (result: CloudCreateProjectResult) => {
      if (!result.ok) {
        // Why: the platform already has the project; a dialog stuck on the error
        // would leave no way to retry after an admin fixes the repo URL.
        const failure = createdProjectFailure(result)
        if (!failure) {
          return
        }
        setFailures((current) => [
          ...current.filter((entry) => entry.projectId !== failure.projectId),
          failure
        ])
        toast.error(
          translate(
            'auto.cloud.projectCreatedUnprepared',
            '项目已创建，但准备失败，可在提示条重试'
          ),
          { description: `${failure.projectName}（${failure.code}）` }
        )
        return
      }
      environments.current = [...environments.current, result.environment]
      await openCreatedCloudProject({
        bridge,
        environment: result.environment,
        projectId: result.projectId
      })
    },
    [bridge]
  )

  const archiveProject = React.useCallback(
    async (projectId: string): Promise<CloudArchiveProjectResult> => {
      try {
        const result = await bridge.archiveProject(projectId)
        if (!result.ok) {
          return result
        }
        if (result.environmentId) {
          useAppStore.getState().purgeStaleRuntimeHostState([result.environmentId])
        }
        environments.current = environments.current.filter((entry) => entry.projectId !== projectId)
        return result
      } catch (error) {
        return { ok: false, code: entryFailureCode(error) }
      }
    },
    [bridge]
  )

  // Why lifted: the repo-sync chain reuses the session's own sign-out, so the
  // whole flow is one logout round instead of two.
  const endSession = session.signOut
  const signOut = React.useCallback(async () => {
    const registered = environments.current
    await signOutCloudProjectRepos({
      environments: registered,
      repos: useAppStore.getState().repos,
      ports: {
        signOut: async () => {
          await endSession()
          await useAppStore.getState().hydrateRuntimeEnvironmentStatuses()
        },
        purgeRepos: (environmentIds) =>
          useAppStore.getState().purgeStaleRuntimeHostState(environmentIds)
      }
    })
    environments.current = []
    setFailures([])
  }, [endSession])

  return {
    entryError,
    preparing,
    failures,
    retrying,
    retryFailures,
    registerCreatedProject,
    archiveProject,
    signOut
  }
}

function CloudWorkspaceSession({
  bridge,
  children
}: {
  bridge: CloudBridge
  children: React.ReactNode
}): React.JSX.Element {
  const session = useCloudSession(bridge)
  const entry = useCloudWorkspaceEntry(bridge, session)
  const signedIn = session.status === 'signed-in'
  const [signingOut, setSigningOut] = React.useState(false)

  // Why one round: entry.signOut ends the session itself (main retires the
  // environments, the view flips), then drops the account's rows. A failure is
  // announced, never swallowed — the chip stays truthful about the session.
  const requestSignOut = React.useCallback(() => {
    if (signingOut) {
      return
    }
    setSigningOut(true)
    void (async () => {
      try {
        await entry.signOut()
      } catch (error) {
        toast.error(translate('auto.cloud.signOutFailed', '登出失败，请重试。'), {
          description: entryFailureCode(error)
        })
      } finally {
        setSigningOut(false)
      }
    })()
  }, [entry, signingOut])

  // Why the shell always renders (W11): startup lands in the native interface in
  // every build; the cloud platform is the additive channel behind the segment.
  return (
    <CloudLoginEntryProvider
      session={session}
      requestSignOut={requestSignOut}
      leading={
        signedIn ? (
          <NewCloudProjectButton bridge={bridge} onCreated={entry.registerCreatedProject} />
        ) : null
      }
    >
      {signedIn && entry.preparing ? <PreparingCloudProjectBanner /> : null}
      {signedIn ? (
        <CloudProjectFailureBanner
          failures={entry.failures}
          retrying={entry.retrying}
          onRetry={() => void entry.retryFailures()}
        />
      ) : null}
      {children}
    </CloudLoginEntryProvider>
  )
}

export function CloudWorkspaceEntry({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const bridge = useCloudBridge()
  // No bridge means no main-process cloud surface (e.g. the browser admin page):
  // nothing here may affect that shell.
  if (!bridge) {
    return <>{children}</>
  }
  return <CloudWorkspaceSession bridge={bridge}>{children}</CloudWorkspaceSession>
}
