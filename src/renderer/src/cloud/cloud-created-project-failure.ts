import type {
  CloudCreateProjectResult,
  CloudProjectFailure
} from '../../../shared/cloud-platform-ipc'

/**
 * Maps a create reply that failed after the platform created the project to the
 * retry banner row; early failures (host, key, quota) return null and stay inline.
 */
export function createdProjectFailure(
  result: CloudCreateProjectResult
): CloudProjectFailure | null {
  if (result.ok || !result.projectId || !result.project) {
    return null
  }
  return {
    projectId: result.projectId,
    projectKey: result.project.key,
    projectName: result.project.name,
    code: result.code,
    ...(result.message !== undefined ? { message: result.message } : {})
  }
}
