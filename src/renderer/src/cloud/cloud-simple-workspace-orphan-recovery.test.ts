// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-mobile-session-tab-contracts'
import {
  buildSimpleOrphanAdoptParams,
  buildSimpleOrphanListParams,
  collectSimpleWorkspaceOrphanCandidates,
  readSimpleOrphanInventory,
  recoverSimpleWorkspaceTerminalOrphans
} from './cloud-simple-workspace-orphan-recovery'

/** U96 B-令7: pending handle-less rows reclaim a live PTY through adoptOrphans. */

const WORKSPACE = '/srv/checkout'
const WORKTREE = `path:${WORKSPACE}`

function pendingRow(tabId: string, leafId: string, ptyId: string | null): RuntimeMobileSessionTerminalClientTab {
  return {
    type: 'terminal',
    id: `${tabId}::${leafId}`,
    title: 'zsh',
    parentTabId: tabId,
    leafId,
    ptyId,
    isActive: false,
    parentLayout: { root: null, activeLeafId: leafId, expandedLeafId: null },
    status: 'pending-handle',
    terminal: null
  }
}

function readyRow(tabId: string, leafId: string): RuntimeMobileSessionTerminalClientTab {
  return {
    ...pendingRow(tabId, leafId, `pty-${leafId}`),
    status: 'ready',
    terminal: `handle-${leafId}`
  }
}

function orphanListing(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminals: [
      {
        handle: 'handle-orphan',
        ptyId: 'pty-leaf-1',
        incarnationId: 'inc-1',
        orphaned: true,
        worktreePath: WORKSPACE,
        ...patch
      }
    ],
    topologyRevisions: { [WORKTREE]: 7 },
    totalCount: 1,
    truncated: false
  }
}

function frame(tabs: RuntimeMobileSessionClientTab[]): { tabs: RuntimeMobileSessionClientTab[] } {
  return { tabs }
}

