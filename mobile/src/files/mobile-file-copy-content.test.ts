import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { FileActionTarget } from './mobile-file-actions'
import { loadMobileFilePreview } from './mobile-file-preview-request'

vi.mock('./mobile-file-preview-request', () => ({
  loadMobileFilePreview: vi.fn()
}))

import { COPY_CONTENT_MAX_BYTES, readFileContentForCopy } from './mobile-file-copy-content'

function ok(result: unknown): RpcResponse {
  return { id: 'response-id', ok: true, result, _meta: { runtimeId: 'runtime-id' } }
}

const WORKTREE_TARGET: FileActionTarget = {
  source: 'worktree',
  hostId: 'host-1',
  worktreeId: 'wt-1',
  relativePath: 'notes.txt',
  name: 'notes.txt',
  kind: 'text',
  previewable: true
}

const TERMINAL_TARGET: FileActionTarget = {
  source: 'terminalArtifact',
  hostId: 'host-1',
  worktreeId: 'wt-1',
  absolutePath: '/tmp/result.txt',
  grantId: 'grant-1',
  pathText: '~/result.txt',
  displayPath: '/tmp/result.txt',
  name: 'result.txt',
  kind: 'text'
}

function client(result: unknown) {
  return { sendRequest: vi.fn(async () => ok(result)) }
}

afterEach(() => {
  vi.mocked(loadMobileFilePreview).mockReset()
})

describe('readFileContentForCopy', () => {
  it('reports the host truncation for a worktree file', async () => {
    const copied = await readFileContentForCopy(
      client({ content: 'first', truncated: true, byteLength: 600_000 }),
      WORKTREE_TARGET
    )

    expect(copied).toEqual({ content: 'first', truncated: true, byteLength: 600_000 })
  })

  it('truncates client-side when a host sends an oversized payload without the flag', async () => {
    const content = 'é'.repeat(COPY_CONTENT_MAX_BYTES / 2 + 10)
    const copied = await readFileContentForCopy(
      client({ content, truncated: false }),
      WORKTREE_TARGET
    )

    expect(copied.truncated).toBe(true)
    expect(Buffer.byteLength(copied.content, 'utf8')).toBeLessThanOrEqual(COPY_CONTENT_MAX_BYTES)
    expect(content.startsWith(copied.content)).toBe(true)
  })

  it('does not split a multi-byte character that straddles the cut', async () => {
    // Only one byte of headroom is left when the three-byte character starts, so it must be
    // dropped whole rather than decoded into a replacement character.
    const prefix = 'a'.repeat(COPY_CONTENT_MAX_BYTES - 1)
    const content = `${prefix}€tail`
    const copied = await readFileContentForCopy(
      client({ content, truncated: false }),
      WORKTREE_TARGET
    )

    expect(copied.truncated).toBe(true)
    expect(copied.content).toBe(prefix)
    expect(copied.content).not.toContain(String.fromCharCode(0xfffd))
    expect(Buffer.byteLength(copied.content, 'utf8')).toBe(COPY_CONTENT_MAX_BYTES - 1)
  })

  it('copies CJK and emoji content unchanged below the cap', async () => {
    const content = '你好，世界 👋\n'
    const copied = await readFileContentForCopy(
      client({ content, truncated: false, byteLength: Buffer.byteLength(content, 'utf8') }),
      WORKTREE_TARGET
    )

    expect(copied).toEqual({
      content,
      truncated: false,
      byteLength: Buffer.byteLength(content, 'utf8')
    })
  })

  it('refreshes a terminal grant before copying and forwards the refreshed source', async () => {
    vi.mocked(loadMobileFilePreview).mockResolvedValue({
      status: 'ready',
      kind: 'text',
      content: 'terminal output',
      truncated: false,
      byteLength: 15
    })
    const refreshed = vi.fn()

    const copied = await readFileContentForCopy(client({}), TERMINAL_TARGET, {
      onTerminalArtifactSourceRefreshed: refreshed
    })

    expect(copied).toEqual({ content: 'terminal output', truncated: false, byteLength: 15 })
    expect(loadMobileFilePreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: 'terminalArtifact', grantId: 'grant-1' }),
      undefined,
      { refreshGrant: true, onTerminalArtifactSourceRefreshed: refreshed }
    )
  })

  it('refuses terminal text above 512 KB instead of pretending to truncate it', async () => {
    vi.mocked(loadMobileFilePreview).mockResolvedValue({
      status: 'ready',
      kind: 'text',
      content: 'x'.repeat(COPY_CONTENT_MAX_BYTES + 1),
      truncated: false,
      byteLength: COPY_CONTENT_MAX_BYTES + 1
    })

    await expect(readFileContentForCopy(client({}), TERMINAL_TARGET)).rejects.toMatchObject({
      code: 'too_large'
    })
  })
})
