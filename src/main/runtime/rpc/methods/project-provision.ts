import { defineMethod } from '../core'
import type { CloudProjectProvisionResult } from '../../../cloud-platform/cloud-project-provision'

/**
 * Cloud project provisioning (M57).
 *
 * Kept out of ALL_RPC_METHODS: only a cloud-admitted host has a ticket that can
 * name a project root, and the handler refuses every other caller. The outcome
 * is queued for the next heartbeat; the client only learns it synchronously.
 */
export const PROJECT_PROVISION_METHODS = [
  defineMethod({
    name: 'project.provision',
    permission: 'workspace',
    params: null,
    handler: async (_params, context): Promise<CloudProjectProvisionResult> => {
      const cloud = context.cloud
      if (!cloud) {
        return {
          ok: false,
          code: 'CLOUD_SESSION_REQUIRED',
          message: 'This method is only available to a cloud session.'
        }
      }
      let result: CloudProjectProvisionResult
      try {
        result = await context.runtime.provisionCloudProject({
          projectRoot: cloud.projectRoot,
          repoUrl: cloud.repoUrl,
          defaultBranch: cloud.defaultBranch
        })
      } catch (error) {
        // Why no message detail: this report reaches the platform audit log, and
        // spawned-git errors can echo the repo URL (which may embed credentials).
        console.warn('[cloud] project provisioning failed unexpectedly:', error)
        result = {
          ok: false,
          code: 'PROVISION_FAILED',
          message: '项目准备失败，请查看主机日志。'
        }
      }
      context.cloudReportProvision?.({
        projectId: cloud.projectId,
        ok: result.ok,
        // Why only our own generic message: it must not echo a repo URL that may
        // embed credentials, and the platform truncates it at 500 chars anyway.
        ...(result.ok ? {} : { error: `${result.code}: ${result.message}` })
      })
      return result
    }
  })
] as const