describe('collectSimpleWorkspaceOrphanCandidates', () => {
  it('只收 pending-handle 且仍带 ptyId 的行，每个宿主标签一份', () => {
    const candidates = collectSimpleWorkspaceOrphanCandidates(
      frame([
        pendingRow('tab-a', 'leaf-1', 'pty-leaf-1'),
        pendingRow('tab-a', 'leaf-2', 'pty-leaf-2'),
        pendingRow('tab-b', 'leaf-3', null),
        readyRow('tab-c', 'leaf-4')
      ])
    )
    expect(candidates).toEqual([
      { tabId: 'tab-a', leafId: 'leaf-1', ptyId: 'pty-leaf-1', title: 'zsh' }
    ])
  })

  it('全部 ready：零候选，恢复流程不发任何 RPC', async () => {
    const rpc = vi.fn<CloudRpc>()
    expect(
      await recoverSimpleWorkspaceTerminalOrphans({
        rpc,
        workspacePath: WORKSPACE,
        frame: frame([readyRow('tab-c', 'leaf-4')]),
        isCurrent: () => true
      })
    ).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('readSimpleOrphanInventory', () => {
  const candidates = [
    { tabId: 'tab-a', leafId: 'leaf-1', ptyId: 'pty-leaf-1', title: 'zsh' }
  ]
  const scope = { worktree: WORKTREE, workspacePath: WORKSPACE }

  it('ptyId 匹配且宿主自证 orphaned：产出一条带 incarnation 的 claim', () => {
    expect(readSimpleOrphanInventory(candidates, orphanListing(), scope)).toEqual({
      claims: [
        {
          terminal: 'handle-orphan',
          ptyId: 'pty-leaf-1',
          incarnationId: 'inc-1',
          tabId: 'tab-a',
          leafId: 'leaf-1'
        }
      ],
      topologyRevision: 7
    })
  })

  it('非 orphaned / 缺 incarnation / 别的 worktree：不 claim', () => {
    for (const patch of [
      { orphaned: false },
      { incarnationId: null },
      { worktreePath: '/srv/other' }
    ]) {
      expect(readSimpleOrphanInventory(candidates, orphanListing(patch), scope)?.claims).toEqual(
        []
      )
    }
  })

  it('同一 ptyId 在清单里重复：不猜归属', () => {
    const listed = {
      ...orphanListing(),
      terminals: [
        {
          handle: 'handle-orphan',
          ptyId: 'pty-leaf-1',
          incarnationId: 'inc-1',
          orphaned: true,
          worktreePath: WORKSPACE
        },
        {
          handle: 'handle-second',
          ptyId: 'pty-leaf-1',
          incarnationId: 'inc-1',
          orphaned: true,
          worktreePath: WORKSPACE
        }
      ]
    }
    expect(readSimpleOrphanInventory(candidates, listed, scope)?.claims).toEqual([])
  })
})

describe('recoverSimpleWorkspaceTerminalOrphans', () => {
  function scripted(outcomes: Record<string, CloudRpcOutcome>): {
    rpc: CloudRpc
    calls: { method: string; params?: Record<string, unknown> }[]
  } {
    const calls: { method: string; params?: Record<string, unknown> }[] = []
    const rpc: CloudRpc = async (method, params) => {
      calls.push({ method, params })
      return outcomes[method] ?? { ok: true, result: {} }
    }
    return { rpc, calls }
  }

  it('list → adopt：claims 按 worktree 发出，返回 adopt 的 snapshot 供投影', async () => {
    const adoptedSnapshot = { worktree: WORKTREE, tabs: [readyRow('tab-a', 'leaf-1')] }
    const { rpc, calls } = scripted({
      'terminal.list': { ok: true, result: orphanListing() },
      'terminal.adoptOrphans': {
        ok: true,
        result: { adopted: true, topologyRevision: 8, snapshot: adoptedSnapshot }
      }
    })

    const recovered = await recoverSimpleWorkspaceTerminalOrphans({
      rpc,
      workspacePath: WORKSPACE,
      frame: frame([pendingRow('tab-a', 'leaf-1', 'pty-leaf-1')]),
      isCurrent: () => true
    })

    expect(recovered).toEqual(adoptedSnapshot)
    expect(calls[0]).toEqual({
      method: 'terminal.list',
      params: buildSimpleOrphanListParams(WORKTREE)
    })
    expect(calls[1]).toEqual({
      method: 'terminal.adoptOrphans',
      params: buildSimpleOrphanAdoptParams(WORKTREE, {
        claims: [
          {
            terminal: 'handle-orphan',
            ptyId: 'pty-leaf-1',
            incarnationId: 'inc-1',
            tabId: 'tab-a',
            leafId: 'leaf-1'
          }
        ],
        topologyRevision: 7
      })
    })
  })

  it('list 失败：零 adopt、不抛错（一次性降级）', async () => {
    const { rpc, calls } = scripted({ 'terminal.list': { ok: false, code: 'timeout' } })
    expect(
      await recoverSimpleWorkspaceTerminalOrphans({
        rpc,
        workspacePath: WORKSPACE,
        frame: frame([pendingRow('tab-a', 'leaf-1', 'pty-leaf-1')]),
        isCurrent: () => true
      })
    ).toBeNull()
    expect(calls.map((call) => call.method)).toEqual(['terminal.list'])
  })

  it('无匹配孤儿：不做 adopt', async () => {
    const { rpc, calls } = scripted({
      'terminal.list': { ok: true, result: orphanListing({ orphaned: false }) }
    })
    expect(
      await recoverSimpleWorkspaceTerminalOrphans({
        rpc,
        workspacePath: WORKSPACE,
        frame: frame([pendingRow('tab-a', 'leaf-1', 'pty-leaf-1')]),
        isCurrent: () => true
      })
    ).toBeNull()
    expect(calls.map((call) => call.method)).toEqual(['terminal.list'])
  })

  it('adopt 失败：返回 null，不伪造快照', async () => {
    const { rpc } = scripted({
      'terminal.list': { ok: true, result: orphanListing() },
      'terminal.adoptOrphans': { ok: false, code: 'scope_mismatch' }
    })
    expect(
      await recoverSimpleWorkspaceTerminalOrphans({
        rpc,
        workspacePath: WORKSPACE,
        frame: frame([pendingRow('tab-a', 'leaf-1', 'pty-leaf-1')]),
        isCurrent: () => true
      })
    ).toBeNull()
  })

  it('apply 已取消：adopt 的结果不再回溯', async () => {
    let current = true
    const { rpc } = scripted({
      'terminal.list': { ok: true, result: orphanListing() },
      'terminal.adoptOrphans': {
        ok: true,
        result: { adopted: true, topologyRevision: 8, snapshot: { tabs: [] } }
      }
    })
    expect(
      await recoverSimpleWorkspaceTerminalOrphans({
        rpc,
        workspacePath: WORKSPACE,
        frame: frame([pendingRow('tab-a', 'leaf-1', 'pty-leaf-1')]),
        isCurrent: () => {
          const answer = current
          current = false
          return answer
        }
      })
    ).toBeNull()
  })
})
