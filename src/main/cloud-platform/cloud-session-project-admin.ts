import type { CloudCreateProjectInput, CloudProjectSummary } from '../../shared/cloud-platform-ipc'
import { errorCodeOf } from '../../shared/json-fields'
import type { CloudConnectClient } from './cloud-connect-client'
import { summarizeCloudProject } from './cloud-project-summary'

/**
 * Self-service project changes that outlive a single request: creation refreshes
 * the visible list, archiving also retires that project's live socket.
 */

export type ProjectAdminHooks = {
  /** Signs the UI out and returns the code when the platform says the session died. */
  expiredCode: (error: unknown) => string | null
  /** Rewrites the visible project list (only while signed in). */
  publishProjects: (projects: CloudProjectSummary[]) => void
  closeProjectSocket: (projectId: string) => void
}

export type CreateProjectOutcome =
  | { ok: true; projectId: string; project: CloudProjectSummary }
  | { ok: false; code: string; message?: string }

export async function createSessionProject(
  client: CloudConnectClient,
  hooks: ProjectAdminHooks,
  input: CloudCreateProjectInput
): Promise<CreateProjectOutcome> {
  try {
    const created = await client.createProject(input)
    try {
      hooks.publishProjects((await client.listProjects()).map(summarizeCloudProject))
    } catch (error) {
      // The project exists; a stale list must not turn creation into a failure.
      hooks.expiredCode(error)
    }
    return { ok: true, projectId: created.id, project: summarizeCloudProject(created) }
  } catch (error) {
    return {
      ok: false,
      code: hooks.expiredCode(error) ?? errorCodeOf(error) ?? 'CREATE_PROJECT_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function archiveSessionProject(
  client: CloudConnectClient,
  hooks: ProjectAdminHooks,
  projectId: string
): Promise<{ ok: true } | { ok: false; code: string; message?: string }> {
  try {
    await client.archiveProject(projectId)
  } catch (error) {
    return {
      ok: false,
      code: hooks.expiredCode(error) ?? errorCodeOf(error) ?? 'ARCHIVE_PROJECT_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }
  }
  hooks.closeProjectSocket(projectId)
  try {
    hooks.publishProjects((await client.listProjects()).map(summarizeCloudProject))
  } catch (error) {
    // The archive already happened; a stale list must not turn it into a failure.
    hooks.expiredCode(error)
  }
  return { ok: true }
}
