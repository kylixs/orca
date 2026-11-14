import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_MULTIPLEX_WORKSPACE_SCOPE_ERROR,
  createCloudMultiplexStreamBoundary
} from './cloud-terminal-multiplex-boundary'

/**
 * W9A-7: the multiplex transport is open to cloud sessions, so its subscribe
 * frames carry the boundary the unary terminal methods already have. These pin
 * the verdicts at the function the transport calls per subscribe.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-multiplex-boundary-')))
const projectRoot = join(base, 'payment-service')
const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
const teammateRoot = join(base, 'other-team')
mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(teammateRoot, { recursive: true })

const roots = { projectRoot, workspaceRoot }

/** Handle → worktree. A handle the map does not know is a terminal that exited. */
const terminalWorktrees: Record<string, string> = {
  'term-own': workspaceRoot,
  'term-teammate': teammateRoot
}

function boundaryWith(overrides: {
  resolveTerminalContext?: (
    handle: string
  ) => { worktreeId: string; connectionId: string | null } | null
  onCloudDenial?: (details: unknown, method: string) => void
}) {
  const denials: { details: unknown; method: string }[] = []
  const boundary = createCloudMultiplexStreamBoundary({
    runtime: {
      resolveTerminalContext:
        overrides.resolveTerminalContext ??
        ((handle) => {
          const worktreeId = terminalWorktrees[handle]
          return worktreeId === undefined ? null : { worktreeId, connectionId: null }
        }),
      resolveWorktreeRootPath: async (selector) => {
        const idTarget = selector.startsWith('id:') ? selector.slice(3) : null
        if (idTarget !== null && [workspaceRoot, teammateRoot].includes(idTarget)) {
          return idTarget
        }
        throw new Error('unknown worktree')
      }
    },
    roots,
    onCloudDenial: (details, method) => {
      denials.push({ details, method })
      overrides.onCloudDenial?.(details, method)
    }
  })
  return { boundary, denials }
}

describe('multiplex 订阅帧的工作区边界（W9A-7）', () => {
  it('本人工作区的句柄放行，且不产生审计', async () => {
    const { boundary, denials } = boundaryWith({})
    await expect(boundary('term-own')).resolves.toEqual({ ok: true })
    expect(denials).toEqual([])
  })

  it('跨工作区句柄拒绝：流错误码 + PATH_OUTSIDE_ROOT 审计', async () => {
    const { boundary, denials } = boundaryWith({})
    await expect(boundary('term-teammate')).resolves.toEqual({
      ok: false,
      code: TERMINAL_MULTIPLEX_WORKSPACE_SCOPE_ERROR
    })
    expect(denials).toEqual([
      {
        details: { denial: 'PATH_OUTSIDE_ROOT', reason: 'workspace_scope' },
        method: 'terminal.multiplex'
      }
    ])
  })

  it('客户端作用域复合句柄先归一化（term:c1 寻址 term），与一元边界同一输入规整', async () => {
    const { boundary, denials } = boundaryWith({})
    await expect(boundary('term-own:client-1')).resolves.toEqual({ ok: true })
    await expect(boundary('term-teammate:client-1')).resolves.toMatchObject({ ok: false })
    expect(denials).toEqual([
      {
        details: { denial: 'PATH_OUTSIDE_ROOT', reason: 'workspace_scope' },
        method: 'terminal.multiplex'
      }
    ])
  })

  it('已退出（未知）句柄 fail-closed，审计 reason 指向句柄不可归属', async () => {
    const { boundary, denials } = boundaryWith({})
    await expect(boundary('term-exited')).resolves.toMatchObject({ ok: false })
    expect(denials[0]?.details).toMatchObject({
      denial: 'PATH_OUTSIDE_ROOT',
      reason: 'terminal_unknown'
    })
  })

  it('宿主无法回答句柄归属时不放行（诚实不可验证 = 拒绝）', async () => {
    const { boundary, denials } = boundaryWith({ resolveTerminalContext: () => null })
    await expect(boundary('term-own')).resolves.toMatchObject({ ok: false })
    expect(denials).toHaveLength(1)
  })

  it('宿主无法解析句柄工作区路径时不放行', async () => {
    const boundary = createCloudMultiplexStreamBoundary({
      runtime: {
        resolveTerminalContext: () => ({ worktreeId: 'wt_missing', connectionId: null }),
        resolveWorktreeRootPath: async () => {
          throw new Error('selector_not_found')
        }
      },
      roots
    })
    await expect(boundary('term-own')).resolves.toMatchObject({
      ok: false,
      code: TERMINAL_MULTIPLEX_WORKSPACE_SCOPE_ERROR
    })
  })
})
