import type { PreloadApi } from '../../../../preload/api-types'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import { isActiveWebClientCloudSession } from '../web-cloud-session-scope'
import { createFallbackProxy } from './web-fallback-api'
import { callRuntimeResult } from './web-runtime-calls'

export function createRuntimeNamespaceApi(prefix: string): never {
  return createFallbackProxy([prefix], (path, args) => {
    const method = `${prefix}.${path.at(-1) ?? ''}`
    // Why: a cloud session's host refuses linear.* — the credentials are host
    // account assets the ticket never carries (O1 F5). The status read is a
    // boot-time poll, so answer "not connected" instead of logging a denial;
    // user-initiated mutations still surface their real refusal.
    if (method === 'linear.status' && isActiveWebClientCloudSession()) {
      return Promise.resolve({ connected: false, viewer: null }) as never
    }
    return callRuntimeResult(method, mapRuntimeNamespaceArg(prefix, args[0]))
  }) as never
}

export function createHooksApi(): NonNullable<Partial<PreloadApi>['hooks']> {
  return {
    check: async ({ repoId }) => {
      // Why: a cloud session's host refuses repo.hooksCheck — hook inspection is a
      // desktop maintenance surface, so report "no hooks" instead of a denial.
      if (isActiveWebClientCloudSession()) {
        return { hasHooks: false, hooks: null as OrcaHooks | null, mayNeedUpdate: false }
      }
      return callRuntimeResult('repo.hooksCheck', { repo: repoId })
    },
    inspectSetupScriptImports: async ({ repoId }) =>
      callRuntimeResult('repo.setupScriptImports', { repo: repoId }),
    createIssueCommandRunner: async () => ({ launched: false }) as never,
    readIssueCommand: async ({ repoId }) =>
      callRuntimeResult('repo.issueCommandRead', { repo: repoId }),
    writeIssueCommand: async ({ repoId, content }) => {
      await callRuntimeResult('repo.issueCommandWrite', { repo: repoId, content })
    }
  }
}

export function mapRepoPathArg(args: unknown): unknown {
  if (!args || typeof args !== 'object' || !('repoPath' in args)) {
    return args
  }
  const record = args as Record<string, unknown>
  const repoId = typeof record.repoId === 'string' && record.repoId.trim() ? record.repoId : null
  return {
    ...record,
    // Why: duplicate checked-out repos make path/name selectors ambiguous; prefer the explicit repo id the renderer passes.
    repo: repoId ? `id:${repoId}` : record.repoPath
  }
}

export function mapRuntimeNamespaceArg(prefix: string, args: unknown): unknown {
  if (prefix !== 'hostedReview') {
    return args
  }
  return mapRepoPathArg(args)
}
