import type {
  CloudProjectEnvironment,
  CloudProjectFailure,
  CloudProjectRegistration,
  CloudProjectSummary
} from '../../shared/cloud-platform-ipc'
import { boundedParallelMap } from '../../shared/bounded-parallel-map'
import type { CloudProjectLink } from './cloud-pairing-offer'
import {
  registerCloudRuntimeEnvironment,
  removeStaleCloudRuntimeEnvironments
} from './cloud-runtime-environment'
import type { CloudSessionService } from './cloud-session-service'

// Clone/probe work may overlap; the environment sidecar registration may not.

/** The platform's U20 gate answer while the host's kick clone is still running. */
const PROJECT_PROVISIONING = 'PROJECT_PROVISIONING'

export type PreparedEnvironment =
  | { ok: true; environment: CloudProjectEnvironment }
  /** Not a failure: the platform created the project and the host is still preparing it. */
  | { ok: true; preparing: true }
  | { ok: false; code: string; message?: string }

export type PreparedCloudProjectLink =
  | { ok: true; project: CloudProjectSummary; link: CloudProjectLink }
  | { ok: true; preparing: true }
  | { ok: false; code: string; message?: string }

export const DEFAULT_PREPARE_CONCURRENCY = 3

/** Provision + ticket only: no runtime environment is written here. */
export async function prepareCloudProjectLink(
  session: CloudSessionService,
  project: CloudProjectSummary
): Promise<PreparedCloudProjectLink> {
  // Why before the link: a project the host has never cloned cannot answer
  // `worktree.*`, and preparing it here is what makes the sidebar row real.
  const provisioned = await session.ensureProjectPrepared(project.id)
  if (!provisioned.ok) {
    // Why not a failure: U37's kick clone finishes in seconds, and retrying now
    // would only race the same gate; the caller shows "preparing" instead.
    if (provisioned.code === PROJECT_PROVISIONING) {
      return { ok: true, preparing: true }
    }
    return { ok: false, code: provisioned.code, message: provisioned.message }
  }
  // Why a prepared link, not openWorkspace: listing a project in the sidebar
  // must not create a checkout or consume the one live connection.
  let prepared = await session.prepareProjectLink(project.id)
  if (!prepared.ok) {
    // Why retry once: route selection is a raw TCP probe, which can lose one
    // race at sign-in while the host is otherwise reachable.
    prepared = await session.prepareProjectLink(project.id)
  }
  if (!prepared.ok) {
    if (prepared.code === PROJECT_PROVISIONING) {
      return { ok: true, preparing: true }
    }
    return { ok: false, code: prepared.code, message: prepared.message }
  }
  return { ok: true, project, link: prepared.link }
}

export function registerPreparedEnvironment(
  userDataPath: string,
  project: CloudProjectSummary,
  link: CloudProjectLink
): CloudProjectEnvironment {
  const environment = registerCloudRuntimeEnvironment(userDataPath, {
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    hostId: project.hostName ?? '',
    link
  })
  return {
    projectId: project.id,
    projectName: project.name,
    projectRoot: link.projectRoot,
    environmentId: environment.id
  }
}

/** provision → link → register, the exact sequence both entry and retry need. */
export async function prepareProjectEnvironment(
  session: CloudSessionService,
  userDataPath: string,
  project: CloudProjectSummary
): Promise<PreparedEnvironment> {
  const prepared = await prepareCloudProjectLink(session, project)
  if (!prepared.ok) {
    return prepared
  }
  if ('preparing' in prepared) {
    return prepared
  }
  return {
    ok: true,
    environment: registerPreparedEnvironment(userDataPath, project, prepared.link)
  }
}

/**
 * Prepares every project with bounded overlap, then registers in input order.
 * Registration stays serial because the sidecar is a read-modify-write file.
 */
export async function registerProjectEnvironments(
  session: CloudSessionService,
  userDataPath: string,
  projects: readonly CloudProjectSummary[],
  concurrency: number = DEFAULT_PREPARE_CONCURRENCY
): Promise<CloudProjectRegistration> {
  const prepared = await boundedParallelMap(projects, concurrency, (project) =>
    prepareCloudProjectLink(session, project)
  )
  const environments: CloudProjectEnvironment[] = []
  const failures: CloudProjectFailure[] = []
  for (const [index, result] of prepared.entries()) {
    const project = projects[index]
    if (result.status === 'rejected') {
      // Unexpected throws keep their pre-M64 behaviour: fail the whole call.
      throw result.reason
    }
    const candidate = result.value
    if (!candidate.ok) {
      console.warn(`[cloud] could not prepare ${project.key}: ${candidate.code}`)
      // Why surface it: silently dropping the project hides both the cause and
      // the retry the user needs once an admin fixes the repo URL.
      failures.push({
        projectId: project.id,
        projectKey: project.key,
        projectName: project.name,
        code: candidate.code,
        ...(candidate.message !== undefined ? { message: candidate.message } : {})
      })
      continue
    }
    // Why skip silently: provisioning is not a failure; the project row already
    // shows its status, and its sidebar row lands on the next registration.
    if ('preparing' in candidate) {
      continue
    }
    environments.push(registerPreparedEnvironment(userDataPath, project, candidate.link))
  }
  // Why: an archived project leaves the visible list, so its sidebar host must go too.
  const removedEnvironmentIds = removeStaleCloudRuntimeEnvironments(
    userDataPath,
    new Set(projects.map((project) => project.id))
  )
  return { environments, failures, removedEnvironmentIds }
}
