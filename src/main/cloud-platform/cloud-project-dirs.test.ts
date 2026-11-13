import { describe, expect, it } from 'vitest'
import { listProjectDirs, PROJECT_DIR_LIMIT } from './cloud-project-dirs'
import { cloudHeartbeatBody } from './cloud-heartbeat-body'

/** FR-3.7: the host reports its pickable directories on every beat. */

function fakeReaddir(entries: string[], opts?: { throwOnCall?: boolean }) {
  return (
    path: string,
    options: { withFileTypes: true }
  ): { name: string; isDirectory(): boolean }[] => {
    if (!path || !options.withFileTypes) {
      throw new Error('unexpected readdir arguments')
    }
    if (opts?.throwOnCall) {
      throw new Error('EACCES')
    }
    return entries.map((name) => ({
      name,
      isDirectory: () => !name.startsWith('file-')
    }))
  }
}

describe('宿主项目目录清单', () => {
  it('仅取一级目录名并排序，文件不入选', () => {
    const dirs = listProjectDirs(
      '/srv/projects',
      fakeReaddir(['risk-report', 'payment-service', 'file-notes.md', '.hidden'])
    )
    expect(dirs).toEqual(['.hidden', 'payment-service', 'risk-report'])
  })

  it('上限 200 条', () => {
    const many = Array.from(
      { length: PROJECT_DIR_LIMIT + 50 },
      (_, index) => `dir-${String(index).padStart(3, '0')}`
    )
    const dirs = listProjectDirs('/srv/projects', fakeReaddir(many))
    expect(dirs).toHaveLength(PROJECT_DIR_LIMIT)
    expect(dirs[0]).toBe('dir-000')
  })

  it('目录不存在或不可读时为空数组，不抛错', () => {
    expect(listProjectDirs('/srv/missing', fakeReaddir([], { throwOnCall: true }))).toEqual([])
    expect(listProjectDirs('/srv/projects', fakeReaddir([], { throwOnCall: true }))).toEqual([])
  })

  it('未配置根目录时不读盘，心跳体省略字段', () => {
    expect(listProjectDirs(undefined, fakeReaddir(['x']))).toEqual([])
    expect(listProjectDirs('   ', fakeReaddir(['x']))).toEqual([])
    expect(
      cloudHeartbeatBody({ projectsRoot: '/srv/projects' }, [], []).projectDirs
    ).toBeUndefined()
  })

  it('心跳体携带目录清单，配置了根目录时空清单也上报', () => {
    const configured = (): string[] => ['payment-service', 'risk-report']
    expect(cloudHeartbeatBody({ projectDirs: configured }, [], []).projectDirs).toEqual([
      'payment-service',
      'risk-report'
    ])
    expect(cloudHeartbeatBody({ projectDirs: [] }, [], []).projectDirs).toEqual([])
  })
})
