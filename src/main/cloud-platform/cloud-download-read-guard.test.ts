import { describe, expect, it } from 'vitest'
import { createCloudDownloadReadGuard } from './cloud-download-read-guard'

/**
 * U66 phase 2 (OQ-6): the readChunk download-equivalence rule — a window that
 * completes a multi-window contiguous rebuild is a download; single-window and
 * out-of-order reads stay open (the declared residual gap).
 */

const base = {
  projectId: 'proj-1',
  deviceId: 'dev-1',
  worktree: '/srv/work/repo',
  relativePath: 'big.bin'
}

describe('cloud-download-read-guard（readChunk 下载等价硬拦）', () => {
  it('首个窗口即使整文件也不拦（声明残余缺口：单窗口读取不拦）', () => {
    const guard = createCloudDownloadReadGuard()
    expect(guard.check({ ...base, offset: 0, length: 4096, fileSize: 4096 })).toBe('allow')
  })

  it('多窗口重建：非完成窗口放行，完成窗口拒绝', () => {
    const guard = createCloudDownloadReadGuard()
    expect(guard.check({ ...base, offset: 0, length: 1024, fileSize: 4096 })).toBe('allow')
    expect(guard.check({ ...base, offset: 1024, length: 1024, fileSize: 4096 })).toBe('allow')
    expect(guard.check({ ...base, offset: 2048, length: 1024, fileSize: 4096 })).toBe('allow')
    // The completing window: bytes never move, the refusal is the audit event.
    expect(guard.check({ ...base, offset: 3072, length: 1024, fileSize: 4096 })).toBe('deny')
    // Deterministic on retry.
    expect(guard.check({ ...base, offset: 3072, length: 1024, fileSize: 4096 })).toBe('deny')
  })

  it('跳过窗口（乱序读）不累计覆盖，完成也不拦（声明残余缺口）', () => {
    const guard = createCloudDownloadReadGuard()
    expect(guard.check({ ...base, offset: 0, length: 1024, fileSize: 4096 })).toBe('allow')
    // offset beyond the covered edge: a searcher's window, not a rebuild step.
    expect(guard.check({ ...base, offset: 3072, length: 1024, fileSize: 4096 })).toBe('allow')
  })

  it('覆盖键按会话/工作树/文件隔离', () => {
    const guard = createCloudDownloadReadGuard()
    expect(guard.check({ ...base, offset: 0, length: 1024, fileSize: 4096 })).toBe('allow')
    // Another session's rebuild starts from scratch.
    expect(
      guard.check({ ...base, deviceId: 'dev-2', offset: 3072, length: 1024, fileSize: 4096 })
    ).toBe('allow')
    // Another file in the same session likewise.
    expect(
      guard.check({
        ...base,
        relativePath: 'other.bin',
        offset: 3072,
        length: 1024,
        fileSize: 4096
      })
    ).toBe('allow')
  })

  it('TTL 过期后覆盖重置；追踪表有界', () => {
    let clock = 0
    const guard = createCloudDownloadReadGuard(() => clock)
    expect(guard.check({ ...base, offset: 0, length: 1024, fileSize: 4096 })).toBe('allow')
    clock = 10 * 60_000 + 1
    // Coverage expired: the completing window is now a fresh first window.
    expect(guard.check({ ...base, offset: 3072, length: 1024, fileSize: 4096 })).toBe('allow')
    // Bounded: distinct files beyond the cap evict instead of growing.
    for (let index = 0; index < 300; index += 1) {
      guard.check({
        ...base,
        relativePath: `f${index}.bin`,
        offset: 0,
        length: 1024,
        fileSize: 4096
      })
    }
    expect(
      guard.check({ ...base, relativePath: 'f999.bin', offset: 0, length: 1, fileSize: 4096 })
    ).toBe('allow')
  })

  it('非法参数放行（由读取路径自己的校验回答）', () => {
    const guard = createCloudDownloadReadGuard()
    expect(guard.check({ ...base, offset: -1, length: 10, fileSize: 4096 })).toBe('allow')
    expect(guard.check({ ...base, offset: 0, length: 0, fileSize: 4096 })).toBe('allow')
    expect(guard.check({ ...base, offset: 0, length: 10, fileSize: 0 })).toBe('allow')
  })
})
