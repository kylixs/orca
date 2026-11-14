import { describe, expect, it } from 'vitest'
import {
  readCloudWorkspaceInfo,
  type CloudWorkspacePermission
} from '../../shared/cloud-workspace-info'
import { validCloudSession } from '../runtime/device-registry-entry-validators'
import type { CloudPermission } from './cloud-credential'

/**
 * W13a audit MIN-3: the `workspace.info` reader lists the ticket permissions a
 * third time (contract union → host union → this reader's Set) and silently
 * drops anything unlisted, so a permission added on the platform would vanish
 * from the perms a web client sees, with no red anywhere. The contract↔host pair
 * is already pinned by cloud-platform/test/cloud-admission-parity.test.ts; this
 * pins the remaining edge — the registry validator that fills `cloudSession`
 * rows and the reader that forwards `perms` must accept exactly the same values.
 */

const CANDIDATE_PERMISSIONS = [
  'open',
  'terminal',
  'agent',
  'file:read',
  'file:write',
  'browser',
  'download',
  'platform-added-permission'
] as const

/** Both unions are the same set of string literals, in both directions. */
type SamePermissionUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('workspace.info 权限集合与云会话注册表校验器 parity', () => {
  it('读取器转发的 perms 恰为注册表准入 cloudSession 行的权利集合', () => {
    const session = validCloudSession({
      projectId: 'proj_payment',
      permissions: [...CANDIDATE_PERMISSIONS],
      projectRoot: '/srv/work/payment-service',
      workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan'
    })
    if (session === undefined) {
      throw new Error('validCloudSession rejected the fixture row')
    }
    const reply = readCloudWorkspaceInfo({
      project: {
        id: 'proj_payment',
        root: '/srv/work/payment-service',
        repoUrl: '',
        defaultBranch: 'main'
      },
      workspace: {
        root: '/srv/work/payment-service/.orca-worktrees/zhangsan',
        path: null,
        branch: null
      },
      perms: [...CANDIDATE_PERMISSIONS]
    })
    if (reply === null) {
      throw new Error('readCloudWorkspaceInfo rejected the fixture reply')
    }

    expect(reply.perms).toEqual(session.permissions)
    // Both sides must keep the whole documented set, not merely agree on a
    // smaller one after a shared omission.
    expect(reply.perms).toEqual(
      CANDIDATE_PERMISSIONS.filter((p) => p !== 'platform-added-permission')
    )
    const parityPin: SamePermissionUnion<CloudPermission, CloudWorkspacePermission> = true
    expect(parityPin).toBe(true)
  })
})
